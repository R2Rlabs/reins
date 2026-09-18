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

export function getPositions(deps: McpServerDeps): Promise<ToolResult> {
  return guard(async () => {
    const state = await deps.client.accountState();
    return ok({
      positionsUsd: Object.fromEntries(
        Object.entries(state.positionsUsd).map(([k, v]) => [k, round(v)]),
      ),
      accountValueUsd: round(state.accountValueUsd),
      realizedPnlTodayUsd: round(state.realizedPnlTodayUsd),
    });
  });
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

export interface PlaceOrderArgs {
  symbol: string;
  side: "buy" | "sell";
  sizeUsd: number;
  reason: string;
  price?: number | undefined;
  reduceOnly?: boolean | undefined;
  tif?: "Gtc" | "Ioc" | "Alo" | undefined;
}

export function placeOrder(
  deps: McpServerDeps,
  args: PlaceOrderArgs,
): Promise<ToolResult> {
  return guard(async () => {
    const explicitPrice = args.price;
    const marketable = explicitPrice === undefined;
    const limitPrice =
      explicitPrice ??
      marketablePrice(await deps.client.l2Book(args.symbol), args.side, buffer(deps));

    const state = await deps.client.accountState();
    const request: OrderRequest = {
      symbol: args.symbol,
      side: args.side,
      sizeUsd: args.sizeUsd,
    };
    if (args.reduceOnly !== undefined) request.reduceOnly = args.reduceOnly;

    const record = startRecord(deps, "place_order", args.reason, {
      symbol: args.symbol,
      side: args.side,
      sizeUsd: args.sizeUsd,
      limitPrice: round(limitPrice, 6),
      marketable,
      reduceOnly: args.reduceOnly ?? false,
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
        tif: args.tif ?? (marketable ? "Ioc" : "Gtc"),
      });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      await recordSafely(deps, record);
      throw error;
    }
    deps.engine.recordOrder();

    record.outcome = outcome;
    const warning = await recordSafely(deps, record);

    return outcome.kind === "rejected"
      ? fail(`Exchange rejected the order: ${outcome.message}`)
      : ok(
          { ...outcome, sizeUsd: args.sizeUsd, limitPrice: round(limitPrice, 6) },
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

    return outcome.kind === "rejected"
      ? fail(`Exchange rejected the close: ${outcome.message}`)
      : ok({ closed: true, ...outcome, sizeUsd: round(sizeUsd) }, warning);
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
  "place_order",
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
      }),
    },
    (args) => placeOrder(deps, args),
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
