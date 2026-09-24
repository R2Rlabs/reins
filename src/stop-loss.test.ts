/**
 * Stop-losses end to end: the agent-facing tools, the risk engine and the
 * paper simulator together, with a market the test moves by hand.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDecisionLog } from "./decision-log.js";
import {
  cancelOrder,
  closePosition,
  getPositions,
  placeOrder,
  recordExchangeFills,
  setStopLoss,
  type McpServerDeps,
  type ToolResult,
} from "./mcp-server.js";
import { PaperClient } from "./paper.js";
import { RiskEngine } from "./risk.js";
import type { MarketDataSource } from "./trading-client.js";
import type { BookLevel, Candle, L2Book } from "./types.js";

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 18, 19, 52);

function book(bids: [number, number][], asks: [number, number][]): L2Book {
  const level = ([px, sz]: [number, number]): BookLevel => ({ px: String(px), sz: String(sz), n: 1 });
  return { coin: "ETH", time: START, levels: [bids.map(level), asks.map(level)] };
}

const NORMAL = book(
  [
    [2643, 5],
    [2642.5, 5],
  ],
  [
    [2643.5, 5],
    [2644, 5],
  ],
);

class FakeMarket implements MarketDataSource {
  current: L2Book = NORMAL;
  candleData: Candle[] = [];
  async l2Book(): Promise<L2Book> {
    return this.current;
  }
  async candles(coin: string, _interval: string, start: number, end: number): Promise<Candle[]> {
    return this.candleData.filter((c) => c.s === coin && c.t >= start && c.t <= end);
  }
  async assetInfo(symbol: string) {
    return { name: symbol, szDecimals: 4, maxLeverage: 50, index: 1 };
  }
}

function minute(openTime: number, o: number, low: number, high: number): Candle {
  return {
    t: openTime,
    T: openTime + MINUTE - 1,
    s: "ETH",
    i: "1m",
    o: String(o),
    c: String(o),
    h: String(high),
    l: String(low),
    v: "1",
    n: 1,
  };
}

function text(result: ToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

function parse(result: ToolResult): Record<string, unknown> {
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result)) as Record<string, unknown>;
}

let market: FakeMarket;
let clock: { ms: number };
let paper: PaperClient;
let log: MemoryDecisionLog;

function deps(requireStopLoss = false): McpServerDeps {
  return {
    client: paper,
    engine: new RiskEngine({
      maxPositionUsd: 2_500,
      maxLeverage: 3,
      dailyLossLimitUsd: 300,
      symbolAllowlist: ["ETH"],
      maxOrdersPerMinute: 12,
      requireStopLoss,
    }),
    log,
    now: () => clock.ms,
  };
}

beforeEach(() => {
  market = new FakeMarket();
  clock = { ms: START };
  paper = new PaperClient({ market, startingBalanceUsd: 10_000, now: () => clock.ms });
  log = new MemoryDecisionLog();
});

const buy = { symbol: "ETH", side: "buy" as const, sizeUsd: 2_000, reason: "Breakout held." };

describe("place_order with stopLoss", () => {
  it("fills, then puts a stop under the whole position, and logs both", async () => {
    const d = deps();
    const body = parse(await placeOrder(d, { ...buy, stopLoss: 2630.8 }));

    expect(body).toMatchObject({ kind: "filled", stopLoss: { side: "sell", triggerPrice: 2630.8 } });
    const positions = parse(await getPositions(d));
    expect(positions["unprotected"]).toEqual([]);
    expect(positions["stopLosses"]).toMatchObject([{ symbol: "ETH", side: "sell", size: 0.7558, triggerPrice: 2630.8 }]);
    expect(log.records.map((r) => r.tool)).toEqual(["place_order", "set_stop_loss"]);
    expect(log.records[1]!.reason).toMatch(/^Stop for order \d+: Breakout held\.$/);
  });

  it("refuses a stopLoss on the wrong side of the entry, sending nothing", async () => {
    const d = deps();
    expect(text(await placeOrder(d, { ...buy, stopLoss: 2650 }))).toMatch(/goes below the entry/);
    expect(text(await placeOrder(d, { ...buy, price: 2640, stopLoss: 2645 }))).toMatch(/goes below the entry/);
    expect((await paper.snapshot()).fills).toHaveLength(0);
    expect(log.records).toHaveLength(0);
  });

  it("sends a resting order's stop with it, placed the moment it fills", async () => {
    const d = deps();
    const body = parse(await placeOrder(d, { ...buy, price: 2640, stopLoss: 2630 }));
    expect(body).toMatchObject({ kind: "resting", stopLoss: { triggerPrice: 2630 } });
    expect(await paper.stopLosses()).toEqual([]); // nothing to protect yet

    const fill = START + 2 * MINUTE;
    market.candleData = [minute(fill, 2641, 2639, 2642)];
    clock.ms = START + 5 * MINUTE;
    const positions = parse(await getPositions(d));

    expect(positions["positionsUsd"]).toHaveProperty("ETH");
    expect(positions["stopLosses"]).toMatchObject([{ side: "sell", size: 0.7576, triggerPrice: 2630 }]);
    expect(positions["unprotected"]).toEqual([]);
    expect(log.records.map((r) => r.tool)).toEqual(["place_order"]);
  });

  it("fires a resting entry's stop in the same minute it filled, if that minute went through it", async () => {
    await placeOrder(deps(), { ...buy, price: 2640, stopLoss: 2630 });
    const minuteOfBoth = START + 2 * MINUTE;
    market.candleData = [minute(minuteOfBoth, 2641, 2628, 2642)];
    clock.ms = START + 5 * MINUTE;
    await paper.accountState(); // the entry fills
    await paper.accountState(); // its stop, now watching, sees the same minute

    const state = await paper.snapshot();
    expect(state.positions).toEqual({});
    expect(state.fills.map((f) => [f.side, f.price, f.time])).toEqual([
      ["buy", 2640, minuteOfBoth],
      ["sell", 2630, minuteOfBoth],
    ]);
  });
});

describe("set_stop_loss", () => {
  it("needs a position, and a trigger on the losing side of the market", async () => {
    const d = deps();
    expect(text(await setStopLoss(d, { symbol: "ETH", triggerPrice: 2600, reason: "r" }))).toMatch(/No open ETH position/);

    await placeOrder(d, buy);
    const wrong = await setStopLoss(d, { symbol: "ETH", triggerPrice: 2650, reason: "r" });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toMatch(/would trigger at once.*close_position/);
  });

  it("replaces the old stop, placing the new one first", async () => {
    const d = deps();
    const first = parse(await placeOrder(d, { ...buy, stopLoss: 2620 })) as { stopLoss: { orderId: number } };
    const moved = parse(await setStopLoss(d, { symbol: "ETH", triggerPrice: 2635, reason: "Trail it up." }));

    expect(moved["replaced"]).toEqual([first.stopLoss.orderId]);
    expect(await paper.stopLosses()).toMatchObject([{ triggerPrice: 2635 }]);
  });

  it("is cancelled like any other order", async () => {
    const d = deps();
    const placed = parse(await placeOrder(d, { ...buy, stopLoss: 2620 })) as { stopLoss: { orderId: number } };
    parse(await cancelOrder(d, { symbol: "ETH", orderId: placed.stopLoss.orderId }));
    expect(await paper.stopLosses()).toEqual([]);
  });
});

describe("stops firing in the paper simulator", () => {
  async function longWithStop(trigger = 2630.8) {
    const d = deps();
    parse(await placeOrder(d, { ...buy, stopLoss: trigger }));
    return d;
  }

  it("closes the position when a candle between polls reaches the trigger", async () => {
    await longWithStop();
    const dip = START + 8 * MINUTE;
    market.candleData = [minute(dip, 2635, 2629.4, 2636)];
    clock.ms = START + 30 * MINUTE;
    await paper.accountState();

    const state = await paper.snapshot();
    expect(state.positions).toEqual({});
    const exit = state.fills.at(-1)!;
    expect(exit).toMatchObject({ side: "sell", size: 0.7558, price: 2630.8, liquidity: "taker", time: dip });
    expect(await paper.stopLosses()).toEqual([]);
  });

  it("fills at the open when the market gapped straight through the stop", async () => {
    await longWithStop();
    market.candleData = [minute(START + 3 * MINUTE, 2610, 2605, 2612)];
    clock.ms = START + 30 * MINUTE;
    await paper.accountState();
    expect((await paper.snapshot()).fills.at(-1)).toMatchObject({ price: 2610 });
  });

  it("walks the real book when the trigger is reached right now", async () => {
    await longWithStop();
    clock.ms = START + MINUTE / 2; // no complete candle yet
    market.current = book(
      [
        [2630, 0.5],
        [2628, 5],
      ],
      [[2631, 5]],
    );
    await paper.accountState();
    const state = await paper.snapshot();
    const exit = state.fills.at(-1)!;
    // 0.5 at 2630, the other 0.2558 at 2628.
    expect(exit.price).toBeCloseTo((0.5 * 2630 + 0.2558 * 2628) / 0.7558, 6);
  });

  it("does not fire on a candle from before the stop was placed", async () => {
    await longWithStop();
    market.candleData = [minute(START - MINUTE, 2640, 2600, 2645)];
    clock.ms = START + 30 * MINUTE;
    await paper.accountState();
    expect((await paper.snapshot()).positions["ETH"]).toBeDefined();
  });
});

describe("close_position", () => {
  it("leaves no stop behind a closed position", async () => {
    const d = deps();
    parse(await placeOrder(d, { ...buy, stopLoss: 2630.8 }));
    parse(await closePosition(d, { symbol: "ETH", reason: "Done." }));
    expect(await paper.stopLosses()).toEqual([]);
  });

  // Demo run 2: closing a 0.03073 BTC short bought back 0.03067, because the
  // size came from the dollar value divided by a limit price above the market.
  it("closes a short completely, sized from the position rather than its dollar value", async () => {
    const d = deps();
    parse(await placeOrder(d, { symbol: "ETH", side: "sell", sizeUsd: 2_000, reason: "Breakdown.", stopLoss: 2660 }));
    const opened = (await paper.snapshot()).fills[0]!.size;

    const body = parse(await closePosition(d, { symbol: "ETH", reason: "Done." }));

    expect(body).toMatchObject({ closed: true, totalSize: String(opened) });
    expect(body).not.toHaveProperty("remainingSize");
    expect((await paper.snapshot()).positions).toEqual({});
    expect(await paper.stopLosses()).toEqual([]);
  });

  it("says so when the close leaves part of the position open", async () => {
    const d = deps();
    parse(await placeOrder(d, { ...buy, stopLoss: 2630.8 }));
    market.current = book([[2643, 0.3]], [[2643.5, 5]]); // too thin to take it all
    const body = parse(await closePosition(d, { symbol: "ETH", reason: "Done." }));

    expect(body["remainingSize"]).toBeCloseTo(0.7558 - 0.3, 6);
    expect(body["warning"]).toMatch(/still open/);
    expect(await paper.stopLosses()).toHaveLength(1); // the rest stays protected
  });
});

describe("maxTradeRiskUsd", () => {
  function riskCapped(maxTradeRiskUsd: number): McpServerDeps {
    return {
      client: paper,
      engine: new RiskEngine({
        maxPositionUsd: 2_500,
        maxLeverage: 3,
        dailyLossLimitUsd: 300,
        symbolAllowlist: ["ETH"],
        maxOrdersPerMinute: 12,
        maxTradeRiskUsd,
      }),
      log,
      now: () => clock.ms,
    };
  }

  it("works the risk out from the entry price and the stop, and logs it", async () => {
    // $2,000 entered at the marketable 2646.14 (the 2643.5 ask plus the
    // crossing buffer) with the stop at 2630.8: 0.58% away, about $11.60.
    const d = riskCapped(20);
    const body = parse(await placeOrder(d, { ...buy, stopLoss: 2630.8 }));
    expect(body).toMatchObject({ kind: "filled" });
    expect(log.records[0]!.request["riskUsd"]).toBeCloseTo(11.6, 1);
  });

  it("refuses the same size with a stop too far away, and sends nothing", async () => {
    const d = riskCapped(20);
    const blocked = await placeOrder(d, { ...buy, stopLoss: 2560 });
    expect(text(blocked)).toMatch(/BLOCKED \(TRADE_RISK_TOO_LARGE\).*over the \$20 allowed/s);
    expect((await paper.snapshot()).fills).toHaveLength(0);
    expect(log.records[0]!.risk).toMatchObject({ allowed: false, code: "TRADE_RISK_TOO_LARGE" });
  });

  it("takes the same trade at a size the stop distance allows", async () => {
    const d = riskCapped(20);
    parse(await placeOrder(d, { ...buy, sizeUsd: 600, stopLoss: 2560 }));
    expect((await paper.snapshot()).fills).toHaveLength(1);
  });
});

describe("fills the exchange made without an agent call", () => {
  const kinds = () =>
    log.records.map((r) => (r.tool === "exchange_fill" ? `${r.tool}:${String(r.request["kind"])}` : r.tool));

  it("records a stop-loss firing, which no tool call would otherwise log", async () => {
    const d = deps();
    parse(await placeOrder(d, { ...buy, stopLoss: 2630.8 }));
    const dip = START + 8 * MINUTE;
    market.candleData = [minute(dip, 2635, 2629.4, 2636)];
    clock.ms = START + 30 * MINUTE;

    expect(await recordExchangeFills(d)).toBe(1);
    expect(kinds()).toEqual(["place_order", "set_stop_loss", "exchange_fill:stop_loss"]);
    const fired = log.records.at(-1)!;
    expect(fired.reason).toMatch(/^Not an agent decision: stop-loss \d+ fired on the exchange, sell 0.7558 ETH at 2630.8\.$/);
    expect(fired.request).toMatchObject({ filledAt: new Date(dip).toISOString(), symbol: "ETH" });
    expect(fired.outcome).toMatchObject({ kind: "filled", totalSize: "0.7558", avgPrice: "2630.8" });
  });

  it("records a resting entry filling later, and the stop that rode with it", async () => {
    const d = deps();
    parse(await placeOrder(d, { ...buy, price: 2640, stopLoss: 2630 }));
    market.candleData = [minute(START + 2 * MINUTE, 2641, 2639, 2642), minute(START + 9 * MINUTE, 2633, 2628, 2634)];
    clock.ms = START + 30 * MINUTE;
    await paper.accountState(); // the entry fills
    await paper.accountState(); // its stop sees the later dip

    expect(await recordExchangeFills(d)).toBe(2);
    expect(kinds()).toEqual(["place_order", "exchange_fill:resting_order", "exchange_fill:stop_loss"]);
    expect(log.records[1]!.reason).toMatch(/order \d+, resting since .+, filled on the exchange, buy/);
  });

  it("writes each fill once, however often it is asked", async () => {
    const d = deps();
    parse(await placeOrder(d, { ...buy, stopLoss: 2630.8 }));
    market.candleData = [minute(START + 8 * MINUTE, 2635, 2629.4, 2636)];
    clock.ms = START + 30 * MINUTE;
    await recordExchangeFills(d);
    expect(await recordExchangeFills(d)).toBe(0);
    expect(log.records.filter((r) => r.tool === "exchange_fill")).toHaveLength(1);
  });

  it("leaves fills the agent already logged alone", async () => {
    const d = deps();
    parse(await placeOrder(d, buy));
    parse(await closePosition(d, { symbol: "ETH", reason: "Done." }));
    expect(await recordExchangeFills(d)).toBe(0);
  });

  it("does nothing without a log to write to, or anything in it", async () => {
    const { log: _none, ...withoutLog } = deps();
    expect(await recordExchangeFills(withoutLog)).toBe(0);
    expect(await recordExchangeFills(deps())).toBe(0);
  });
});

describe("requireStopLoss", () => {
  it("wants a stopLoss on an order that fills now", async () => {
    const blocked = await placeOrder(deps(true), buy);
    expect(text(blocked)).toMatch(/BLOCKED \(NO_STOP_LOSS\)/);
    expect(log.records[0]!.risk).toMatchObject({ allowed: false, code: "NO_STOP_LOSS" });
  });

  it("refuses a resting entry without a stop too, so no fill is ever bare", async () => {
    const d = deps(true);
    expect(text(await placeOrder(d, { ...buy, price: 2640 }))).toMatch(/NO_STOP_LOSS.*must carry a stopLoss/);
    expect((await placeOrder(d, { ...buy, price: 2640, stopLoss: 2630 })).isError).toBeFalsy();
  });

  it("blocks new risk while a position is unprotected, until a stop is set", async () => {
    const d = deps(true);
    const placed = parse(await placeOrder(d, { ...buy, stopLoss: 2630 })) as { stopLoss: { orderId: number } };
    parse(await cancelOrder(d, { symbol: "ETH", orderId: placed.stopLoss.orderId }));

    expect(parse(await getPositions(d))["unprotected"]).toEqual(["ETH"]);
    const more = { ...buy, sizeUsd: 300, price: 2635, stopLoss: 2625 };
    expect(text(await placeOrder({ ...d }, { ...more, symbol: "ETH" }))).not.toMatch(/ETH has no stop-loss/);

    // An order for another symbol cannot vouch for ETH.
    const btc = deps(true);
    btc.engine = new RiskEngine({ ...btc.engine.configuredLimits, symbolAllowlist: ["ETH", "BTC"] });
    expect(text(await placeOrder(btc, { ...more, symbol: "BTC" }))).toMatch(/NO_STOP_LOSS.*ETH has no stop-loss/);

    parse(await setStopLoss(d, { symbol: "ETH", triggerPrice: 2625, reason: "Below the base." }));
    expect(parse(await getPositions(d))["unprotected"]).toEqual([]);
  });

  it("treats a position that outgrew its stop as unprotected", async () => {
    const d = deps();
    parse(await placeOrder(d, { ...buy, sizeUsd: 1_000, stopLoss: 2630 }));
    parse(await placeOrder(d, { ...buy, sizeUsd: 500 }));
    expect(parse(await getPositions(d))["unprotected"]).toEqual(["ETH"]);
  });
});
