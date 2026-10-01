/**
 * Two invariants in examples/bot.ts, because an example teaches whatever it
 * does to everyone who copies it.
 *
 * 1. The notional the risk engine checks is the notional the order carries.
 *    If they drift, the limits are decorative: the check passes on a number
 *    unrelated to what the exchange receives.
 * 2. A refused order is never sent. That is the invariant the whole product
 *    rests on.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryDecisionLog, RiskEngine, type AssetMeta, type Candle } from "../dist/index.js";
import { runOnce, sizeInAssetUnits, type BotDeps } from "./bot.ts";

const META: { universe: AssetMeta[] } = {
  universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
};

/** 40 hourly closes that rise, so the fast average sits over the slow one. */
function risingCandles(): Candle[] {
  return Array.from({ length: 40 }, (_, i) => ({
    t: i,
    T: i,
    s: "BTC",
    i: "1h",
    o: String(80_000 + i * 100),
    c: String(80_000 + i * 100),
    h: String(80_000 + i * 100),
    l: String(80_000 + i * 100),
    v: "1",
    n: 1,
  })) as unknown as Candle[];
}

function book(bid: number, ask: number) {
  return { levels: [[{ px: String(bid), sz: "5", n: 1 }], [{ px: String(ask), sz: "5", n: 1 }]] };
}

function deps(overrides: Partial<BotDeps> = {}): BotDeps & { placed: ReturnType<typeof vi.fn> } {
  const placed = vi.fn().mockResolvedValue({ status: "ok" });
  const base = {
    trade: {
      accountState: vi.fn().mockResolvedValue({
        positionsUsd: {},
        realizedPnlTodayUsd: 0,
        accountValueUsd: 10_000,
      }),
      placeOrder: placed,
    } as unknown as BotDeps["trade"],
    market: {
      candles: vi.fn().mockResolvedValue(risingCandles()),
      // A price that is not round, so a conversion bug cannot hide behind
      // arithmetic that happens to come out even.
      l2Book: vi.fn().mockResolvedValue(book(83_333.7, 83_334.9)),
      meta: vi.fn().mockResolvedValue(META),
    } as unknown as BotDeps["market"],
    engine: new RiskEngine({
      maxPositionUsd: 2_000,
      maxLeverage: 2,
      dailyLossLimitUsd: 200,
      symbolAllowlist: ["BTC"],
      maxOrdersPerMinute: 4,
      requireStopLoss: true,
      maxTradeRiskUsd: 25,
    }),
    log: new MemoryDecisionLog(),
    strategy: (candles: Candle[]) => {
      void candles;
      return { side: "buy" as const, reason: "test" };
    },
  };
  return { ...base, ...overrides, placed };
}

describe("sizeInAssetUnits", () => {
  const meta = META.universe[0]!;

  it("turns USD into asset units at the exchange's precision", () => {
    expect(sizeInAssetUnits(2_500, 83_333.7, meta)).toBeCloseTo(0.03, 5);
  });

  it("rounds to the asset's decimals rather than sending more precision", () => {
    const size = sizeInAssetUnits(1_234.56, 83_333.7, meta);
    expect(String(size).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(meta.szDecimals);
  });
});

describe("the notional checked is the notional ordered", () => {
  it("sends a size whose value matches what the risk engine approved", async () => {
    const d = deps();
    const check = vi.spyOn(d.engine, "check");
    await runOnce(d);

    expect(check).toHaveBeenCalledOnce();
    const approvedUsd = check.mock.calls[0]![0].sizeUsd;
    const [order] = d.placed.mock.calls[0]!;
    const orderedUsd = order.size * order.price;

    // Rounding to 5 decimals of BTC is about $0.83 at this price; anything
    // wider than a cent per $1,000 would mean the conversion is wrong.
    expect(orderedUsd).toBeCloseTo(approvedUsd, 0);
  });

  it("attaches the stop the risk check was told about", async () => {
    const d = deps();
    await runOnce(d);
    const [order] = d.placed.mock.calls[0]!;
    expect(order.stopLoss).toBeLessThan(order.price);
    expect(order.tif).toBe("Ioc");
  });
});

describe("a refused order is never sent", () => {
  it("does not touch the trading client when a limit says no", async () => {
    const d = deps({
      engine: new RiskEngine({
        maxPositionUsd: 2_000,
        maxLeverage: 2,
        dailyLossLimitUsd: 200,
        symbolAllowlist: ["ETH"], // BTC is not allowed
        maxOrdersPerMinute: 4,
      }),
    });

    const result = await runOnce(d);

    expect(result).toContain("SYMBOL_NOT_ALLOWED");
    expect(d.placed).not.toHaveBeenCalled();
  });

  it("writes the refusal to the log, with its code", async () => {
    const d = deps({
      engine: new RiskEngine({
        maxPositionUsd: 10, // smaller than any order this bot would send
        maxLeverage: 2,
        dailyLossLimitUsd: 200,
        symbolAllowlist: ["BTC"],
        maxOrdersPerMinute: 4,
      }),
    });

    await runOnce(d);

    const records = await d.log.read(10);
    expect(records).toHaveLength(1);
    expect(records[0]!.risk).toMatchObject({ allowed: false, code: "POSITION_TOO_LARGE" });
    expect(d.placed).not.toHaveBeenCalled();
  });

  it("does not spend a rate-limit slot on an order it never sent", async () => {
    const d = deps({
      engine: new RiskEngine({
        maxPositionUsd: 10,
        maxLeverage: 2,
        dailyLossLimitUsd: 200,
        symbolAllowlist: ["BTC"],
        maxOrdersPerMinute: 4,
      }),
    });
    await runOnce(d);
    expect(d.engine.ordersRemaining()).toBe(4);
  });
});
