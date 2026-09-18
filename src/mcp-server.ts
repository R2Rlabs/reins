import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  createIdFactory,
  riskOf,
  type DecisionContext,
  type DecisionLog,
  type DecisionRecord,
} from "./decision-log.js";
import type { AccountState, Decision, OrderRequest, RiskEngine } from "./risk.js";
import type { TradingClient } from "./trading-client.js";
import type { L2Book } from "./types.js";

export interface McpServerDeps {
  /** A live client or a paper one — the tools cannot tell the difference. */
  client: TradingClient;
  engine: RiskEngine;
  /** Where attempted actions and their stated reasons are written. */
  log?: DecisionLog;
  /**
   * How far to cross the book on market-style orders, as a fraction. Closes
   * use double this, because getting flat matters more than the last basis
   * point of price.
   */
  crossBuffer?: number;
  now?: () => number;
  newId?: () => string;
}

const DEFAULT_CROSS_BUFFER = 0.001;

/** The SDK's own result type — a union, so don't hand-roll a narrower one. */
export type ToolResult = CallToolResult;

function ok(data: unknown, logWarning?: string): ToolResult {
  const body = logWarning === undefined ? data : { ...(data as object), logWarning };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * A blocked order is reported as an error so the agent actually notices, with
 * the specific reason attached so it can correct itself rather than retrying
 * the same rejected order.
 */
function blocked(
  decision: Extract<Decision, { allowed: false }>,
  logWarning?: string,
): ToolResult {
  const suffix = logWarning === undefined ? "" : `\n[decision log: ${logWarning}]`;
  return fail(`BLOCKED (${decision.code}): ${decision.reason}${suffix}`);
}

const defaultIds = createIdFactory();

function contextOf(state: AccountState): DecisionContext {
  return {
    accountValueUsd: round(state.accountValueUsd),
    realizedPnlTodayUsd: round(state.realizedPnlTodayUsd),
    positionsUsd: Object.fromEntries(
      Object.entries(state.positionsUsd).map(([k, v]) => [k, round(v)]),
    ),
  };
}

/**
 * Write a record, returning a warning string instead of throwing.
 *
 * A failed log write must never turn a filled order into a reported failure.
 * An agent told its order failed will place it again, so losing a log line
 * would become a doubled position — which is far worse than the missing line.
 * The write is therefore best-effort and loud, never fatal.
 */
async function recordSafely(
  deps: McpServerDeps,
  record: DecisionRecord,
): Promise<string | undefined> {
  if (!deps.log) return undefined;
  try {
    await deps.log.append(record);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not be written: ${message}`;
  }
}

function startRecord(
  deps: McpServerDeps,
  tool: DecisionRecord["tool"],
  reason: string,
  request: Record<string, unknown>,
): DecisionRecord {
  const now = deps.now ?? Date.now;
  return {
    id: (deps.newId ?? defaultIds)(),
    time: new Date(now()).toISOString(),
    tool,
    reason,
    request,
  };
}

/** Turn any thrown error into a tool error rather than a protocol failure. */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Request failed: ${message}`);
  }
}

function bestBid(book: L2Book): number | undefined {
  const level = book.levels[0]?.[0];
  return level ? Number(level.px) : undefined;
}

function bestAsk(book: L2Book): number | undefined {
  const level = book.levels[1]?.[0];
  return level ? Number(level.px) : undefined;
}

/**
 * A limit price that should cross the spread immediately. Used instead of a
 * true market order so the agent can never be filled at an unbounded price.
 */
export function marketablePrice(
  book: L2Book,
  side: "buy" | "sell",
  buffer: number,
): number {
  const price = side === "buy" ? bestAsk(book) : bestBid(book);
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    throw new Error(`No ${side === "buy" ? "ask" : "bid"} liquidity in the book.`);
  }
  return side === "buy" ? price * (1 + buffer) : price * (1 - buffer);
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buffer(deps: McpServerDeps): number {
  return deps.crossBuffer ?? DEFAULT_CROSS_BUFFER;
}

// --- tool implementations ---------------------------------------------------
// Exported individually so they can be tested without standing up a transport.

export function getLimits(deps: McpServerDeps): Promise<ToolResult> {
  return guard(async () => {
    const state = await deps.client.accountState();
    const limits = deps.engine.configuredLimits;
    const exposure = Object.fromEntries(
      Object.entries(state.positionsUsd).map(([symbol, usd]) => [
        symbol,
        {
          currentUsd: round(usd),
          headroomUsd: round(limits.maxPositionUsd - Math.abs(usd)),
        },
      ]),
    );
    return ok({
      limits,
      halted: deps.engine.isHalted(state),
      realizedPnlTodayUsd: round(state.realizedPnlTodayUsd),
      lossRemainingUsd: round(
        limits.dailyLossLimitUsd + Math.min(0, state.realizedPnlTodayUsd),
      ),
      ordersRemainingThisMinute: deps.engine.ordersRemaining(),
      accountValueUsd: round(state.accountValueUsd),
      exposure,
    });
  });
}

/**
 * Which positions have a stop-loss, and which do not. A position counts as
 * protected only when its stops cover all of it: a stop sized for a position
 * that has since grown leaves the rest exposed.
 */
async function protection(deps: McpServerDeps) {
  const [positions, stops] = await Promise.all([
    deps.client.openPositions(),
    deps.client.stopLosses(),
  ]);
  const unprotected: string[] = [];
  for (const [symbol, { size }] of Object.entries(positions)) {
    const closing = size > 0 ? "sell" : "buy";
    const covered = stops
      .filter((stop) => stop.symbol === symbol && stop.side === closing)
      .reduce((sum, stop) => sum + stop.size, 0);
    if (covered < Math.abs(size) * 0.999) unprotected.push(symbol);
  }
  return { positions, stops, unprotected };
}

/** Account state plus what the stop-loss rule needs to see. */
async function stateForRisk(deps: McpServerDeps): Promise<AccountState> {
  const state = await deps.client.accountState();
  if (!deps.engine.configuredLimits.requireStopLoss) return state;
  const { unprotected } = await protection(deps);
  return { ...state, unprotectedSymbols: unprotected };
}

export function getPositions(deps: McpServerDeps): Promise<ToolResult> {
  return guard(async () => {
    const state = await deps.client.accountState();
    const { stops, unprotected } = await protection(deps);
    return ok({
      positionsUsd: Object.fromEntries(
        Object.entries(state.positionsUsd).map(([k, v]) => [k, round(v)]),
      ),
      accountValueUsd: round(state.accountValueUsd),
      realizedPnlTodayUsd: round(state.realizedPnlTodayUsd),
      stopLosses: stops.map((stop) => ({
        orderId: stop.oid,
        symbol: stop.symbol,
        side: stop.side,
        size: stop.size,
        triggerPrice: stop.triggerPrice,
      })),
      unprotected,
    });
  });
}

/**
 * Put a stop-loss under the whole of a symbol's position, replacing any stop
 * already there. The new stop goes on before the old ones come off, so the
 * position is never left bare in between. Shared by set_stop_loss and by
 * place_order's stopLoss, which skips the rate limit: its entry already
 * passed it, and a filled position left without its stop is the worse outcome.
 */
async function placeProtectiveStop(
  deps: McpServerDeps,
  args: { symbol: string; triggerPrice: number; reason: string },
  options: { checkRisk: boolean },
): Promise<ToolResult> {
  const { positions, stops } = await protection(deps);
  const held = positions[args.symbol]?.size ?? 0;
  if (held === 0) return fail(`No open ${args.symbol} position to protect.`);
  const side = held > 0 ? "sell" : "buy";

  const book = await deps.client.l2Book(args.symbol);
  const touch = side === "sell" ? bestBid(book) : bestAsk(book);
  const wrongSide =
    touch !== undefined &&
    (side === "sell" ? args.triggerPrice >= touch : args.triggerPrice <= touch);
  if (wrongSide) {
    return fail(
      `A stop at ${args.triggerPrice} would trigger at once: the ${side === "sell" ? "bid" : "ask"} ` +
        `is ${touch}. A stop on a ${held > 0 ? "long" : "short"} goes ` +
        `${held > 0 ? "below" : "above"} the market. To exit now, use close_position.`,
    );
  }

  const state = await deps.client.accountState();
  const replaced = stops.filter((stop) => stop.symbol === args.symbol).map((stop) => stop.oid);
  const record = startRecord(deps, "set_stop_loss", args.reason, {
    symbol: args.symbol,
    side,
    size: Math.abs(held),
    triggerPrice: args.triggerPrice,
    replaces: replaced,
  });
  record.context = contextOf(state);

  if (options.checkRisk) {
    const decision = deps.engine.check(
      {
        symbol: args.symbol,
        side,
        sizeUsd: Math.abs(state.positionsUsd[args.symbol] ?? held * args.triggerPrice),
        reduceOnly: true,
      },
      state,
    );
    record.risk = riskOf(decision);
    if (!decision.allowed) return blocked(decision, await recordSafely(deps, record));
  }

  let outcome;
  try {
    outcome = await deps.client.placeStopLoss({
      symbol: args.symbol,
      side,
      size: Math.abs(held),
      triggerPrice: args.triggerPrice,
    });
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    await recordSafely(deps, record);
    throw error;
  }
  deps.engine.recordOrder();
  record.outcome = outcome;

  if (outcome.kind !== "resting") {
    const warning = await recordSafely(deps, record);
    const message = outcome.kind === "rejected" ? outcome.message : `unexpected ${outcome.kind}`;
    return fail(
      `Exchange rejected the stop: ${message}` + (warning ? `\n[decision log: ${warning}]` : ""),
    );
  }

  const notCancelled: number[] = [];
  for (const oid of replaced) {
    const cancelled = await deps.client.cancelOrder(args.symbol, oid);
    if (cancelled.kind !== "cancelled") notCancelled.push(oid);
  }
  const warning = await recordSafely(deps, record);
  return ok(
    {
      stopLoss: { orderId: outcome.oid, symbol: args.symbol, side, size: Math.abs(held), triggerPrice: args.triggerPrice },
      replaced: replaced.filter((oid) => !notCancelled.includes(oid)),
      ...(notCancelled.length > 0
        ? { warning: `Could not cancel the old stop(s) ${notCancelled.join(", ")}; cancel them with cancel_order.` }
        : {}),
    },
    warning,
  );
}

export function setStopLoss(
  deps: McpServerDeps,
  args: { symbol: string; triggerPrice: number; reason: string },
): Promise<ToolResult> {
  return guard(() => placeProtectiveStop(deps, args, { checkRisk: true }));
}

export function getBook(
  deps: McpServerDeps,
  args: { symbol: string; depth?: number | undefined },
): Promise<ToolResult> {
  return guard(async () => {
    const book = await deps.client.l2Book(args.symbol);
    const n = args.depth ?? 5;
    const bid = bestBid(book);
    const ask = bestAsk(book);
    return ok({
      symbol: book.coin,
      bestBid: bid,
      bestAsk: ask,
      spread: bid !== undefined && ask !== undefined ? round(ask - bid, 6) : undefined,
      bids: (book.levels[0] ?? []).slice(0, n),
      asks: (book.levels[1] ?? []).slice(0, n),
    });
  });
}

/**
 * The intervals the agent is offered: minutes to days, without the long tail
 * the API also accepts.
 */
export const AGENT_CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type AgentCandleInterval = (typeof AGENT_CANDLE_INTERVALS)[number];

const MINUTE = 60_000;
const INTERVAL_MS: Record<AgentCandleInterval, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 240 * MINUTE,
  "1d": 1_440 * MINUTE,
};

/**
 * The most recent `count` candles, oldest first. The newest is usually still
 * forming, and says so: a half-built candle read as a finished one looks like
 * a sharp move that has not happened.
 */
export function getCandles(
  deps: McpServerDeps,
  args: {
    symbol: string;
    interval?: AgentCandleInterval | undefined;
    count?: number | undefined;
  },
): Promise<ToolResult> {
  return guard(async () => {
    const interval = args.interval ?? "1h";
    const count = args.count ?? 24;
    const now = (deps.now ?? Date.now)();
    const raw = await deps.client.candles(
      args.symbol,
      interval,
      now - count * INTERVAL_MS[interval],
      now,
    );
    const candles = raw.slice(-count);
    const last = candles.at(-1);
    return ok({
      symbol: args.symbol,
      interval,
      candles: candles.map((c) => ({
        time: new Date(c.t).toISOString(),
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v),
      })),
      lastCandleComplete: last ? last.T < now : undefined,
    });
  });
}

export interface PlaceOrderArgs {
  symbol: string;
  side: "buy" | "sell";
  sizeUsd: number;
  reason: string;
  price?: number | undefined;
  reduceOnly?: boolean | undefined;
  tif?: "Gtc" | "Ioc" | "Alo" | undefined;
  /** Trigger price of a stop-loss to put under the position once this fills. */
  stopLoss?: number | undefined;
}

export function placeOrder(
  deps: McpServerDeps,
  args: PlaceOrderArgs,
): Promise<ToolResult> {
  return guard(async () => {
    const explicitPrice = args.price;
    const marketable = explicitPrice === undefined;

    // Checked before anything is sent, so a bad stop never leaves a filled
    // entry behind it.
    if (args.stopLoss !== undefined) {
      if (args.reduceOnly) return fail("A reduce-only order closes risk; it takes no stopLoss.");
      if (!marketable) {
        return fail(
          "stopLoss goes on an order that fills now (no price). For a resting order, " +
            "call set_stop_loss once it has filled.",
        );
      }
    }

    const limitPrice =
      explicitPrice ??
      marketablePrice(await deps.client.l2Book(args.symbol), args.side, buffer(deps));

    if (args.stopLoss !== undefined) {
      const wrongSide = args.side === "buy" ? args.stopLoss >= limitPrice : args.stopLoss <= limitPrice;
      if (wrongSide) {
        return fail(
          `A stopLoss for a ${args.side} goes ${args.side === "buy" ? "below" : "above"} ` +
            `the entry (${round(limitPrice, 6)}), got ${args.stopLoss}.`,
        );
      }
    }

    const state = await stateForRisk(deps);
    const request: OrderRequest = {
      symbol: args.symbol,
      side: args.side,
      sizeUsd: args.sizeUsd,
      marketable,
      hasStopLoss: args.stopLoss !== undefined,
    };
    if (args.reduceOnly !== undefined) request.reduceOnly = args.reduceOnly;

    // Logged as sent: without it, a post-only order the market refused reads
    // like an Ioc that found no liquidity.
    const tif = args.tif ?? (marketable ? "Ioc" : "Gtc");
    const record = startRecord(deps, "place_order", args.reason, {
      symbol: args.symbol,
      side: args.side,
      sizeUsd: args.sizeUsd,
      limitPrice: round(limitPrice, 6),
      marketable,
      reduceOnly: args.reduceOnly ?? false,
      tif,
      ...(args.stopLoss !== undefined ? { stopLoss: args.stopLoss } : {}),
    });
    record.context = contextOf(state);

    const decision = deps.engine.check(request, state);
    record.risk = riskOf(decision);

    if (!decision.allowed) {
      return blocked(decision, await recordSafely(deps, record));
    }

    let outcome;
    try {
      outcome = await deps.client.placeOrder({
        symbol: args.symbol,
        side: args.side,
        size: args.sizeUsd / limitPrice,
        price: limitPrice,
        reduceOnly: args.reduceOnly ?? false,
        tif,
      });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      await recordSafely(deps, record);
      throw error;
    }
    deps.engine.recordOrder();

    record.outcome = outcome;
    const warning = await recordSafely(deps, record);

    if (outcome.kind === "rejected") return fail(`Exchange rejected the order: ${outcome.message}`);
    const result = { ...outcome, sizeUsd: args.sizeUsd, limitPrice: round(limitPrice, 6) };
    if (args.stopLoss === undefined || outcome.kind !== "filled") return ok(result, warning);

    // The entry filled, so it stands whatever happens next. A stop that fails
    // is reported loudly rather than turned into a failed order, which the
    // agent would place again.
    let stop: ToolResult;
    try {
      stop = await placeProtectiveStop(
        deps,
        {
          symbol: args.symbol,
          triggerPrice: args.stopLoss,
          reason: `Stop for order ${outcome.oid}: ${args.reason}`,
        },
        { checkRisk: false },
      );
    } catch (error) {
      stop = fail(error instanceof Error ? error.message : String(error));
    }
    const stopText = stop.content[0]?.type === "text" ? stop.content[0].text : "";
    return ok(
      stop.isError
        ? {
            ...result,
            stopLossWarning:
              `The order filled but its stop-loss was not placed: ${stopText} ` +
              `The position is unprotected; call set_stop_loss.`,
          }
        : { ...result, stopLoss: (JSON.parse(stopText) as { stopLoss: unknown }).stopLoss },
      warning,
    );
  });
}

export function cancelOrder(
  deps: McpServerDeps,
  args: { symbol: string; orderId: number; reason?: string | undefined },
): Promise<ToolResult> {
  return guard(async () => {
    const record = startRecord(deps, "cancel_order", args.reason ?? "", {
      symbol: args.symbol,
      orderId: args.orderId,
    });
    const outcome = await deps.client.cancelOrder(args.symbol, args.orderId);
    record.outcome = outcome;
    const warning = await recordSafely(deps, record);

    return outcome.kind === "rejected"
      ? fail(`Could not cancel: ${outcome.message}`)
      : ok({ cancelled: args.orderId }, warning);
  });
}

export function closePosition(
  deps: McpServerDeps,
  args: { symbol: string; reason: string },
): Promise<ToolResult> {
  return guard(async () => {
    const state = await deps.client.accountState();
    const current = state.positionsUsd[args.symbol] ?? 0;
    if (current === 0) {
      return ok({ closed: false, detail: `No open ${args.symbol} position.` });
    }

    const side = current > 0 ? "sell" : "buy";
    const limitPrice = marketablePrice(
      await deps.client.l2Book(args.symbol),
      side,
      buffer(deps) * 2,
    );
    const sizeUsd = Math.abs(current);

    const record = startRecord(deps, "close_position", args.reason, {
      symbol: args.symbol,
      side,
      sizeUsd: round(sizeUsd),
      limitPrice: round(limitPrice, 6),
      tif: "Ioc",
    });
    record.context = contextOf(state);

    const decision = deps.engine.check(
      { symbol: args.symbol, side, sizeUsd, reduceOnly: true },
      state,
    );
    record.risk = riskOf(decision);
    if (!decision.allowed) {
      return blocked(decision, await recordSafely(deps, record));
    }

    let outcome;
    try {
      outcome = await deps.client.placeOrder({
        symbol: args.symbol,
        side,
        size: sizeUsd / limitPrice,
        price: limitPrice,
        reduceOnly: true,
        tif: "Ioc",
      });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      await recordSafely(deps, record);
      throw error;
    }
    deps.engine.recordOrder();

    record.outcome = outcome;
    const warning = await recordSafely(deps, record);

    if (outcome.kind === "rejected") return fail(`Exchange rejected the close: ${outcome.message}`);

    // A stop left behind a closed position would sit on the exchange with
    // nothing to protect. Best effort: the close itself has already happened.
    const cancelledStops: number[] = [];
    try {
      const { positions, stops } = await protection(deps);
      if (!positions[args.symbol]) {
        for (const stop of stops.filter((s) => s.symbol === args.symbol)) {
          const cancelled = await deps.client.cancelOrder(args.symbol, stop.oid);
          if (cancelled.kind === "cancelled") cancelledStops.push(stop.oid);
        }
      }
    } catch {
      // Reported by get_positions if it matters.
    }
    return ok(
      {
        closed: true,
        ...outcome,
        sizeUsd: round(sizeUsd),
        ...(cancelledStops.length > 0 ? { cancelledStopLosses: cancelledStops } : {}),
      },
      warning,
    );
  });
}

export function getRecentDecisions(
  deps: McpServerDeps,
  args: { limit?: number | undefined },
): Promise<ToolResult> {
  return guard(async () => {
    if (!deps.log) {
      return ok({ decisions: [], detail: "No decision log is configured." });
    }
    const records = await deps.log.read(Math.min(args.limit ?? 10, 50));
    return ok({ decisions: records });
  });
}

// --- wiring -----------------------------------------------------------------

export const TOOL_NAMES = [
  "get_limits",
  "get_positions",
  "get_book",
  "get_candles",
  "place_order",
  "set_stop_loss",
  "cancel_order",
  "close_position",
  "get_recent_decisions",
] as const;

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "reins", version: "0.0.1" });

  server.registerTool(
    "get_limits",
    {
      title: "Get trading limits",
      description:
        "Report the risk limits this account trades under and how much room is left " +
        "against each of them. These limits are enforced outside you and no tool " +
        "changes them — check here before sizing an order rather than discovering a " +
        "limit by being rejected.",
    },
    () => getLimits(deps),
  );

  server.registerTool(
    "get_positions",
    {
      title: "Get open positions",
      description:
        "Open positions with their signed notional in USD (negative is short), " +
        "account value, and realised PnL so far today.",
    },
    () => getPositions(deps),
  );

  server.registerTool(
    "get_book",
    {
      title: "Get order book",
      description:
        "Top of book for a symbol: best bid, best ask, spread, and the nearest " +
        "levels on each side.",
      inputSchema: z.object({
        symbol: z.string().describe("Perp symbol, for example BTC or ETH."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many levels per side to return. Defaults to 5."),
      }),
    },
    (args) => getBook(deps, args),
  );

  server.registerTool(
    "get_candles",
    {
      title: "Get price candles",
      description:
        "Recent price history for a symbol as candles, oldest first: open, high, " +
        "low, close and volume for each interval. The newest candle is usually " +
        "still forming — lastCandleComplete says whether it has closed.",
      inputSchema: z.object({
        symbol: z.string().describe("Perp symbol, for example BTC or ETH."),
        interval: z
          .enum(AGENT_CANDLE_INTERVALS)
          .optional()
          .describe("Length of each candle. Defaults to 1h."),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many of the most recent candles to return. Defaults to 24."),
      }),
    },
    (args) => getCandles(deps, args),
  );

  server.registerTool(
    "place_order",
    {
      title: "Place an order",
      description:
        "Place an order sized in USD notional. Every order is checked against the " +
        "risk limits first; if it breaches one it is refused and nothing reaches the " +
        "exchange. Omit `price` for a marketable order that crosses the spread. " +
        "Both the order and your stated reason are written to a permanent log, " +
        "including when the order is refused.",
      inputSchema: z.object({
        symbol: z.string().describe("Perp symbol, for example BTC."),
        side: z.enum(["buy", "sell"]),
        sizeUsd: z.number().positive().describe("Notional size in USD, not asset units."),
        reason: z
          .string()
          .min(1)
          .describe(
            "Why you are placing this order, in one or two sentences. State the " +
              "signal or condition you are acting on and why this size. A human " +
              "will read this later to understand what you were doing, so write " +
              "what actually drove the decision rather than a generic summary.",
          ),
        price: z
          .number()
          .positive()
          .optional()
          .describe("Limit price. Omit to cross the spread and fill now."),
        reduceOnly: z
          .boolean()
          .optional()
          .describe("True if this order may only shrink an existing position."),
        tif: z
          .enum(["Gtc", "Ioc", "Alo"])
          .optional()
          .describe("Time in force. Defaults to Ioc when marketable, Gtc otherwise."),
        stopLoss: z
          .number()
          .positive()
          .optional()
          .describe(
            "Trigger price of a stop-loss to place under the whole position as soon as " +
              "this order fills. Only for orders without a price, which fill now; below " +
              "the entry for a buy, above it for a sell.",
          ),
      }),
    },
    (args) => placeOrder(deps, args),
  );

  server.registerTool(
    "set_stop_loss",
    {
      title: "Set a stop-loss",
      description:
        "Protect an open position with a stop-loss held on the exchange: once the price " +
        "reaches triggerPrice, the whole position is closed at market, whether or not " +
        "you are running at the time. Replaces any stop already on that symbol. Below " +
        "the market for a long, above it for a short. Logged with your reason, like an order.",
      inputSchema: z.object({
        symbol: z.string().describe("Perp symbol with an open position, for example ETH."),
        triggerPrice: z.number().positive().describe("Price at which the position is closed."),
        reason: z
          .string()
          .min(1)
          .describe(
            "Why this level: what would have to happen for your view to be wrong, in one " +
              "or two sentences. A human will read this later.",
          ),
      }),
    },
    (args) => setStopLoss(deps, args),
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an order",
      description: "Cancel a resting order by its exchange order id.",
      inputSchema: z.object({
        symbol: z.string(),
        orderId: z.number().int().describe("The oid returned when the order was placed."),
        reason: z.string().optional().describe("Why you are cancelling, if not obvious."),
      }),
    },
    (args) => cancelOrder(deps, args),
  );

  server.registerTool(
    "close_position",
    {
      title: "Close a position",
      description:
        "Flatten the whole position in one symbol with a reduce-only order that " +
        "crosses the spread. This reduces risk, so it is permitted even when the " +
        "daily loss limit has halted new trading.",
      inputSchema: z.object({
        symbol: z.string(),
        reason: z
          .string()
          .min(1)
          .describe("Why you are closing this position, in one or two sentences."),
      }),
    },
    (args) => closePosition(deps, args),
  );

  server.registerTool(
    "get_recent_decisions",
    {
      title: "Get recent decisions",
      description:
        "Your own recent actions and the reasons you gave for them, most recent " +
        "first, including any that the risk limits refused. Useful after a restart, " +
        "when you no longer remember what you already did.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many records to return. Defaults to 10."),
      }),
    },
    (args) => getRecentDecisions(deps, args),
  );

  return server;
}
