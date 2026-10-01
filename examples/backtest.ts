/**
 * Replay a strategy over real Hyperliquid candles, through the real risk
 * engine, paying real fees.
 *
 *   npm run build
 *   node examples/backtest.ts                       # BTC, 1h, 180 days
 *   node examples/backtest.ts --symbol ETH --days 90 --interval 4h
 *
 * ## What this is for
 *
 * Both demo runs went straight to paper and found their flaws by losing money:
 * run 1 tightened stops into chop, run 2 was a coin flip that paid $20.03 in
 * fees to lose $20.99. Neither needed five days to learn that. This answers the
 * same question in seconds, for free, before anything is risked.
 *
 * ## It is built to be pessimistic
 *
 * A backtester that flatters a strategy is worse than none, so:
 *
 * - **No lookahead.** The strategy sees bars up to and including the one that
 *   has closed, and never the bar it trades into.
 * - **Entries fill at the next bar's open**, not at the close it decided on.
 * - **Stops fill at the worse of the stop price and the next open**, because a
 *   gap through your stop fills where the market is, not where you asked.
 * - **Both sides pay taker fees by default.** A stop is a market order, and
 *   assuming maker fills on exits is the most common way a backtest lies.
 * - Nothing is modelled about depth. A size that would move the book is not
 *   something candles can tell you about.
 *
 * Even with all that, a backtest is the weakest evidence in the pipeline:
 * backtest, then paper forward on live prices, then small live. Each stage
 * kills ideas the next would have made expensive.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  BASE_MAKER_FEE_RATE,
  BASE_TAKER_FEE_RATE,
  HyperliquidClient,
  REINS_BUILDER,
  RiskEngine,
  type Candle,
  type CandleInterval,
  type RiskLimits,
} from "../dist/index.js";

/** What a strategy may see: closed bars only, oldest first. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type StrategySignal =
  | { action: "enter"; side: "buy" | "sell"; stop: number; reason: string }
  | { action: "exit"; reason: string }
  | { action: "hold" };

export type Strategy = (bars: Bar[], position: OpenPosition | null) => StrategySignal;

export interface OpenPosition {
  side: "buy" | "sell";
  entry: number;
  stop: number;
  sizeUsd: number;
  openedAt: number;
  reason: string;
}

export interface Trade {
  side: "buy" | "sell";
  entry: number;
  exit: number;
  sizeUsd: number;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  bars: number;
  exitKind: "stop" | "signal" | "end of data";
  reason: string;
}

export interface BacktestOptions {
  /** What is being traded — checked against the allowlist, not taken from it. */
  symbol: string;
  limits: RiskLimits;
  riskUsd: number;
  /** Charged on entry and exit. Both taker by default: a stop is a market order. */
  makerFeeRate?: number;
  takerFeeRate?: number;
  /** Tenths of a basis point, as Hyperliquid counts builder fees. */
  builderFeeTenthsBps?: number;
  /** Your own bot pays the builder fee to your own wallet, so it nets out. */
  builderFeeIsYours?: boolean;
}

export interface BacktestResult {
  trades: Trade[];
  refusals: Record<string, number>;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  maxDrawdownUsd: number;
  feeRateRoundTrip: number;
}

export function toBars(candles: Candle[]): Bar[] {
  return candles
    .map((c) => ({
      time: c.t,
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
      volume: Number(c.v),
    }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Run the strategy over the bars.
 *
 * The loop decides on bar `i` and acts on bar `i + 1`, which is the only
 * ordering that cannot see the future. Every order is checked by the same
 * RiskEngine the live server uses, so a strategy that only works when it
 * breaches a limit shows up here as refusals rather than profit.
 */
export function backtest(bars: Bar[], strategy: Strategy, options: BacktestOptions): BacktestResult {
  const taker = options.takerFeeRate ?? BASE_TAKER_FEE_RATE;
  const builderRate = options.builderFeeIsYours
    ? 0
    : (options.builderFeeTenthsBps ?? REINS_BUILDER.feeTenthsBps) / 100_000;
  const costPerSide = taker + builderRate;

  const engine = new RiskEngine(options.limits, () => 0); // no rate limit in replay
  const trades: Trade[] = [];
  const refusals: Record<string, number> = {};

  let position: OpenPosition | null = null;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  const close = (exit: number, bar: Bar, kind: Trade["exitKind"], reason: string) => {
    if (!position) return;
    const direction = position.side === "buy" ? 1 : -1;
    const move = ((exit - position.entry) / position.entry) * direction;
    const gross = move * position.sizeUsd;
    const fees = position.sizeUsd * costPerSide * 2;
    const net = gross - fees;
    trades.push({
      side: position.side,
      entry: position.entry,
      exit,
      sizeUsd: position.sizeUsd,
      grossUsd: gross,
      feesUsd: fees,
      netUsd: net,
      bars: Math.round((bar.time - position.openedAt) / Math.max(1, bars[1]!.time - bars[0]!.time)),
      exitKind: kind,
      reason,
    });
    equity += net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    position = null;
  };

  for (let i = 1; i < bars.length; i++) {
    const decided = bars.slice(0, i); // closed bars only
    const bar = bars[i]!;

    // Stops are checked before anything else: the market moves before the
    // strategy gets another say, and a stop that would have fired did fire.
    if (position) {
      const hit =
        position.side === "buy" ? bar.low <= position.stop : bar.high >= position.stop;
      if (hit) {
        // The worse of the stop and the open: a gap fills where the market is.
        const fill =
          position.side === "buy"
            ? Math.min(position.stop, bar.open)
            : Math.max(position.stop, bar.open);
        close(fill, bar, "stop", "stop fired");
        continue;
      }
    }

    const signal = strategy(decided, position);

    if (signal.action === "exit" && position) {
      close(bar.open, bar, "signal", signal.reason);
      continue;
    }

    if (signal.action === "enter" && !position) {
      const entry = bar.open;
      const distance = Math.abs(entry - signal.stop) / entry;
      if (distance <= 0) continue;
      const sizeUsd = Math.min(options.riskUsd / distance, options.limits.maxPositionUsd);

      const decision = engine.check(
        {
          symbol: options.symbol,
          side: signal.side,
          sizeUsd,
          hasStopLoss: true,
          riskUsd: options.riskUsd,
        },
        { positionsUsd: {}, realizedPnlTodayUsd: 0, accountValueUsd: options.limits.maxPositionUsd * 2 },
      );
      if (!decision.allowed) {
        refusals[decision.code] = (refusals[decision.code] ?? 0) + 1;
        continue;
      }

      position = {
        side: signal.side,
        entry,
        stop: signal.stop,
        sizeUsd,
        openedAt: bar.time,
        reason: signal.reason,
      };

      // The bar we entered on can also take us out. Entry is at its open, so
      // the stop is reached inside the same bar if its range covers it.
      const stoppedSameBar =
        signal.side === "buy" ? bar.low <= signal.stop : bar.high >= signal.stop;
      if (stoppedSameBar) close(signal.stop, bar, "stop", "stopped on the bar it opened");
    }
  }

  const last = bars.at(-1);
  if (position && last) close(last.close, last, "end of data", "still open when the data ran out");

  const gross = trades.reduce((sum, t) => sum + t.grossUsd, 0);
  const fees = trades.reduce((sum, t) => sum + t.feesUsd, 0);
  return {
    trades,
    refusals,
    grossUsd: gross,
    feesUsd: fees,
    netUsd: gross - fees,
    maxDrawdownUsd: maxDrawdown,
    feeRateRoundTrip: costPerSide * 2,
  };
}

/** The report. Gross and net are side by side because the gap is the point. */
export function report(result: BacktestResult, bars: Bar[], label: string): string {
  const { trades } = result;
  if (trades.length === 0) return `${label}: no trades. ${Object.entries(result.refusals).map(([k, v]) => `${k} x${v}`).join(", ") || "the strategy never fired."}`;

  const wins = trades.filter((t) => t.netUsd > 0);
  const avgSize = trades.reduce((s, t) => s + t.sizeUsd, 0) / trades.length;
  const held = trades.reduce((s, t) => s + t.bars, 0) / trades.length;
  const stopped = trades.filter((t) => t.exitKind === "stop").length;
  const days = (bars.at(-1)!.time - bars[0]!.time) / 86_400_000;
  // What the strategy must earn per round trip, before costs, to break even.
  const breakEvenBps = result.feeRateRoundTrip * 10_000;
  const grossBpsPerTrade = (result.grossUsd / trades.length / avgSize) * 10_000;

  return [
    `${label}`,
    `  ${trades.length} trades over ${days.toFixed(0)} days, ${wins.length} winners (${((wins.length / trades.length) * 100).toFixed(0)}%)`,
    `  average $${avgSize.toFixed(0)} held ${held.toFixed(1)} bars, ${stopped} closed by a stop`,
    ``,
    `  gross        ${result.grossUsd >= 0 ? "+" : ""}$${result.grossUsd.toFixed(2)}  (${grossBpsPerTrade >= 0 ? "+" : ""}${grossBpsPerTrade.toFixed(1)} bp per trade)`,
    `  fees         -$${result.feesUsd.toFixed(2)}  (${breakEvenBps.toFixed(1)} bp per round trip)`,
    `  net          ${result.netUsd >= 0 ? "+" : ""}$${result.netUsd.toFixed(2)}`,
    `  worst run    -$${result.maxDrawdownUsd.toFixed(2)}`,
    ``,
    `  To break even this needs ${breakEvenBps.toFixed(1)} bp per round trip before costs; it made ${grossBpsPerTrade.toFixed(1)}.`,
    Object.keys(result.refusals).length
      ? `  Refused: ${Object.entries(result.refusals).map(([k, v]) => `${k} x${v}`).join(", ")}`
      : ``,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- strategies to try -------------------------------------------------------

/** The illustration from examples/bot.ts, so the two agree on what it does. */
export function movingAverageCross(fast = 10, slow = 30, stopPct = 1): Strategy {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return (bars, position) => {
    if (bars.length < slow) return { action: "hold" };
    const closes = bars.map((b) => b.close);
    const f = mean(closes.slice(-fast));
    const s = mean(closes.slice(-slow));
    const price = closes.at(-1)!;
    if (position) return f > s ? { action: "hold" } : { action: "exit", reason: "cross back down" };
    return f > s
      ? { action: "enter", side: "buy", stop: price * (1 - stopPct / 100), reason: `${fast} over ${slow}` }
      : { action: "hold" };
  };
}

/** Buy a close above the highest high of the last `lookback` bars. */
export function breakout(lookback = 48, stopPct = 2): Strategy {
  return (bars, position) => {
    if (bars.length < lookback + 1) return { action: "hold" };
    const window = bars.slice(-lookback - 1, -1);
    const highest = Math.max(...window.map((b) => b.high));
    const price = bars.at(-1)!.close;
    if (position) {
      const lowest = Math.min(...window.map((b) => b.low));
      return price < lowest ? { action: "exit", reason: "broke the other way" } : { action: "hold" };
    }
    return price > highest
      ? { action: "enter", side: "buy", stop: price * (1 - stopPct / 100), reason: `${lookback}-bar high` }
      : { action: "hold" };
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: "string", default: "BTC" },
      interval: { type: "string", default: "1h" },
      days: { type: "string", default: "180" },
      risk: { type: "string", default: "25" },
      mine: { type: "boolean", default: true },
    },
  });

  const days = Number(values.days);
  const client = new HyperliquidClient({ network: "mainnet" });
  const end = Date.now();
  const candles = await client.candles(
    values.symbol!,
    values.interval as CandleInterval,
    end - days * 86_400_000,
    end,
  );
  const bars = toBars(candles);
  console.log(
    `${bars.length} ${values.interval} bars of ${values.symbol}, ` +
      `${new Date(bars[0]!.time).toISOString().slice(0, 10)} to ${new Date(bars.at(-1)!.time).toISOString().slice(0, 10)}\n`,
  );

  const options: BacktestOptions = {
    symbol: values.symbol!,
    limits: {
      maxPositionUsd: 2_500,
      maxLeverage: 3,
      dailyLossLimitUsd: 300,
      symbolAllowlist: [values.symbol!],
      maxOrdersPerMinute: 1_000,
      requireStopLoss: true,
      maxTradeRiskUsd: Number(values.risk) * 2,
    },
    riskUsd: Number(values.risk),
    // Your own bot pays the builder fee to your own wallet.
    builderFeeIsYours: values.mine,
  };

  // The benchmark that matters: every strategy below is long-only, so beating
  // fees is not the test — beating the move it rode is. Sized at the same
  // average notional a strategy uses, so the comparison is like for like.
  const first = bars[0]!.open;
  const last = bars.at(-1)!.close;
  const holdPct = ((last - first) / first) * 100;
  console.log(
    `buy and hold: ${values.symbol} went ${holdPct >= 0 ? "+" : ""}${holdPct.toFixed(1)}% ` +
      `(${first.toFixed(0)} to ${last.toFixed(0)}). One trade, two fees.
`,
  );

  for (const [label, strategy] of [
    ["10/30 moving-average cross, 1% stop", movingAverageCross(10, 30, 1)],
    ["10/30 cross, 2% stop", movingAverageCross(10, 30, 2)],
    ["48-bar breakout, 2% stop", breakout(48, 2)],
    ["96-bar breakout, 3% stop", breakout(96, 3)],
  ] as const) {
    console.log(report(backtest(bars, strategy, options), bars, label), "\n");
  }

  console.log(
    `Maker is ${(BASE_MAKER_FEE_RATE * 10_000).toFixed(1)} bp and taker ${(BASE_TAKER_FEE_RATE * 10_000).toFixed(1)} bp;` +
      ` both sides are charged taker here, because a stop is a market order.`,
  );
  console.log(
    [
      "Every strategy here is long-only. Over a period the market rose, that is not an edge:",
      "it is a worse way to be long. Compare each net result with buy and hold above, and",
      "treat anything that does not beat it as a strategy that cost you money to run.",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
