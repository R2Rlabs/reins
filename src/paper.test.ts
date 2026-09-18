import { beforeEach, describe, expect, it } from "vitest";
import {
  applyToPosition,
  BASE_MAKER_FEE_RATE,
  BASE_TAKER_FEE_RATE,
  MemoryPaperStore,
  PaperClient,
  walkBook,
  type PaperPosition,
} from "./paper.js";
import type { MarketDataSource } from "./trading-client.js";
import type { BookLevel, Candle, CandleInterval, L2Book } from "./types.js";

function book(bids: [number, number][], asks: [number, number][]): L2Book {
  const level = ([px, sz]: [number, number]): BookLevel => ({
    px: String(px),
    sz: String(sz),
    n: 1,
  });
  return {
    coin: "BTC",
    time: 1_754_450_974_231,
    levels: [bids.map(level), asks.map(level)],
  };
}

const DEFAULT_BOOK = book(
  [
    [100_000, 5],
    [99_990, 8],
  ],
  [
    [100_010, 4],
    [100_020, 9],
  ],
);

/** A market whose book the test can move between calls. */
class FakeMarket implements MarketDataSource {
  current: L2Book = DEFAULT_BOOK;
  szDecimals = 5;

  async l2Book(): Promise<L2Book> {
    return this.current;
  }
  candleRequests: unknown[][] = [];
  async candles(...args: [string, CandleInterval, number, number]): Promise<Candle[]> {
    this.candleRequests.push(args);
    return [];
  }
  async assetInfo(symbol: string) {
    return { name: symbol, szDecimals: this.szDecimals, maxLeverage: 50, index: 0 };
  }
}

let market: FakeMarket;

beforeEach(() => {
  market = new FakeMarket();
});

function client(overrides: Partial<ConstructorParameters<typeof PaperClient>[0]> = {}) {
  return new PaperClient({
    market,
    startingBalanceUsd: 1_000_000,
    ...overrides,
  });
}

describe("candles", () => {
  it("passes straight through to the live market", async () => {
    await client().candles("ETH", "15m", 10, 20);
    expect(market.candleRequests).toEqual([["ETH", "15m", 10, 20]]);
  });
});

describe("applyToPosition", () => {
  it("opens from flat at the fill price", () => {
    const position: PaperPosition = { size: 0, entryPrice: 0 };
    expect(applyToPosition(position, 2, 100)).toBe(0);
    expect(position).toEqual({ size: 2, entryPrice: 100 });
  });

  it("re-averages the entry when adding to a long", () => {
    const position: PaperPosition = { size: 2, entryPrice: 100 };
    expect(applyToPosition(position, 2, 120)).toBe(0);
    expect(position).toEqual({ size: 4, entryPrice: 110 });
  });

  it("realises PnL on a partial close", () => {
    const position: PaperPosition = { size: 4, entryPrice: 100 };
    expect(applyToPosition(position, -1, 130)).toBeCloseTo(30, 6);
    // The remaining position keeps its original entry.
    expect(position).toEqual({ size: 3, entryPrice: 100 });
  });

  it("realises the whole position on a full close and resets the entry", () => {
    const position: PaperPosition = { size: 3, entryPrice: 100 };
    expect(applyToPosition(position, -3, 90)).toBeCloseTo(-30, 6);
    expect(position).toEqual({ size: 0, entryPrice: 0 });
  });

  it("realises the old position and re-opens when flipping through zero", () => {
    const position: PaperPosition = { size: 2, entryPrice: 100 };
    // Closes 2 at 110 for +20, then opens 3 short at 110.
    expect(applyToPosition(position, -5, 110)).toBeCloseTo(20, 6);
    expect(position).toEqual({ size: -3, entryPrice: 110 });
  });

  it("handles shorts symmetrically", () => {
    const position: PaperPosition = { size: -2, entryPrice: 100 };
    expect(applyToPosition(position, -2, 120)).toBe(0);
    expect(position).toEqual({ size: -4, entryPrice: 110 });
    // Buying back below the entry is a profit on a short.
    expect(applyToPosition(position, 4, 100)).toBeCloseTo(40, 6);
  });
});

describe("walkBook", () => {
  it("fills at the touch when one level is deep enough", () => {
    const result = walkBook(DEFAULT_BOOK.levels[1], "buy", 100_020, 2);
    expect(result.filled).toBe(2);
    expect(result.avgPrice).toBeCloseTo(100_010, 6);
  });

  it("pays for depth when the order eats several levels", () => {
    const result = walkBook(DEFAULT_BOOK.levels[1], "buy", 100_020, 6);
    expect(result.filled).toBe(6);
    // 4 at 100,010 and 2 at 100,020.
    expect(result.avgPrice).toBeCloseTo(100_013.333_33, 4);
  });

  it("stops at the limit price rather than walking past it", () => {
    const result = walkBook(DEFAULT_BOOK.levels[1], "buy", 100_010, 6);
    expect(result.filled).toBe(4);
    expect(result.avgPrice).toBeCloseTo(100_010, 6);
  });

  it("returns nothing when no level crosses", () => {
    const result = walkBook(DEFAULT_BOOK.levels[1], "buy", 99_000, 1);
    expect(result).toEqual({ filled: 0, avgPrice: 0 });
  });

  it("walks the bid side downward for a sell", () => {
    const result = walkBook(DEFAULT_BOOK.levels[0], "sell", 99_990, 7);
    // 5 at 100,000 and 2 at 99,990.
    expect(result.filled).toBe(7);
    expect(result.avgPrice).toBeCloseTo(99_997.142_86, 4);
  });
});

describe("marketable fills", () => {
  it("fills across levels and charges the taker fee", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 6,
      price: 100_020,
      tif: "Ioc",
    });

    expect(outcome.kind).toBe("filled");
    const state = await paper.snapshot();
    const fill = state.fills[0]!;
    expect(fill.liquidity).toBe("taker");
    expect(fill.price).toBeCloseTo(100_013.333_33, 4);
    expect(fill.feeUsd).toBeCloseTo(fill.notionalUsd * BASE_TAKER_FEE_RATE, 6);
    expect(state.balanceUsd).toBeCloseTo(1_000_000 - fill.feeUsd, 6);
  });

  it("partially fills when the book is too thin and cancels an Ioc remainder", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 50,
      price: 100_020,
      tif: "Ioc",
    });

    expect(outcome).toMatchObject({ kind: "filled", totalSize: "13" });
    expect((await paper.snapshot()).resting).toHaveLength(0);
  });

  it("rests a Gtc remainder instead of cancelling it", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "buy", size: 50, price: 100_020 });
    const state = await paper.snapshot();
    expect(state.resting).toHaveLength(1);
    expect(state.resting[0]!.size).toBeCloseTo(37, 5);
  });

  it("charges the builder fee on top of the exchange fee", async () => {
    const paper = client({ builderFeeTenthsBps: 10 }); // 1 bp
    await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });
    const fill = (await paper.snapshot()).fills[0]!;
    expect(fill.feeUsd).toBeCloseTo(fill.notionalUsd * (BASE_TAKER_FEE_RATE + 0.0001), 6);
  });

  it("rejects a post-only order that would cross", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Alo",
    });
    expect(outcome).toMatchObject({ kind: "rejected" });
    expect((await paper.snapshot()).fills).toHaveLength(0);
  });

  it("rests a post-only order that does not cross, as the exchange would", async () => {
    // The demo agent's first real order: a passive bid below the ask, sent
    // Alo, was cancelled as if it were an Ioc.
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 99_995,
      tif: "Alo",
    });
    expect(outcome).toMatchObject({ kind: "resting" });
    const state = await paper.snapshot();
    expect(state.resting).toMatchObject([{ side: "buy", size: 1, price: 99_995 }]);
    expect(state.fills).toHaveLength(0);
  });

  it("fills a rested post-only order as a maker once the market trades through it", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 99_995, tif: "Alo" });
    market.current = book([[99_970, 5]], [[99_980, 5]]);
    await paper.accountState();

    const [fill] = (await paper.snapshot()).fills;
    expect(fill).toMatchObject({ price: 99_995, liquidity: "maker" });
  });

  it("rejects an Ioc that finds no liquidity", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 90_000,
      tif: "Ioc",
    });
    expect(outcome).toMatchObject({ kind: "rejected" });
  });

  it("rejects a size that rounds away to nothing", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.000_000_1,
      price: 100_020,
    });
    expect(outcome).toMatchObject({ kind: "rejected" });
  });
});

describe("resting orders", () => {
  it("does not fill when the market only trades to the order's price", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 99_000 });

    // Best ask comes down to exactly the resting price. At your own price you
    // are behind a queue, so this must not count as a fill.
    market.current = book([[98_990, 5]], [[99_000, 5]]);
    await paper.accountState();

    const state = await paper.snapshot();
    expect(state.fills).toHaveLength(0);
    expect(state.resting).toHaveLength(1);
  });

  it("fills once the market trades strictly through the order", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 99_000 });

    market.current = book([[98_980, 5]], [[98_999, 5]]);
    await paper.accountState();

    const state = await paper.snapshot();
    expect(state.resting).toHaveLength(0);
    expect(state.fills).toHaveLength(1);
    expect(state.fills[0]!.liquidity).toBe("maker");
    // Filled at its own limit, not at the new touch.
    expect(state.fills[0]!.price).toBe(99_000);
  });

  it("charges the maker fee on a resting fill", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 99_000 });
    market.current = book([[98_980, 5]], [[98_999, 5]]);
    await paper.accountState();

    const fill = (await paper.snapshot()).fills[0]!;
    expect(fill.feeUsd).toBeCloseTo(fill.notionalUsd * BASE_MAKER_FEE_RATE, 6);
  });

  it("fills a resting sell once the bid trades above it", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "sell", size: 1, price: 101_000 });
    market.current = book([[101_001, 5]], [[101_010, 5]]);
    await paper.accountState();

    expect((await paper.snapshot()).fills).toHaveLength(1);
  });

  it("cancels a resting order by id", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 99_000,
    });
    const oid = outcome.kind === "resting" ? outcome.oid : -1;

    expect(await paper.cancelOrder("BTC", oid)).toEqual({ kind: "cancelled" });
    expect(await paper.cancelOrder("BTC", oid)).toMatchObject({ kind: "rejected" });
  });
});

describe("reduce-only", () => {
  it("is rejected when there is no opposing position", async () => {
    const paper = client();
    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "sell",
      size: 1,
      price: 99_000,
      reduceOnly: true,
    });
    expect(outcome).toMatchObject({ kind: "rejected" });
  });

  it("is clamped to the size of the position it is closing", async () => {
    const paper = client();
    await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 2,
      price: 100_020,
      tif: "Ioc",
    });
    await paper.placeOrder({
      symbol: "BTC",
      side: "sell",
      size: 10,
      price: 99_000,
      reduceOnly: true,
      tif: "Ioc",
    });

    const state = await paper.snapshot();
    expect(state.positions["BTC"]).toBeUndefined();
    expect(state.fills[1]!.size).toBe(2);
  });
});

describe("account state", () => {
  it("marks open positions to the mid and reports unrealised PnL", async () => {
    const paper = client();
    await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });

    market.current = book([[110_000, 5]], [[110_010, 5]]);
    const state = await paper.accountState();

    expect(state.positionsUsd["BTC"]).toBeCloseTo(110_005, 2);
    // Entry was 100,010; mid is now 110,005, so roughly $9,995 of unrealised gain.
    expect(state.accountValueUsd).toBeGreaterThan(1_009_000);
  });

  it("counts realised PnL net of fees for today", async () => {
    const paper = client();
    await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });
    market.current = book([[110_000, 5]], [[110_010, 5]]);
    await paper.placeOrder({
      symbol: "BTC",
      side: "sell",
      size: 1,
      price: 109_000,
      reduceOnly: true,
      tif: "Ioc",
    });

    const state = await paper.accountState();
    expect(state.positionsUsd["BTC"]).toBeUndefined();
    // Bought at 100,010, sold at 110,000, minus both fees.
    expect(state.realizedPnlTodayUsd).toBeGreaterThan(9_800);
    expect(state.realizedPnlTodayUsd).toBeLessThan(9_990);
  });

  it("excludes fills from previous days", async () => {
    let clock = Date.UTC(2026, 8, 15, 12, 0, 0);
    const paper = client({ now: () => clock });
    await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });

    clock = Date.UTC(2026, 8, 17, 12, 0, 0);
    expect((await paper.accountState()).realizedPnlTodayUsd).toBe(0);
  });
});

describe("concurrency", () => {
  it("serialises overlapping orders instead of interleaving them", async () => {
    const paper = client();
    const outcomes = await Promise.all([
      paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 100_020, tif: "Ioc" }),
      paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 100_020, tif: "Ioc" }),
      paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 100_020, tif: "Ioc" }),
    ]);

    const oids = outcomes.map((o) => (o.kind === "rejected" ? -1 : o.oid));
    expect(new Set(oids).size).toBe(3);

    const state = await paper.snapshot();
    expect(state.fills).toHaveLength(3);
    expect(state.positions["BTC"]?.size).toBeCloseTo(3, 6);
  });

  it("fills a resting order exactly once under concurrent reads", async () => {
    const paper = client();
    await paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 99_000 });
    market.current = book([[98_980, 5]], [[98_999, 5]]);

    await Promise.all([paper.accountState(), paper.accountState(), paper.accountState()]);

    const state = await paper.snapshot();
    expect(state.fills).toHaveLength(1);
    expect(state.resting).toHaveLength(0);
  });

  it("keeps working after one operation fails", async () => {
    const paper = client();
    const boom = new Error("market unavailable");
    const original = market.l2Book.bind(market);
    market.l2Book = async () => {
      market.l2Book = original;
      throw boom;
    };

    await expect(
      paper.placeOrder({ symbol: "BTC", side: "buy", size: 1, price: 100_020, tif: "Ioc" }),
    ).rejects.toThrow("market unavailable");

    const outcome = await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });
    expect(outcome.kind).toBe("filled");
  });
});

describe("persistence", () => {
  it("resumes a run from the store", async () => {
    const store = new MemoryPaperStore();
    const first = client({ store });
    await first.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });

    const resumed = client({ store });
    const state = await resumed.snapshot();
    expect(state.fills).toHaveLength(1);
    expect(state.positions["BTC"]?.size).toBe(1);
  });

  it("starts fresh again after a reset", async () => {
    const store = new MemoryPaperStore();
    const paper = client({ store });
    await paper.placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 1,
      price: 100_020,
      tif: "Ioc",
    });
    await paper.reset();

    const state = await paper.snapshot();
    expect(state.fills).toHaveLength(0);
    expect(state.balanceUsd).toBe(1_000_000);
  });
});
