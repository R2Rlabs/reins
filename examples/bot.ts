/**
 * A strategy bot built on the Reins package — no model, no MCP, just the
 * pieces: market data, a risk engine that refuses orders, a paper account that
 * fills them, and a log of both.
 *
 *   npm run build
 *   node examples/bot.ts --once          # one pass
 *   node examples/bot.ts                 # every 5 minutes until stopped
 *
 * ## The strategy here is deliberately bad
 *
 * It is a 10/30 moving-average cross on hourly candles. It is an illustration
 * of where your strategy plugs in, not a strategy: after fees a cross like this
 * loses money, and it is published that way on purpose so nobody mistakes it
 * for an edge. Replace `movingAverageCross` with your own and keep everything
 * around it.
 *
 * ## Paper results are not strategy results
 *
 * `PaperClient` is deliberately pessimistic: it walks the real book for depth,
 * charges real maker/taker fees plus the same 2 bp builder fee the live path
 * pays, and fills a resting order only when the market trades strictly through
 * it. A strategy that only works if you assume fills at your own price does not
 * work. Even so, a good paper run proves plumbing, not profit.
 *
 * ## Going live
 *
 * `PaperClient` and `HyperliquidClient` both implement `TradingClient`, so the
 * swap is the one marked LIVE below. Read it before you make it.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  HyperliquidClient,
  MemoryDecisionLog,
  createIdFactory,
  MemoryPaperStore,
  PaperClient,
  REINS_BUILDER,
  RiskEngine,
  formatSize,
  type AssetMeta,
  type Candle,
  type TradingClient,
} from "../dist/index.js";

const SYMBOL = "BTC";
const INTERVAL_MS = 5 * 60_000;

/** What the bot is allowed to do, whatever the strategy decides. */
const LIMITS = {
  maxPositionUsd: 2_000,
  maxLeverage: 2,
  dailyLossLimitUsd: 200,
  symbolAllowlist: [SYMBOL],
  maxOrdersPerMinute: 4,
  requireStopLoss: true,
  maxTradeRiskUsd: 25,
  minLiquidationDistancePct: 15,
};

type Signal = { side: "buy" | "sell"; reason: string } | { side: "flat"; reason: string };

/**
 * The illustration. Fast average over slow: long above, flat below. Nothing
 * here is an edge — see the header.
 */
function movingAverageCross(candles: Candle[]): Signal {
  const closes = candles.map((c) => Number(c.c));
  if (closes.length < 30) return { side: "flat", reason: "not enough history yet" };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const fast = mean(closes.slice(-10));
  const slow = mean(closes.slice(-30));
  const gap = ((fast - slow) / slow) * 100;
  return fast > slow
    ? { side: "buy", reason: `10h average is ${gap.toFixed(2)}% over the 30h` }
    : { side: "flat", reason: `10h average is ${gap.toFixed(2)}% under the 30h` };
}

/**
 * USD notional to asset units, rounded the way the exchange expects.
 *
 * This conversion is the one place a bot can make every limit decorative: the
 * risk engine checks a USD number, the exchange takes a size in asset units,
 * and if they disagree the check passed on an order nobody sent. Converting in
 * one function, used for both, is what keeps them the same order.
 */
export function sizeInAssetUnits(sizeUsd: number, price: number, meta: AssetMeta): number {
  return Number(formatSize(sizeUsd / price, meta.szDecimals));
}

export interface BotDeps {
  trade: TradingClient;
  /** Ids for the log; injectable so a test can read what was written. */
  nextId?: () => string;
  market: Pick<HyperliquidClient, "candles" | "l2Book" | "meta">;
  engine: RiskEngine;
  log: MemoryDecisionLog;
  strategy: (candles: Candle[]) => Signal;
}

/** One pass: look, decide, ask the engine, and only then send anything. */
export async function runOnce(deps: BotDeps): Promise<string> {
  const now = Date.now();
  const nextId = deps.nextId ?? createIdFactory();
  const record = (fields: Omit<Parameters<MemoryDecisionLog["append"]>[0], "id" | "time">) =>
    deps.log.append({ id: nextId(), time: new Date().toISOString(), ...fields });
  const candles = await deps.market.candles(SYMBOL, "1h", now - 40 * 3_600_000, now);
  const signal = deps.strategy(candles);

  const state = await deps.trade.accountState();
  const held = state.positionsUsd[SYMBOL] ?? 0;

  if (signal.side === "flat") {
    if (held === 0) return `hold — ${signal.reason}`;
    const book = await deps.market.l2Book(SYMBOL);
    const price = Number(book.levels[held > 0 ? 0 : 1][0]?.px);
    const { universe } = await deps.market.meta();
    const meta = universe.find((a) => a.name === SYMBOL)!;
    await deps.trade.placeOrder({
      symbol: SYMBOL,
      side: held > 0 ? "sell" : "buy",
      size: sizeInAssetUnits(Math.abs(held), price, meta),
      price,
      reduceOnly: true,
      tif: "Ioc",
    });
    await record({ tool: "close_position", reason: signal.reason, request: { symbol: SYMBOL } });
    return `closed ${SYMBOL} — ${signal.reason}`;
  }

  if (held !== 0) return `already positioned — ${signal.reason}`;

  const book = await deps.market.l2Book(SYMBOL);
  const bid = Number(book.levels[0][0]?.px);
  const ask = Number(book.levels[1][0]?.px);
  // Cross the spread: a buy at the bid never fills, it only rests. Paying the
  // spread is the price of an entry that either happens now or not at all.
  const entry = signal.side === "buy" ? ask : bid;
  const stop = signal.side === "buy" ? entry * 0.99 : entry * 1.01;

  // Size from the stop, not from a fixed notional: the per-trade limit is
  // about what a loss costs, and this is the arithmetic it checks.
  const riskUsd = Math.min(LIMITS.maxTradeRiskUsd, 25);
  const sizeUsd = Math.min(riskUsd / (Math.abs(entry - stop) / entry), LIMITS.maxPositionUsd);

  const decision = deps.engine.check(
    { symbol: SYMBOL, side: signal.side, sizeUsd, hasStopLoss: true, riskUsd },
    state,
  );
  if (!decision.allowed) {
    // Refusals are kept as carefully as fills: the question after a bad week is
    // what the bot wanted to do, not only what it did.
    await record({
      tool: "place_order",
      reason: signal.reason,
      request: { symbol: SYMBOL, side: signal.side, sizeUsd },
      risk: { allowed: false, code: decision.code, detail: decision.reason },
    });
    return `refused ${decision.code} — ${decision.reason}`;
  }

  const { universe } = await deps.market.meta();
  const meta = universe.find((a) => a.name === SYMBOL)!;
  // Ioc, not a resting maker order, on purpose: this either fills now or does
  // nothing, so there is no resting entry to remember between passes. Running
  // it twice with Alo showed why that matters — the first order rests, the
  // position still reads zero, and the next pass stacks another one. A maker
  // version is better priced but has to track its order id and cancel before
  // replacing, which is more machinery than an example should hide.
  await deps.trade.placeOrder({
    symbol: SYMBOL,
    side: signal.side,
    size: sizeInAssetUnits(sizeUsd, entry, meta),
    price: entry,
    tif: "Ioc",
    stopLoss: Number(stop.toFixed(1)),
  });
  // Only now: `check` is safe to call speculatively, `recordOrder` is not.
  deps.engine.recordOrder();
  await record({
    tool: "place_order",
    reason: signal.reason,
    request: { symbol: SYMBOL, side: signal.side, sizeUsd, stopLoss: stop, riskUsd },
  });
  return `${signal.side} $${sizeUsd.toFixed(0)} of ${SYMBOL} at ${entry}, stop ${stop.toFixed(1)}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { once: { type: "boolean", default: false } } });

  // Market data needs no key, and this client has no signer, so it could not
  // place an order if it tried.
  const market = new HyperliquidClient({ network: "mainnet" });

  // LIVE: swap these two lines for a HyperliquidClient with a signer and an
  // account address, and read live-check first. Everything else is unchanged.
  const store = new MemoryPaperStore();
  const trade: TradingClient = new PaperClient({
    market,
    startingBalanceUsd: 10_000,
    builderFeeTenthsBps: REINS_BUILDER.feeTenthsBps,
    store,
  });

  const engine = new RiskEngine(LIMITS);
  const log = new MemoryDecisionLog();
  const deps: BotDeps = { trade, market, engine, log, strategy: movingAverageCross };

  console.log(`paper bot on ${SYMBOL}: $${LIMITS.maxPositionUsd} cap, $${LIMITS.maxTradeRiskUsd} per trade`);
  for (;;) {
    try {
      console.log(`${new Date().toISOString().slice(11, 19)}  ${await runOnce(deps)}`);
    } catch (error) {
      console.error(`${new Date().toISOString().slice(11, 19)}  error: ${String(error)}`);
    }
    if (values.once) break;
    await sleep(INTERVAL_MS);
  }

  const state = await trade.accountState();
  const written = await log.read(50);
  console.log(`\nequity $${state.accountValueUsd.toFixed(2)}, ${written.length} decisions logged`);
}

// pathToFileURL rather than string building: on Windows the url is
// file:///C:/... and a hand-made one does not match, so the bot would exit
// silently having done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
