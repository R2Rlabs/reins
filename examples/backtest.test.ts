/**
 * A backtester that flatters a strategy is worse than none, so these test the
 * three ways this one could lie: seeing the future, filling stops at prices the
 * market never offered, and forgetting what trading costs.
 */
import { describe, expect, it } from "vitest";
import {
  backtest,
  toBars,
  type Bar,
  type BacktestOptions,
  type Strategy,
} from "./backtest.ts";

function bar(time: number, open: number, high: number, low: number, close: number): Bar {
  return { time, open, high, low, close, volume: 1 };
}

const HOUR = 3_600_000;

const options: BacktestOptions = {
  symbol: "BTC",
  limits: {
    maxPositionUsd: 10_000,
    maxLeverage: 5,
    dailyLossLimitUsd: 1_000,
    symbolAllowlist: ["BTC"],
    maxOrdersPerMinute: 1_000,
    requireStopLoss: true,
  },
  riskUsd: 100,
  builderFeeIsYours: true, // isolate exchange fees
};

/** Enters long on the first chance, then holds forever. */
const buyAndHold = (stop: number): Strategy => (bars, position) =>
  position || bars.length < 2
    ? { action: "hold" }
    : { action: "enter", side: "buy", stop, reason: "test" };

describe("no lookahead", () => {
  it("never shows the strategy the bar it is about to trade into", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 100, 100),
      bar(3 * HOUR, 100, 100, 100, 100),
    ];
    const seen: number[] = [];
    backtest(
      bars,
      (visible) => {
        seen.push(visible.length);
        // The last bar a strategy can see must already have closed.
        expect(visible.at(-1)!.time).toBeLessThan(bars[seen.length]!.time);
        return { action: "hold" };
      },
      options,
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it("fills an entry at the next bar's open, not the close it decided on", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 137, 140, 136, 139), // a gap the strategy could not have known
      bar(3 * HOUR, 139, 139, 139, 139),
    ];
    const result = backtest(bars, buyAndHold(90), options);
    expect(result.trades[0]!.entry).toBe(137);
  });
});

describe("stops", () => {
  it("fires when the bar's low reaches the stop", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 101, 98, 99), // low of 98 takes out a stop at 99
      bar(3 * HOUR, 99, 99, 99, 99),
    ];
    const result = backtest(bars, buyAndHold(99), options);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.exitKind).toBe("stop");
    expect(result.trades[0]!.exit).toBe(99);
  });

  it("fills a gap through the stop at the open, not at the stop", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 100, 100),
      bar(3 * HOUR, 80, 81, 79, 80), // opened below the stop: you fill at 80
      bar(4 * HOUR, 80, 80, 80, 80),
    ];
    const result = backtest(bars, buyAndHold(95), options);
    expect(result.trades[0]!.exit).toBe(80);
    expect(result.trades[0]!.grossUsd).toBeLessThan(0);
  });

  it("checks the stop before asking the strategy again", () => {
    // A strategy that wants to hold through everything still gets stopped.
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 90, 100),
      bar(3 * HOUR, 100, 100, 100, 100),
    ];
    const result = backtest(bars, buyAndHold(95), options);
    // Stopped on the bar it opened, then the strategy is free to enter again.
    expect(result.trades[0]!.exitKind).toBe("stop");
    expect(result.trades[0]!.exit).toBe(95);
  });
});

describe("costs", () => {
  it("charges both sides, and nets them out of the result", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 100, 100),
      bar(3 * HOUR, 100, 100, 100, 100),
    ];
    const result = backtest(bars, buyAndHold(90), options);
    const trade = result.trades[0]!;
    // Flat price: gross is zero and the whole result is what it cost to trade.
    expect(trade.grossUsd).toBeCloseTo(0, 6);
    expect(trade.feesUsd).toBeCloseTo(trade.sizeUsd * 0.00045 * 2, 6);
    expect(result.netUsd).toBeCloseTo(-trade.feesUsd, 6);
  });

  it("adds the builder fee when it is not your own", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 100, 100),
    ];
    const mine = backtest(bars, buyAndHold(90), options);
    const theirs = backtest(bars, buyAndHold(90), { ...options, builderFeeIsYours: false });
    expect(theirs.feesUsd).toBeGreaterThan(mine.feesUsd);
    // 2 bp on each side, on the same size.
    const size = mine.trades[0]!.sizeUsd;
    expect(theirs.feesUsd - mine.feesUsd).toBeCloseTo(size * 0.0002 * 2, 6);
  });

  it("sizes from the stop, so a wider stop means a smaller position", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 100, 100),
    ];
    const tight = backtest(bars, buyAndHold(99), options).trades[0]!;
    const wide = backtest(bars, buyAndHold(98), options).trades[0]!;
    expect(tight.sizeUsd).toBeCloseTo(wide.sizeUsd * 2, 4);
  });
});

describe("the risk engine still applies", () => {
  it("refuses what the limits refuse, and counts it", () => {
    const bars = [
      bar(0, 100, 100, 100, 100),
      bar(HOUR, 100, 100, 100, 100),
      bar(2 * HOUR, 100, 100, 100, 100),
    ];
    const result = backtest(bars, buyAndHold(99), {
      ...options,
      limits: { ...options.limits, symbolAllowlist: ["ETH"] }, // BTC not allowed
    });
    expect(result.trades).toHaveLength(0);
    expect(result.refusals["SYMBOL_NOT_ALLOWED"]).toBeGreaterThan(0);
  });
});

describe("toBars", () => {
  it("parses strings and sorts oldest first", () => {
    const bars = toBars([
      { t: 2, T: 3, s: "BTC", i: "1h", o: "2", c: "3", h: "4", l: "1", v: "9", n: 1 },
      { t: 1, T: 2, s: "BTC", i: "1h", o: "1", c: "2", h: "3", l: "0.5", v: "8", n: 1 },
    ] as never);
    expect(bars.map((b) => b.time)).toEqual([1, 2]);
    expect(bars[0]!.open).toBe(1);
  });
});
