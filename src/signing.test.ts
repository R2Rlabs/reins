import { describe, expect, it } from "vitest";
import { HyperliquidClient } from "./client.js";
import { MockTransport } from "./mock-transport.js";
import { PrivateKeySigner } from "./private-key-signer.js";
import { actionHash, phantomAgent, splitSignature } from "./signing.js";

/**
 * Vectors copied from the Hyperliquid Python SDK's own `signing_test.py`
 * (`test_l1_action_signing_matches`). They are the reference implementation's
 * published output, so matching them exactly is what makes this port
 * trustworthy without a funded account to try it against.
 */
const REFERENCE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";

// float_to_int_for_hashing(1000) — the SDK scales by 1e8 for hashing.
const DUMMY_ACTION = { type: "dummy", num: 100_000_000_000 };

const MAINNET = {
  r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
  s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
  v: 27,
};

const TESTNET = {
  r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
  s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
  v: 28,
};

describe("reference vectors", () => {
  it("matches the Python SDK on mainnet", async () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const signature = await signer.signL1Action({
      action: DUMMY_ACTION,
      nonce: 0,
      vaultAddress: null,
      isTestnet: false,
    });
    expect(signature).toEqual(MAINNET);
  });

  it("matches the Python SDK on testnet", async () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const signature = await signer.signL1Action({
      action: DUMMY_ACTION,
      nonce: 0,
      vaultAddress: null,
      isTestnet: true,
    });
    expect(signature).toEqual(TESTNET);
  });

  // test_l1_action_signing_tpsl_order_matches: a stop-loss trigger order. The
  // trigger's keys go isMarket, triggerPx, tpsl; any other order is a
  // different hash, and this is what pins it.
  it("matches the Python SDK's stop-loss trigger order on both networks", async () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const action = {
      type: "order",
      orders: [
        {
          a: 1,
          b: true,
          p: "100",
          s: "100",
          r: false,
          t: { trigger: { isMarket: true, triggerPx: "103", tpsl: "sl" } },
        },
      ],
      grouping: "na",
    };
    const base = { action, nonce: 0, vaultAddress: null };
    expect(await signer.signL1Action({ ...base, isTestnet: false })).toEqual({
      r: "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9",
      s: "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405",
      v: 27,
    });
    expect(await signer.signL1Action({ ...base, isTestnet: true })).toEqual({
      r: "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4",
      s: "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac",
      v: 28,
    });
  });

  it("produces different signatures per network from the same action", async () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const base = { action: DUMMY_ACTION, nonce: 0, vaultAddress: null };
    const main = await signer.signL1Action({ ...base, isTestnet: false });
    const test = await signer.signL1Action({ ...base, isTestnet: true });
    expect(main.r).not.toBe(test.r);
  });
});

describe("actionHash", () => {
  it("is deterministic", () => {
    const a = actionHash(DUMMY_ACTION, 0, null);
    const b = actionHash(DUMMY_ACTION, 0, null);
    expect(a).toBe(b);
  });

  it("changes when the key order changes", () => {
    // The whole reason this file exists. msgpack preserves insertion order, so
    // two objects that are equal in JavaScript hash differently.
    const ordered = actionHash({ type: "dummy", num: 1 }, 0, null);
    const reordered = actionHash({ num: 1, type: "dummy" }, 0, null);
    expect(ordered).not.toBe(reordered);
  });

  it("changes with the nonce", () => {
    expect(actionHash(DUMMY_ACTION, 0, null)).not.toBe(
      actionHash(DUMMY_ACTION, 1, null),
    );
  });

  it("changes when a vault address is present", () => {
    const withoutVault = actionHash(DUMMY_ACTION, 0, null);
    const withVault = actionHash(
      DUMMY_ACTION,
      0,
      "0x1234567890123456789012345678901234567890",
    );
    expect(withoutVault).not.toBe(withVault);
  });

  it("changes with expiresAfter", () => {
    expect(actionHash(DUMMY_ACTION, 0, null)).not.toBe(
      actionHash(DUMMY_ACTION, 0, null, 1_700_000_000_000),
    );
  });

  it("returns a 32-byte hash", () => {
    expect(actionHash(DUMMY_ACTION, 0, null)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("phantomAgent", () => {
  it("uses source 'a' for mainnet and 'b' for testnet", () => {
    const hash = actionHash(DUMMY_ACTION, 0, null);
    expect(phantomAgent(hash, true).source).toBe("a");
    expect(phantomAgent(hash, false).source).toBe("b");
  });
});

describe("splitSignature", () => {
  it("strips leading zeroes the way the reference does", () => {
    const sig = `0x${"00ab".padEnd(64, "0")}${"cd".padEnd(64, "0")}1b` as `0x${string}`;
    const { r } = splitSignature(sig);
    expect(r.startsWith("0xab")).toBe(true);
  });

  it("normalises a parity byte to 27 or 28", () => {
    const sig = `0x${"11".repeat(32)}${"22".repeat(32)}00` as `0x${string}`;
    expect(splitSignature(sig).v).toBe(27);
  });

  it("rejects a signature of the wrong length", () => {
    expect(() => splitSignature("0xdeadbeef")).toThrow(/65-byte/);
  });
});

describe("signing a real order through the client", () => {
  it("signs the order action the client actually builds", async () => {
    const transport = new MockTransport()
      .reply("info:meta", { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }] })
      .reply("exchange:order", {
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 1 } }] } },
      });

    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const client = new HyperliquidClient({
      network: "testnet",
      fetch: transport.fetch,
      signer,
      builder: { address: "0x000000000000000000000000000000000000dead", feeTenthsBps: 10 },
    });

    await client.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    const call = transport.callsTo("exchange:order")[0]!;
    const signature = call.body["signature"] as Record<string, unknown>;
    expect(signature["r"]).toMatch(/^0x[0-9a-f]+$/);
    expect(signature["s"]).toMatch(/^0x[0-9a-f]+$/);
    expect([27, 28]).toContain(signature["v"]);
  });

  it("signs the same action identically twice at the same nonce", async () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const action = {
      type: "order",
      orders: [
        { a: 0, b: true, p: "50000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } },
      ],
      grouping: "na",
      builder: { b: "0x000000000000000000000000000000000000dead", f: 10 },
    };
    const input = { action, nonce: 1_700_000_000_000, vaultAddress: null, isTestnet: true };

    expect(await signer.signL1Action(input)).toEqual(await signer.signL1Action(input));
  });
});

describe("PrivateKeySigner", () => {
  it("derives the lowercased address", () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    expect(signer.address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("accepts a key without the 0x prefix", () => {
    const bare = new PrivateKeySigner(REFERENCE_KEY.slice(2));
    const prefixed = new PrivateKeySigner(REFERENCE_KEY);
    expect(bare.address).toBe(prefixed.address);
  });

  it("rejects a malformed key without echoing it", () => {
    expect(() => new PrivateKeySigner("not-a-key")).toThrow(/32 bytes of hex/);
    expect(() => new PrivateKeySigner("not-a-key")).not.toThrow(/not-a-key/);
  });

  it("keeps key material out of anything that stringifies it", () => {
    const signer = new PrivateKeySigner(REFERENCE_KEY);
    const serialised = JSON.stringify(signer);
    expect(serialised).not.toContain(REFERENCE_KEY.slice(2, 20));
    expect(JSON.parse(serialised)).toEqual({ address: signer.address });
  });
});
