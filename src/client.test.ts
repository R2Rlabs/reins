import { beforeEach, describe, expect, it } from "vitest";
import {
  HyperliquidApiError,
  HyperliquidClient,
  ReadOnlyClientError,
} from "./client.js";
import { MockTransport } from "./mock-transport.js";
import { StubSigner } from "./signer.js";
import type { ClearinghouseState, Meta, OrderAction } from "./types.js";

const META: Meta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
  ],
};

const STATE: ClearinghouseState = {
  assetPositions: [
    {
      position: {
        coin: "ETH",
        szi: "-0.0335",
        entryPx: "2986.3",
        positionValue: "100.02765",
        unrealizedPnl: "-0.0134",
        marginUsed: "4.967826",
      },
    },
    {
      position: {
        coin: "BTC",
        szi: "0.25",
        entryPx: "50000",
        positionValue: "12500",
        unrealizedPnl: "35.5",
        marginUsed: "2500",
      },
    },
  ],
  marginSummary: {
    accountValue: "13109.482328",
    totalMarginUsed: "2504.967826",
    totalNtlPos: "12600.02765",
    totalRawUsd: "13009.454678",
  },
  withdrawable: "13104.514502",
};

const RESTING = {
  status: "ok",
  response: { type: "order", data: { statuses: [{ resting: { oid: 77738308 } }] } },
};

const FILLED = {
  status: "ok",
  response: {
    type: "order",
    data: { statuses: [{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77747314 } }] },
  },
};

let transport: MockTransport;
let signer: StubSigner;

beforeEach(() => {
  transport = new MockTransport().reply("info:meta", META);
  signer = new StubSigner();
});

function client(overrides: Partial<ConstructorParameters<typeof HyperliquidClient>[0]> = {}) {
  return new HyperliquidClient({
    network: "testnet",
    fetch: transport.fetch,
    signer,
    ...overrides,
  });
}

function lastOrderAction(): OrderAction {
  const call = transport.callsTo("exchange:order").at(-1);
  if (!call) throw new Error("No order was sent.");
  return call.body["action"] as OrderAction;
}

describe("read-only mode", () => {
  it("reports itself read-only without a signer", () => {
    const c = new HyperliquidClient({ fetch: transport.fetch });
    expect(c.isReadOnly).toBe(true);
  });

  it("still serves market data", async () => {
    const c = new HyperliquidClient({ fetch: transport.fetch });
    await expect(c.assetInfo("BTC")).resolves.toMatchObject({ index: 0, szDecimals: 5 });
  });

  it("refuses to place an order", async () => {
    const c = new HyperliquidClient({ fetch: transport.fetch });
    await expect(
      c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 }),
    ).rejects.toBeInstanceOf(ReadOnlyClientError);
  });
});

describe("order construction", () => {
  it("builds the wire order the docs describe", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    expect(lastOrderAction()).toEqual({
      type: "order",
      grouping: "na",
      orders: [
        { a: 0, b: true, p: "50000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } },
      ],
    });
  });

  it("resolves the asset index from the universe", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "ETH", side: "sell", size: 1, price: 2986.34 });

    const order = lastOrderAction().orders[0];
    expect(order).toMatchObject({ a: 1, b: false, p: "2986.3" });
  });

  it("passes reduceOnly, tif and cloid through", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({
      symbol: "BTC",
      side: "sell",
      size: 0.1,
      price: 50_000,
      reduceOnly: true,
      tif: "Ioc",
      cloid: "0x1234",
    });

    expect(lastOrderAction().orders[0]).toMatchObject({
      r: true,
      t: { limit: { tif: "Ioc" } },
      c: "0x1234",
    });
  });

  it("omits cloid when none was given", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    expect(lastOrderAction().orders[0]).not.toHaveProperty("c");
  });

  it("rejects an unknown symbol before sending anything", async () => {
    await expect(
      client().placeOrder({ symbol: "DOGE", side: "buy", size: 1, price: 0.1 }),
    ).rejects.toThrow(/Unknown symbol "DOGE"/);
    expect(transport.callsTo("exchange:order")).toHaveLength(0);
  });
});

describe("builder code", () => {
  it("attaches the builder fee to every order", async () => {
    transport.reply("exchange:order", RESTING);
    const c = client({
      builder: { address: "0xAbCdEf0000000000000000000000000000000001", feeTenthsBps: 10 },
    });
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    expect(lastOrderAction().builder).toEqual({
      b: "0xabcdef0000000000000000000000000000000001",
      f: 10,
    });
  });

  it("omits the builder key when none is configured", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    expect(lastOrderAction()).not.toHaveProperty("builder");
  });

  it("refuses a fee above the 0.1% perps cap", () => {
    expect(() =>
      client({ builder: { address: "0x01", feeTenthsBps: 101 } }),
    ).toThrow(/exceeds the perps cap/);
  });

  it("accepts a fee exactly at the cap", () => {
    expect(() => client({ builder: { address: "0x01", feeTenthsBps: 100 } })).not.toThrow();
  });

  it("refuses a non-integer fee", () => {
    expect(() => client({ builder: { address: "0x01", feeTenthsBps: 1.5 } })).toThrow(
      RangeError,
    );
  });
});

describe("order outcomes", () => {
  it("reads a resting order", async () => {
    transport.reply("exchange:order", RESTING);
    const outcome = await client().placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      price: 50_000,
    });
    expect(outcome).toEqual({ kind: "resting", oid: 77738308 });
  });

  it("reads a filled order", async () => {
    transport.reply("exchange:order", FILLED);
    const outcome = await client().placeOrder({
      symbol: "ETH",
      side: "buy",
      size: 0.02,
      price: 1891.4,
    });
    expect(outcome).toEqual({
      kind: "filled",
      oid: 77747314,
      totalSize: "0.02",
      avgPrice: "1891.4",
    });
  });

  it("returns a rejection rather than throwing when the exchange refuses one order", async () => {
    transport.reply("exchange:order", {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ error: "Order must have minimum value of $10." }] },
      },
    });
    const outcome = await client().placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.00001,
      price: 50_000,
    });
    expect(outcome).toEqual({
      kind: "rejected",
      message: "Order must have minimum value of $10.",
    });
  });

  it("surfaces a top-level error response", async () => {
    transport.reply("exchange:order", { status: "err", response: "Invalid nonce." });
    const outcome = await client().placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      price: 50_000,
    });
    expect(outcome).toEqual({ kind: "rejected", message: "Invalid nonce." });
  });
});

describe("cancel", () => {
  it("builds the cancel action and reads success", async () => {
    transport.reply("exchange:cancel", {
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] } },
    });
    const outcome = await client().cancelOrder("BTC", 77738308);

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(transport.callsTo("exchange:cancel")[0]?.body["action"]).toEqual({
      type: "cancel",
      cancels: [{ a: 0, o: 77738308 }],
    });
  });

  it("reads a cancel rejection", async () => {
    transport.reply("exchange:cancel", {
      status: "ok",
      response: {
        type: "cancel",
        data: { statuses: [{ error: "Order was never placed, already canceled, or filled." }] },
      },
    });
    const outcome = await client().cancelOrder("BTC", 1);
    expect(outcome).toMatchObject({ kind: "rejected" });
  });
});

describe("signing and nonces", () => {
  it("signs every exchange action with the testnet flag set", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    expect(signer.signed).toHaveLength(1);
    expect(signer.signed[0]).toMatchObject({ isTestnet: true, vaultAddress: null });
  });

  it("keeps nonces strictly increasing inside one millisecond", async () => {
    transport.reply("exchange:order", RESTING);
    const c = client({ now: () => 1_700_000_000_000 });
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    const nonces = signer.signed.map((s) => s.nonce);
    expect(nonces).toEqual([1_700_000_000_000, 1_700_000_000_001]);
  });
});

describe("account state", () => {
  it("caches the universe instead of refetching it", async () => {
    transport.reply("exchange:order", RESTING);
    const c = client();
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    await c.placeOrder({ symbol: "ETH", side: "buy", size: 1, price: 2986 });

    expect(transport.callsTo("info:meta")).toHaveLength(1);
  });

  it("refetches after the cache is cleared", async () => {
    const c = client();
    await c.assetInfo("BTC");
    c.clearMetaCache();
    await c.assetInfo("BTC");
    expect(transport.callsTo("info:meta")).toHaveLength(2);
  });

  it("takes position direction from szi, not positionValue", async () => {
    transport.reply("info:clearinghouseState", STATE);
    const snapshot = await client().positionSnapshot();

    expect(snapshot.positionsUsd["ETH"]).toBeCloseTo(-100.02765, 5);
    expect(snapshot.positionsUsd["BTC"]).toBeCloseTo(12_500, 5);
    expect(snapshot.accountValueUsd).toBeCloseTo(13_109.482328, 5);
  });

  it("lowercases the user address in the request", async () => {
    transport.reply("info:clearinghouseState", STATE);
    await client().clearinghouseState("0xAABBCC0000000000000000000000000000000001");

    expect(transport.callsTo("info:clearinghouseState")[0]?.body["user"]).toBe(
      "0xaabbcc0000000000000000000000000000000001",
    );
  });
});

describe("transport errors", () => {
  it("wraps a non-2xx response", async () => {
    transport.failWith(503, "upstream unavailable");
    await expect(client().assetInfo("BTC")).rejects.toBeInstanceOf(HyperliquidApiError);
  });

  it("wraps a non-JSON body", async () => {
    const bad = new MockTransport();
    bad.failWith(200, "<html>nope</html>");
    const c = new HyperliquidClient({ fetch: bad.fetch, signer });
    await expect(c.assetInfo("BTC")).rejects.toThrow(/non-JSON body/);
  });
});

describe("network selection", () => {
  it("defaults to testnet", async () => {
    await client().assetInfo("BTC");
    expect(transport.lastCall?.url).toBe("https://api.hyperliquid-testnet.xyz/info");
  });

  it("uses the mainnet host when asked", async () => {
    await client({ network: "mainnet" }).assetInfo("BTC");
    expect(transport.lastCall?.url).toBe("https://api.hyperliquid.xyz/info");
  });
});
