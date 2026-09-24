/**
 * The HTTP face of the same tools: routing, validation, the token, and the
 * fact that every limit still applies to a bot that never speaks MCP.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDecisionLog } from "./decision-log.js";
import { createHttpApi, type ApiRequest } from "./http-api.js";
import { PaperClient } from "./paper.js";
import { RiskEngine } from "./risk.js";
import type { McpServerDeps } from "./mcp-server.js";
import type { MarketDataSource } from "./trading-client.js";
import type { BookLevel, Candle, L2Book } from "./types.js";

const TOKEN = "a-token-at-least-16-chars";
const START = Date.UTC(2026, 8, 24, 12);

function book(bid: number, ask: number): L2Book {
  const level = (px: number): BookLevel => ({ px: String(px), sz: "10", n: 1 });
  return { coin: "ETH", time: START, levels: [[level(bid)], [level(ask)]] };
}

class FakeMarket implements MarketDataSource {
  current = book(2643, 2643.5);
  async l2Book(): Promise<L2Book> {
    return this.current;
  }
  async candles(): Promise<Candle[]> {
    return [
      { t: START, T: START + 59_999, s: "ETH", i: "1m", o: "2640", c: "2643", h: "2645", l: "2639", v: "12", n: 3 },
    ];
  }
  async assetInfo(symbol: string) {
    return { name: symbol, szDecimals: 4, maxLeverage: 50, index: 1 };
  }
}

let paper: PaperClient;
let log: MemoryDecisionLog;
let api: (request: ApiRequest) => Promise<{ status: number; body: unknown }>;

beforeEach(() => {
  paper = new PaperClient({ market: new FakeMarket(), startingBalanceUsd: 10_000, now: () => START });
  log = new MemoryDecisionLog();
  const deps: McpServerDeps = {
    client: paper,
    engine: new RiskEngine({
      maxPositionUsd: 2_500,
      maxLeverage: 3,
      dailyLossLimitUsd: 300,
      symbolAllowlist: ["ETH"],
      maxOrdersPerMinute: 12,
      requireStopLoss: true,
      maxTradeRiskUsd: 30,
    }),
    log,
    now: () => START,
  };
  api = createHttpApi(deps, { token: TOKEN, mode: "paper", network: "mainnet" });
});

// `null` means the caller sent no token at all; a default parameter would
// quietly put the real one back.
const sent = (token: string | null | undefined) => (token === null ? undefined : (token ?? TOKEN));
const get = (path: string, query: Record<string, string> = {}, token?: string | null) =>
  api({ method: "GET", path, query, token: sent(token) });
const post = (path: string, body: unknown, token?: string | null) =>
  api({ method: "POST", path, body, token: sent(token) });

const buy = { symbol: "ETH", side: "buy", sizeUsd: 1_000, stopLoss: 2620, reason: "Breakout held." };

describe("the token", () => {
  it("is not needed to ask what this is", async () => {
    const answer = await get("/health", {}, null);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, mode: "paper", network: "mainnet" });
  });

  it("is needed for everything else, including reads", async () => {
    expect(await get("/limits", {}, null)).toMatchObject({ status: 401 });
    expect(await get("/positions", {}, "wrong-token-but-long-enough")).toMatchObject({ status: 401 });
    expect(await post("/orders", buy, null)).toMatchObject({ status: 401 });
    expect((await paper.snapshot()).fills).toHaveLength(0);
  });
});

describe("reading", () => {
  it("serves the limits a bot must size against", async () => {
    const answer = await get("/limits");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      limits: { maxPositionUsd: 2_500, maxTradeRiskUsd: 30, requireStopLoss: true },
      halted: false,
    });
  });

  it("serves the book, positions, candles and the log", async () => {
    expect(await get("/book", { symbol: "ETH", depth: "1" })).toMatchObject({
      status: 200,
      body: { bestBid: 2643, bestAsk: 2643.5 },
    });
    expect(await get("/positions")).toMatchObject({ status: 200, body: { positionsUsd: {} } });
    expect(await get("/candles", { symbol: "ETH", interval: "1m", count: "1" })).toMatchObject({ status: 200 });
    expect(await get("/decisions", { limit: "5" })).toMatchObject({ status: 200, body: { decisions: [] } });
  });

  it("names the intervals it takes rather than passing a wrong one through", async () => {
    expect(await get("/candles", { symbol: "ETH", interval: "7m" })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("1m, 5m, 15m, 1h, 4h, 1d") },
    });
  });
});

describe("placing orders", () => {
  it("places one, with its stop, and writes the reason to the log", async () => {
    const answer = await post("/orders", buy);
    expect(answer).toMatchObject({ status: 200, body: { kind: "filled", stopLoss: { triggerPrice: 2620 } } });
    expect(log.records.map((r) => r.tool)).toEqual(["place_order", "set_stop_loss"]);
    expect(log.records[0]!.reason).toBe("Breakout held.");
  });

  it("applies every limit the agent gets: stop required, risk cap, allowlist", async () => {
    const noStop = await post("/orders", { symbol: "ETH", side: "buy", sizeUsd: 1_000, reason: "no stop" });
    expect(noStop).toMatchObject({ status: 400, body: { error: expect.stringContaining("NO_STOP_LOSS") } });

    const tooFar = await post("/orders", { ...buy, stopLoss: 2500 });
    expect(tooFar).toMatchObject({ status: 400, body: { error: expect.stringContaining("TRADE_RISK_TOO_LARGE") } });

    const offList = await post("/orders", { ...buy, symbol: "DOGE", stopLoss: 0.1 });
    expect(offList).toMatchObject({ status: 400, body: { error: expect.stringContaining("SYMBOL_NOT_ALLOWED") } });

    expect((await paper.snapshot()).fills).toHaveLength(0);
  });

  it("insists on the fields it needs, before anything reaches the exchange", async () => {
    expect(await post("/orders", { symbol: "ETH", side: "buy", sizeUsd: 100 })).toMatchObject({
      status: 400,
      body: { error: '"reason" is required.' },
    });
    expect(await post("/orders", { ...buy, side: "long" })).toMatchObject({
      status: 400,
      body: { error: '"side" must be "buy" or "sell".' },
    });
    expect(await post("/orders", { ...buy, sizeUsd: "some" })).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('"sizeUsd" must be a number') },
    });
    expect(await post("/orders", "not an object")).toMatchObject({
      status: 400,
      body: { error: "The body must be a JSON object." },
    });
    expect(log.records).toHaveLength(0);
  });
});

describe("managing what is open", () => {
  it("moves a stop and closes a position", async () => {
    await post("/orders", buy);
    expect(await post("/stops", { symbol: "ETH", triggerPrice: 2630, reason: "Trail it up." })).toMatchObject({
      status: 200,
      body: { stopLoss: { triggerPrice: 2630 } },
    });
    expect(await post("/close", { symbol: "ETH", reason: "Done." })).toMatchObject({
      status: 200,
      body: { closed: true },
    });
    expect((await paper.snapshot()).positions).toEqual({});
  });

  it("cancels a resting order by id", async () => {
    const placed = await post("/orders", { ...buy, price: 2600, stopLoss: 2580 });
    const oid = (placed.body as { oid: number }).oid;
    expect(await post("/cancel", { symbol: "ETH", orderId: oid, reason: "Stale." })).toMatchObject({
      status: 200,
      body: { cancelled: oid },
    });
  });
});

describe("routing", () => {
  it("lists what it serves when asked for something else", async () => {
    const answer = await get("/orders");
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ routes: expect.arrayContaining(["POST /orders"]) });
  });

  it("ignores a trailing slash", async () => {
    expect(await get("/limits/")).toMatchObject({ status: 200 });
  });
});
