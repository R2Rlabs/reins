import { describe, expect, it } from "vitest";
import {
  parseLiveCheckArgs,
  runLiveCheck,
  type LiveCheckClient,
  type LiveCheckDeps,
  type StepResult,
} from "./live-check.js";
import type { OrderOutcome, StopLoss } from "./types.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const BUILDER = "0x658DC3a1fc753262c83c7345032E6DB7Aa8fA997";

/** A cooperative exchange, with the knobs a test needs to make it uncooperative. */
function fakeExchange(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  let nextOid = 100;
  let position = 0;
  let stops: StopLoss[] = [];
  const state = {
    equity: 500,
    approvedTenths: 20,
    restingOutcome: undefined as OrderOutcome | undefined,
    fillSize: undefined as number | undefined,
    cancelFails: false,
    equityDriftWhileOpen: 0,
    ...overrides,
  } as {
    equity: number;
    approvedTenths: number;
    restingOutcome?: OrderOutcome;
    fillSize?: number;
    cancelFails: boolean;
    equityDriftWhileOpen: number;
  };

  const client: LiveCheckClient = {
    accountAddress: ACCOUNT,
    isReadOnly: false,
    assetInfo: async (symbol) => ({ name: symbol, szDecimals: 5, index: 0 }),
    accountState: async () => ({
      accountValueUsd: state.equity + (position > 0 ? state.equityDriftWhileOpen : 0),
      realizedPnlTodayUsd: 0,
      positionsUsd: position > 0 ? { BTC: position * 81_000 } : {},
    }),
    openPositions: async () => (position > 0 ? { BTC: { size: position, entryPrice: 81_000 } } : {}),
    l2Book: async () => ({ levels: [[{ px: "81000" }], [{ px: "81001" }]] }),
    stopLosses: async () => [...stops],
    maxBuilderFee: async () => state.approvedTenths,
    placeOrder: async (params) => {
      calls.push(`place:${params.side}:${params.tif}${params.stopLoss ? ":stop" : ""}`);
      if (params.tif === "Alo") {
        return state.restingOutcome ?? { kind: "resting", oid: nextOid++ };
      }
      const size = state.fillSize ?? params.size;
      position = params.reduceOnly ? Math.max(0, position - size) : position + size;
      return { kind: "filled", oid: nextOid++, totalSize: String(size), avgPrice: String(params.price) };
    },
    placeStopLoss: async (params) => {
      calls.push("stop");
      const oid = nextOid++;
      stops.push({ oid, symbol: params.symbol, side: params.side, size: params.size, triggerPrice: params.triggerPrice });
      return { kind: "resting", oid };
    },
    cancelOrder: async (_symbol, oid) => {
      calls.push(`cancel:${oid}`);
      if (state.cancelFails) return { kind: "rejected", message: "Order was never placed." };
      stops = stops.filter((s) => s.oid !== oid);
      return { kind: "cancelled" };
    },
  };
  return { client, calls, state, stopsLeft: () => stops, position: () => position };
}

function deps(client: LiveCheckClient) {
  const out: string[] = [];
  const d: LiveCheckDeps = { client, out: (line) => out.push(line), builderAddress: BUILDER };
  return { d, out: () => out.join("") };
}

const named = (results: StepResult[]) => results.map((r) => `${r.ok ? "✓" : "✗"} ${r.name}`);

describe("parseLiveCheckArgs", () => {
  it("reads only by default, on mainnet", () => {
    expect(parseLiveCheckArgs([])).toMatchObject({ trade: false, sizeUsd: 12, symbol: "BTC", network: "mainnet" });
  });

  it("keeps the test position small", () => {
    expect(() => parseLiveCheckArgs(["--size-usd", "5"])).toThrow(/between 10 and 100/);
    expect(() => parseLiveCheckArgs(["--size-usd", "5000"])).toThrow(/between 10 and 100/);
    expect(parseLiveCheckArgs(["--size-usd", "50"]).sizeUsd).toBe(50);
  });

  it("takes a symbol in any case, and refuses an unknown network", () => {
    expect(parseLiveCheckArgs(["--symbol", "eth"]).symbol).toBe("ETH");
    expect(() => parseLiveCheckArgs(["--network", "devnet"])).toThrow(/mainnet/);
  });
});

describe("reading the account", () => {
  it("passes the read-only checks without touching the exchange", async () => {
    const { client, calls } = fakeExchange();
    const { d, out } = deps(client);
    const results = await runLiveCheck([], d);

    expect(named(results)).toEqual(["✓ account", "✓ market data", "✓ open orders", "✓ builder fee"]);
    expect(calls).toEqual([]); // nothing placed or cancelled
    expect(out()).toContain("All 4 checks passed.");
  });

  it("stops at an empty account rather than trying to trade it", async () => {
    const { client } = fakeExchange({ equity: 0 });
    const results = await runLiveCheck(["--trade"], deps(client).d);
    expect(named(results)).toEqual(["✗ account"]);
    expect(results[0]!.detail).toMatch(/Deposit to it first/);
  });

  it("catches a builder fee the account has not approved", async () => {
    const { client } = fakeExchange({ approvedTenths: 0 });
    const { d, out } = deps(client);
    const results = await runLiveCheck([], d);
    expect(results.at(-1)).toMatchObject({ name: "builder fee", ok: false });
    expect(out()).toMatch(/approved 0 bp.*reins approve-builder/s);
  });

  it("says so when there is no account address at all", async () => {
    const { client } = fakeExchange();
    const results = await runLiveCheck([], deps({ ...client, accountAddress: undefined }).d);
    expect(named(results)).toEqual(["✗ account"]);
  });
});

describe("the trading checks", () => {
  it("walks the whole path and leaves nothing open", async () => {
    const { client, calls, stopsLeft, position } = fakeExchange();
    const { d, out } = deps(client);
    const results = await runLiveCheck(["--trade"], d);

    expect(named(results)).toEqual([
      "✓ account",
      "✓ market data",
      "✓ open orders",
      "✓ builder fee",
      "✓ resting order with a stop attached",
      "✓ cancel",
      "✓ market entry",
      "✓ account value with a position open",
      "✓ stop-loss on the position",
      "✓ move the stop",
      "✓ close the position",
      "✓ clean up",
    ]);
    // The resting order carried a stop; the entry did not need one here.
    expect(calls).toContain("place:buy:Alo:stop");
    expect(calls).toContain("place:buy:Ioc");
    expect(position()).toBe(0);
    expect(stopsLeft()).toEqual([]);
    expect(out()).toContain("All 12 checks passed.");
  });

  it("fails loudly when a post-only order is refused instead of resting", async () => {
    const { client } = fakeExchange({
      restingOutcome: { kind: "rejected", message: "Post only order would have immediately matched." },
    });
    const results = await runLiveCheck(["--trade"], deps(client).d);
    const resting = results.find((r) => r.name === "resting order with a stop attached")!;
    expect(resting.ok).toBe(false);
    expect(resting.detail).toMatch(/expected it to rest.*immediately matched/);
  });

  it("fails when the entry does not fill, and never opens a stop for nothing", async () => {
    const { client, calls } = fakeExchange({ fillSize: 0 });
    const results = await runLiveCheck(["--trade"], deps(client).d);
    expect(results.find((r) => r.name === "market entry")).toMatchObject({ ok: false });
    expect(results.some((r) => r.name === "stop-loss on the position")).toBe(false);
    expect(calls.filter((c) => c === "stop")).toHaveLength(0);
  });

  it("catches equity that jumps when a position opens, and still closes it", async () => {
    // A Unified account read as if it were Manual would lose, or double, the margin.
    const { client, position } = fakeExchange({ equityDriftWhileOpen: -1.2 });
    const results = await runLiveCheck(["--trade"], deps(client).d);
    const check = results.find((r) => r.name === "account value with a position open")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/misreading this account.s equity/);
    expect(results.find((r) => r.name === "close the position")).toMatchObject({ ok: true });
    expect(position()).toBe(0);
  });

  it("allows for fees and a few seconds of price", async () => {
    const { client } = fakeExchange({ equityDriftWhileOpen: -0.1 });
    const results = await runLiveCheck(["--trade"], deps(client).d);
    expect(results.find((r) => r.name === "account value with a position open")).toMatchObject({ ok: true });
  });

  it("reports leftover stops it could not cancel", async () => {
    const { client } = fakeExchange({ cancelFails: true });
    const results = await runLiveCheck(["--trade"], deps(client).d);
    expect(results.find((r) => r.name === "clean up")).toMatchObject({ ok: false });
    expect(results.find((r) => r.name === "clean up")!.detail).toMatch(/cancel them by hand/);
  });

  it("refuses to trade without a key", async () => {
    const { client } = fakeExchange();
    const { d, out } = deps({ ...client, isReadOnly: true });
    const results = await runLiveCheck(["--trade"], d);
    expect(results.at(-1)).toMatchObject({ name: "trading", ok: false });
    expect(out()).toMatch(/API wallet/);
  });
});
