import { describe, expect, it } from "vitest";
import { HyperliquidClient } from "./client.js";
import { MockTransport } from "./mock-transport.js";
import {
  closePosition,
  createMcpServer,
  getBook,
  getLimits,
  getPositions,
  marketablePrice,
  placeOrder,
  type McpServerDeps,
  type ToolResult,
} from "./mcp-server.js";
import { RiskEngine, type RiskLimits } from "./risk.js";
import { StubSigner } from "./signer.js";
import type { L2Book } from "./types.js";

const LIMITS: RiskLimits = {
  maxPositionUsd: 25_000,
  maxLeverage: 5,
  dailyLossLimitUsd: 2_500,
  symbolAllowlist: ["BTC", "ETH"],
  maxOrdersPerMinute: 12,
};

const META = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
  ],
};

const STATE = {
  assetPositions: [
    {
      position: {
        coin: "BTC",
        szi: "0.125",
        entryPx: "100000",
        positionValue: "12500",
        unrealizedPnl: "0",
        marginUsed: "2500",
      },
    },
  ],
  marginSummary: {
    accountValue: "13109.48",
    totalMarginUsed: "2500",
    totalNtlPos: "12500",
    totalRawUsd: "13000",
  },
  withdrawable: "10000",
};

const BOOK: L2Book = {
  coin: "BTC",
  time: 1_754_450_974_231,
  levels: [
    [
      { px: "100000", sz: "5", n: 10 },
      { px: "99990", sz: "8", n: 12 },
    ],
    [
      { px: "100010", sz: "4", n: 7 },
      { px: "100020", sz: "9", n: 11 },
    ],
  ],
};

const RESTING = {
  status: "ok",
  response: { type: "order", data: { statuses: [{ resting: { oid: 5150 } }] } },
};

function fillsWithPnl(closedPnl: string, fee = "0") {
  return [
    {
      coin: "BTC",
      px: "100000",
      sz: "0.1",
      side: "A",
      time: Date.now(),
      closedPnl,
      fee,
      dir: "Close Long",
      oid: 1,
      hash: "0xabc",
    },
  ];
}

function setup(options: { fills?: unknown; limits?: RiskLimits } = {}) {
  const transport = new MockTransport()
    .reply("info:meta", META)
    .reply("info:clearinghouseState", STATE)
    .reply("info:userFills", options.fills ?? [])
    .reply("info:l2Book", BOOK)
    .reply("exchange:order", RESTING)
    .reply("exchange:cancel", {
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] } },
    });

  const client = new HyperliquidClient({
    fetch: transport.fetch,
    signer: new StubSigner(),
  });
  const engine = new RiskEngine(options.limits ?? LIMITS);
  const deps: McpServerDeps = { client, engine };
  return { transport, client, engine, deps };
}

function text(result: ToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Tool returned no text content.");
  }
  return first.text;
}

function parse(result: ToolResult): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function lastOrder(transport: MockTransport) {
  const call = transport.callsTo("exchange:order").at(-1);
  if (!call) throw new Error("No order was sent.");
  const action = call.body["action"] as { orders: Record<string, unknown>[] };
  return action.orders[0]!;
}

describe("get_limits", () => {
  it("reports the limits, headroom and remaining loss budget", async () => {
    const { deps } = setup({ fills: fillsWithPnl("-400") });
    const body = parse(await getLimits(deps));

    expect(body["limits"]).toMatchObject({ maxPositionUsd: 25_000, maxLeverage: 5 });
    expect(body["halted"]).toBe(false);
    expect(body["realizedPnlTodayUsd"]).toBeCloseTo(-400, 2);
    // $2,500 limit with $400 already lost leaves $2,100.
    expect(body["lossRemainingUsd"]).toBeCloseTo(2_100, 2);
    expect(body["exposure"]).toMatchObject({
      BTC: { currentUsd: 12_500, headroomUsd: 12_500 },
    });
  });

  it("reports halted once the daily loss limit is breached", async () => {
    const { deps } = setup({ fills: fillsWithPnl("-2600") });
    expect(parse(await getLimits(deps))["halted"]).toBe(true);
  });

  it("hands out a copy of the limits, not the live object", async () => {
    const { engine } = setup();
    const copy = engine.configuredLimits;
    expect(() => {
      (copy as RiskLimits).maxPositionUsd = 1_000_000;
    }).toThrow();
    expect(engine.configuredLimits.maxPositionUsd).toBe(25_000);
  });
});

describe("get_positions", () => {
  it("returns signed notional and today's realised PnL net of fees", async () => {
    const { deps } = setup({ fills: fillsWithPnl("-100", "5") });
    const body = parse(await getPositions(deps));

    expect(body["positionsUsd"]).toEqual({ BTC: 12_500 });
    expect(body["realizedPnlTodayUsd"]).toBeCloseTo(-105, 2);
  });

  it("ignores fills from before today", async () => {
    const stale = [
      {
        coin: "BTC",
        px: "1",
        sz: "1",
        side: "A",
        time: Date.now() - 3 * 24 * 60 * 60 * 1000,
        closedPnl: "-9999",
        fee: "0",
        dir: "Close Long",
        oid: 1,
        hash: "0x",
      },
    ];
    const { deps } = setup({ fills: stale });
    expect(parse(await getPositions(deps))["realizedPnlTodayUsd"]).toBe(0);
  });
});

describe("get_book", () => {
  it("returns top of book and the spread", async () => {
    const { deps } = setup();
    const body = parse(await getBook(deps, { symbol: "BTC" }));

    expect(body["bestBid"]).toBe(100_000);
    expect(body["bestAsk"]).toBe(100_010);
    expect(body["spread"]).toBeCloseTo(10, 6);
  });

  it("honours the depth argument", async () => {
    const { deps } = setup();
    const body = parse(await getBook(deps, { symbol: "BTC", depth: 1 }));
    expect(body["bids"]).toHaveLength(1);
  });
});

describe("marketablePrice", () => {
  it("crosses upward to buy and downward to sell", () => {
    expect(marketablePrice(BOOK, "buy", 0.001)).toBeCloseTo(100_110.01, 2);
    expect(marketablePrice(BOOK, "sell", 0.001)).toBeCloseTo(99_900, 2);
  });

  it("throws when the relevant side is empty", () => {
    const empty: L2Book = { ...BOOK, levels: [[], []] };
    expect(() => marketablePrice(empty, "buy", 0.001)).toThrow(/No ask liquidity/);
  });
});

describe("place_order", () => {
  it("sends an order that passes the risk check", async () => {
    const { deps, transport } = setup();
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      reason: "test rationale",
      sizeUsd: 5_000,
      price: 100_000,
    });

    expect(result.isError).toBeUndefined();
    expect(lastOrder(transport)).toMatchObject({ a: 0, b: true, r: false });
    // $5,000 at $100,000 is 0.05 BTC.
    expect(lastOrder(transport)["s"]).toBe("0.05");
  });

  it("refuses an order that breaches the position cap and sends nothing", async () => {
    const { deps, transport } = setup();
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      reason: "test rationale",
      sizeUsd: 20_000,
      price: 100_000,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("BLOCKED (POSITION_TOO_LARGE)");
    expect(transport.callsTo("exchange:order")).toHaveLength(0);
  });

  it("refuses a symbol that is not on the allowlist", async () => {
    const { deps } = setup();
    const result = await placeOrder(deps, {
      symbol: "DOGE",
      side: "buy",
      reason: "test rationale",
      sizeUsd: 100,
      price: 0.1,
    });
    expect(text(result)).toContain("BLOCKED (SYMBOL_NOT_ALLOWED)");
  });

  it("does not spend rate-limit budget on a blocked order", async () => {
    const { deps, engine } = setup();
    const before = engine.ordersRemaining();
    await placeOrder(deps, { symbol: "BTC", side: "buy", reason: "r", sizeUsd: 99_000, price: 100_000 });
    expect(engine.ordersRemaining()).toBe(before);
  });

  it("spends rate-limit budget on an accepted order", async () => {
    const { deps, engine } = setup();
    const before = engine.ordersRemaining();
    await placeOrder(deps, { symbol: "BTC", side: "buy", reason: "r", sizeUsd: 1_000, price: 100_000 });
    expect(engine.ordersRemaining()).toBe(before - 1);
  });

  it("crosses the book and uses Ioc when no price is given", async () => {
    const { deps, transport } = setup();
    await placeOrder(deps, { symbol: "BTC", side: "buy", reason: "r", sizeUsd: 1_000 });

    const order = lastOrder(transport);
    expect(order["t"]).toEqual({ limit: { tif: "Ioc" } });
    expect(Number(order["p"])).toBeGreaterThan(100_010);
  });

  it("defaults to Gtc for an explicit limit price", async () => {
    const { deps, transport } = setup();
    await placeOrder(deps, { symbol: "BTC", side: "buy", reason: "r", sizeUsd: 1_000, price: 99_000 });
    expect(lastOrder(transport)["t"]).toEqual({ limit: { tif: "Gtc" } });
  });

  it("surfaces an exchange rejection as a tool error", async () => {
    const { deps, transport } = setup();
    transport.reply("exchange:order", {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ error: "Order must have minimum value of $10." }] },
      },
    });
    // Two queued replies: the first is consumed, leaving the rejection.
    await placeOrder(deps, { symbol: "BTC", side: "buy", reason: "r", sizeUsd: 1_000, price: 99_000 });
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      reason: "test rationale",
      sizeUsd: 1_000,
      price: 99_000,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("minimum value of $10");
  });

  it("turns a transport failure into a tool error rather than throwing", async () => {
    const { deps, transport } = setup();
    transport.failWith(503, "upstream down");
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      reason: "test rationale",
      sizeUsd: 1_000,
      price: 99_000,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Request failed");
  });
});

describe("close_position", () => {
  it("sells a long with a reduce-only order", async () => {
    const { deps, transport } = setup();
    const result = await closePosition(deps, { symbol: "BTC", reason: "test rationale" });

    expect(result.isError).toBeUndefined();
    expect(parse(result)["closed"]).toBe(true);
    expect(lastOrder(transport)).toMatchObject({ b: false, r: true });
  });

  it("is permitted even when the daily loss limit has halted trading", async () => {
    const { deps, transport } = setup({ fills: fillsWithPnl("-5000") });
    const result = await closePosition(deps, { symbol: "BTC", reason: "test rationale" });

    expect(result.isError).toBeUndefined();
    expect(lastOrder(transport)["r"]).toBe(true);
  });

  it("reports no position rather than erroring when already flat", async () => {
    const { deps } = setup();
    const result = await closePosition(deps, { symbol: "ETH", reason: "test rationale" });

    expect(result.isError).toBeUndefined();
    expect(parse(result)).toMatchObject({ closed: false });
  });
});

describe("server wiring", () => {
  it("registers every tool without the SDK rejecting a schema", () => {
    const { deps } = setup();
    expect(() => createMcpServer(deps)).not.toThrow();
  });
});
