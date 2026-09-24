import {
  cancelOrder,
  closePosition,
  getBook,
  getCandles,
  getLimits,
  getPositions,
  getRecentDecisions,
  placeOrder,
  recordExchangeFills,
  setStopLoss,
  AGENT_CANDLE_INTERVALS,
  type AgentCandleInterval,
  type McpServerDeps,
  type ToolResult,
} from "./mcp-server.js";

/**
 * The same nine tools as plain HTTP, for anything that does not speak MCP.
 *
 * A bot in any language swaps "send this order to the exchange" for "send it
 * to Reins" and inherits the limits and the decision log without changing
 * anything else: every route here goes through the same risk engine and
 * writes the same records as the agent-facing tools.
 *
 * This module is the routing and the validation only — no sockets — so the
 * rules can be tested without opening a port. `src/bin/http.ts` serves it.
 */

export interface ApiRequest {
  method: string;
  /** Path only, no query string: "/orders". */
  path: string;
  query?: Record<string, string>;
  /** Parsed JSON body, if any. */
  body?: unknown;
  /** The bearer token the caller sent, if any. */
  token?: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export const API_ROUTES = [
  "GET /health",
  "GET /limits",
  "GET /positions",
  "GET /book",
  "GET /candles",
  "GET /decisions",
  "POST /orders",
  "POST /stops",
  "POST /cancel",
  "POST /close",
] as const;

class BadRequest extends Error {}

function body(request: ApiRequest): Record<string, unknown> {
  if (request.body === undefined || request.body === null) return {};
  if (typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new BadRequest("The body must be a JSON object.");
  }
  return request.body as Record<string, unknown>;
}

function str(source: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = source[name];
  if (value === undefined || value === "") {
    if (required) throw new BadRequest(`"${name}" is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new BadRequest(`"${name}" must be a string.`);
  return value;
}

function num(source: Record<string, unknown>, name: string, required = true): number | undefined {
  const value = source[name];
  if (value === undefined || value === "") {
    if (required) throw new BadRequest(`"${name}" is required.`);
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequest(`"${name}" must be a number, got ${JSON.stringify(value)}.`);
  return parsed;
}

function bool(source: Record<string, unknown>, name: string): boolean | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new BadRequest(`"${name}" must be true or false.`);
}

/**
 * A tool's answer as HTTP. The tools hand back text — JSON when they
 * succeeded, a sentence when they refused — and a refusal is the caller's
 * fault far more often than ours, so it becomes a 400 with the reason intact.
 */
function fromTool(result: ToolResult): ApiResponse {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  if (result.isError) return { status: 400, body: { error: text } };
  try {
    return { status: 200, body: JSON.parse(text) };
  } catch {
    return { status: 200, body: { result: text } };
  }
}

export interface HttpApiOptions {
  /** Required on every route but /health. */
  token: string;
  /** Answers /health, so a bot can tell live from paper before it trades. */
  mode?: "paper" | "live";
  network?: string;
}

/**
 * Builds the handler. Requests are served one at a time in the order they
 * arrive: the risk engine's rate limit and the "is this position protected"
 * checks both read state that a half-finished order would make wrong.
 */
export function createHttpApi(deps: McpServerDeps, options: HttpApiOptions) {
  let queue: Promise<unknown> = Promise.resolve();

  const handle = async (request: ApiRequest): Promise<ApiResponse> => {
    const route = `${request.method.toUpperCase()} ${request.path.replace(/\/+$/, "") || "/"}`;
    const query = request.query ?? {};

    if (route === "GET /health") {
      return {
        status: 200,
        body: {
          ok: true,
          mode: options.mode ?? "paper",
          ...(options.network ? { network: options.network } : {}),
          routes: [...API_ROUTES],
        },
      };
    }

    if (request.token !== options.token) {
      return { status: 401, body: { error: "Send the token as: Authorization: Bearer <token>." } };
    }

    // What the exchange did since the last request, before anything reads
    // positions: the same catch-up the MCP tools do.
    await recordExchangeFills(deps).catch(() => 0);

    switch (route) {
      case "GET /limits":
        return fromTool(await getLimits(deps));
      case "GET /positions":
        return fromTool(await getPositions(deps));
      case "GET /book": {
        const depth = num(query, "depth", false);
        return fromTool(
          await getBook(deps, { symbol: str(query, "symbol")!, ...(depth === undefined ? {} : { depth }) }),
        );
      }
      case "GET /candles": {
        const interval = str(query, "interval", false);
        if (interval !== undefined && !AGENT_CANDLE_INTERVALS.includes(interval as AgentCandleInterval)) {
          throw new BadRequest(`"interval" must be one of ${AGENT_CANDLE_INTERVALS.join(", ")}.`);
        }
        const count = num(query, "count", false);
        return fromTool(
          await getCandles(deps, {
            symbol: str(query, "symbol")!,
            ...(interval === undefined ? {} : { interval: interval as AgentCandleInterval }),
            ...(count === undefined ? {} : { count }),
          }),
        );
      }
      case "GET /decisions": {
        const limit = num(query, "limit", false);
        return fromTool(await getRecentDecisions(deps, limit === undefined ? {} : { limit }));
      }
      case "POST /orders": {
        const input = body(request);
        const side = str(input, "side")!;
        if (side !== "buy" && side !== "sell") throw new BadRequest('"side" must be "buy" or "sell".');
        const tif = str(input, "tif", false);
        if (tif !== undefined && !["Gtc", "Ioc", "Alo"].includes(tif)) {
          throw new BadRequest('"tif" must be "Gtc", "Ioc" or "Alo".');
        }
        const price = num(input, "price", false);
        const stopLoss = num(input, "stopLoss", false);
        const reduceOnly = bool(input, "reduceOnly");
        return fromTool(
          await placeOrder(deps, {
            symbol: str(input, "symbol")!,
            side,
            sizeUsd: num(input, "sizeUsd")!,
            // Required, as it is for the agent: an order nobody explained is
            // the one you cannot account for afterwards.
            reason: str(input, "reason")!,
            ...(price === undefined ? {} : { price }),
            ...(stopLoss === undefined ? {} : { stopLoss }),
            ...(reduceOnly === undefined ? {} : { reduceOnly }),
            ...(tif === undefined ? {} : { tif: tif as "Gtc" | "Ioc" | "Alo" }),
          }),
        );
      }
      case "POST /stops": {
        const input = body(request);
        return fromTool(
          await setStopLoss(deps, {
            symbol: str(input, "symbol")!,
            triggerPrice: num(input, "triggerPrice")!,
            reason: str(input, "reason")!,
          }),
        );
      }
      case "POST /cancel": {
        const input = body(request);
        const reason = str(input, "reason", false);
        return fromTool(
          await cancelOrder(deps, {
            symbol: str(input, "symbol")!,
            orderId: num(input, "orderId")!,
            ...(reason === undefined ? {} : { reason }),
          }),
        );
      }
      case "POST /close": {
        const input = body(request);
        return fromTool(
          await closePosition(deps, { symbol: str(input, "symbol")!, reason: str(input, "reason")! }),
        );
      }
      default:
        return { status: 404, body: { error: `No route ${route}.`, routes: [...API_ROUTES] } };
    }
  };

  return async (request: ApiRequest): Promise<ApiResponse> => {
    const mine = queue.then(() =>
      handle(request).catch((error: unknown) =>
        error instanceof BadRequest
          ? { status: 400, body: { error: error.message } }
          : { status: 500, body: { error: error instanceof Error ? error.message : String(error) } },
      ),
    );
    queue = mine.catch(() => undefined);
    return mine;
  };
}
