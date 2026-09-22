import { beforeEach, describe, expect, it } from "vitest";
import {
  HyperliquidApiError,
  HyperliquidClient,
  ReadOnlyClientError,
} from "./client.js";
import { MockTransport } from "./mock-transport.js";
import { StubSigner } from "./signer.js";
import type { ClearinghouseState, Meta, OrderAction } from "./types.js";

const META: Meta = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
  ],
};

const STATE: ClearinghouseState = {
  assetPositions: [
    {
      position: {
        coin: "ETH",
        szi: "-0.0335",
        entryPx: "2986.3",
        positionValue: "100.02765",
        unrealizedPnl: "-0.0134",
        marginUsed: "4.967826",
      },
    },
    {
      position: {
        coin: "BTC",
        szi: "0.25",
        entryPx: "50000",
        positionValue: "12500",
        unrealizedPnl: "35.5",
        marginUsed: "2500",
      },
    },
  ],
  marginSummary: {
    accountValue: "13109.482328",
    totalMarginUsed: "2504.967826",
    totalNtlPos: "12600.02765",
    totalRawUsd: "13009.454678",
  },
  withdrawable: "13104.514502",
};

const RESTING = {
  status: "ok",
  response: { type: "order", data: { statuses: [{ resting: { oid: 77738308 } }] } },
};

const FILLED = {
  status: "ok",
  response: {
    type: "order",
    data: { statuses: [{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77747314 } }] },
  },
};

let transport: MockTransport;
let signer: StubSigner;

beforeEach(() => {
  transport = new MockTransport().reply("info:meta", META).reply("info:userAbstraction", "disabled");
  signer = new StubSigner();
});

function client(overrides: Partial<ConstructorParameters<typeof HyperliquidClient>[0]> = {}) {
  return new HyperliquidClient({
    network: "testnet",
    fetch: transport.fetch,
    signer,
    ...overrides,
  });
}

function lastOrderAction(): OrderAction {
  const call = transport.callsTo("exchange:order").at(-1);
  if (!call) throw new Error("No order was sent.");
  return call.body["action"] as OrderAction;
}

describe("read-only mode", () => {
  it("reports itself read-only without a signer", () => {
    const c = new HyperliquidClient({ fetch: transport.fetch });
    expect(c.isReadOnly).toBe(true);
  });

  it("still serves market data", async () => {
    const c = new HyperliquidClient({ fetch: transport.fetch });
    await expect(c.assetInfo("BTC")).resolves.toMatchObject({ index: 0, szDecimals: 5 });
  });

  it("refuses to place an order", async () => {
    const c = new HyperliquidClient({ fetch: transport.fetch });
    await expect(
      c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 }),
    ).rejects.toBeInstanceOf(ReadOnlyClientError);
  });
});

describe("order construction", () => {
  it("builds the wire order the docs describe", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    expect(lastOrderAction()).toEqual({
      type: "order",
      grouping: "na",
      orders: [
        { a: 0, b: true, p: "50000", s: "0.1", r: false, t: { limit: { tif: "Gtc" } } },
      ],
    });
  });

  it("resolves the asset index from the universe", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "ETH", side: "sell", size: 1, price: 2986.34 });

    const order = lastOrderAction().orders[0];
    expect(order).toMatchObject({ a: 1, b: false, p: "2986.3" });
  });

  it("passes reduceOnly, tif and cloid through", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({
      symbol: "BTC",
      side: "sell",
      size: 0.1,
      price: 50_000,
      reduceOnly: true,
      tif: "Ioc",
      cloid: "0x1234",
    });

    expect(lastOrderAction().orders[0]).toMatchObject({
      r: true,
      t: { limit: { tif: "Ioc" } },
      c: "0x1234",
    });
  });

  it("omits cloid when none was given", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    expect(lastOrderAction().orders[0]).not.toHaveProperty("c");
  });

  it("rejects an unknown symbol before sending anything", async () => {
    await expect(
      client().placeOrder({ symbol: "DOGE", side: "buy", size: 1, price: 0.1 }),
    ).rejects.toThrow(/Unknown symbol "DOGE"/);
    expect(transport.callsTo("exchange:order")).toHaveLength(0);
  });
});

describe("builder code", () => {
  it("attaches the builder fee to every order", async () => {
    transport.reply("exchange:order", RESTING);
    const c = client({
      builder: { address: "0xAbCdEf0000000000000000000000000000000001", feeTenthsBps: 10 },
    });
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    expect(lastOrderAction().builder).toEqual({
      b: "0xabcdef0000000000000000000000000000000001",
      f: 10,
    });
  });

  it("omits the builder key when none is configured", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    expect(lastOrderAction()).not.toHaveProperty("builder");
  });

  it("refuses a fee above the 0.1% perps cap", () => {
    expect(() =>
      client({ builder: { address: "0x01", feeTenthsBps: 101 } }),
    ).toThrow(/exceeds the perps cap/);
  });

  it("accepts a fee exactly at the cap", () => {
    expect(() => client({ builder: { address: "0x01", feeTenthsBps: 100 } })).not.toThrow();
  });

  it("refuses a non-integer fee", () => {
    expect(() => client({ builder: { address: "0x01", feeTenthsBps: 1.5 } })).toThrow(
      RangeError,
    );
  });
});

describe("order outcomes", () => {
  it("reads a resting order", async () => {
    transport.reply("exchange:order", RESTING);
    const outcome = await client().placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      price: 50_000,
    });
    expect(outcome).toEqual({ kind: "resting", oid: 77738308 });
  });

  it("reads a filled order", async () => {
    transport.reply("exchange:order", FILLED);
    const outcome = await client().placeOrder({
      symbol: "ETH",
      side: "buy",
      size: 0.02,
      price: 1891.4,
    });
    expect(outcome).toEqual({
      kind: "filled",
      oid: 77747314,
      totalSize: "0.02",
      avgPrice: "1891.4",
    });
  });

  it("returns a rejection rather than throwing when the exchange refuses one order", async () => {
    transport.reply("exchange:order", {
      status: "ok",
      response: {
        type: "order",
        data: { statuses: [{ error: "Order must have minimum value of $10." }] },
      },
    });
    const outcome = await client().placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.00001,
      price: 50_000,
    });
    expect(outcome).toEqual({
      kind: "rejected",
      message: "Order must have minimum value of $10.",
    });
  });

  it("surfaces a top-level error response", async () => {
    transport.reply("exchange:order", { status: "err", response: "Invalid nonce." });
    const outcome = await client().placeOrder({
      symbol: "BTC",
      side: "buy",
      size: 0.1,
      price: 50_000,
    });
    expect(outcome).toEqual({ kind: "rejected", message: "Invalid nonce." });
  });
});

describe("cancel", () => {
  it("builds the cancel action and reads success", async () => {
    transport.reply("exchange:cancel", {
      status: "ok",
      response: { type: "cancel", data: { statuses: ["success"] } },
    });
    const outcome = await client().cancelOrder("BTC", 77738308);

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(transport.callsTo("exchange:cancel")[0]?.body["action"]).toEqual({
      type: "cancel",
      cancels: [{ a: 0, o: 77738308 }],
    });
  });

  it("reads a cancel rejection", async () => {
    transport.reply("exchange:cancel", {
      status: "ok",
      response: {
        type: "cancel",
        data: { statuses: [{ error: "Order was never placed, already canceled, or filled." }] },
      },
    });
    const outcome = await client().cancelOrder("BTC", 1);
    expect(outcome).toMatchObject({ kind: "rejected" });
  });
});

describe("signing and nonces", () => {
  it("signs every exchange action with the testnet flag set", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    expect(signer.signed).toHaveLength(1);
    expect(signer.signed[0]).toMatchObject({ isTestnet: true, vaultAddress: null });
  });

  it("keeps nonces strictly increasing inside one millisecond", async () => {
    transport.reply("exchange:order", RESTING);
    const c = client({ now: () => 1_700_000_000_000 });
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });

    const nonces = signer.signed.map((s) => s.nonce);
    expect(nonces).toEqual([1_700_000_000_000, 1_700_000_000_001]);
  });
});

describe("API wallets", () => {
  // The account that approved the API wallet; the StubSigner is the API wallet.
  const ACCOUNT = "0xAbCdEf0000000000000000000000000000001234";

  it("reads account data under the account, not the API wallet", async () => {
    transport
      .reply("info:clearinghouseState", STATE)
      .reply("info:userFills", [])
      .reply("info:frontendOpenOrders", []);
    const c = client({ account: ACCOUNT });
    await c.accountState();
    await c.stopLosses();
    await c.openPositions();

    const users = ["info:clearinghouseState", "info:userFills", "info:frontendOpenOrders"].flatMap((route) =>
      transport.callsTo(route as `info:${string}`).map((call) => call.body["user"]),
    );
    expect(users.length).toBeGreaterThanOrEqual(4);
    expect(new Set(users)).toEqual(new Set([ACCOUNT.toLowerCase()]));
  });

  it("still signs with the API wallet, with no vault address", async () => {
    transport.reply("exchange:order", RESTING);
    await client({ account: ACCOUNT }).placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    const call = transport.callsTo("exchange:order")[0]!;
    expect(call.body["vaultAddress"]).toBeNull();
    expect(call.body["signature"]).toMatchObject({ r: expect.stringMatching(/^0x/) });
  });

  it("falls back to the signer's own address when no account is set", () => {
    expect(client().accountAddress).toBe(signer.address);
    expect(client({ account: ACCOUNT }).accountAddress).toBe(ACCOUNT.toLowerCase());
  });

  it("reads an account with no key at all, read-only", async () => {
    transport.reply("info:clearinghouseState", STATE);
    const readOnly = new HyperliquidClient({ fetch: transport.fetch, account: ACCOUNT });
    expect(readOnly.isReadOnly).toBe(true);
    expect(await readOnly.openPositions()).toHaveProperty("BTC");
  });

  it("refuses an account that is not an address", () => {
    expect(() => client({ account: "0x1234" })).toThrow(/40 hex digits/);
  });
});

describe("account state", () => {
  it("caches the universe instead of refetching it", async () => {
    transport.reply("exchange:order", RESTING);
    const c = client();
    await c.placeOrder({ symbol: "BTC", side: "buy", size: 0.1, price: 50_000 });
    await c.placeOrder({ symbol: "ETH", side: "buy", size: 1, price: 2986 });

    expect(transport.callsTo("info:meta")).toHaveLength(1);
  });

  it("refetches after the cache is cleared", async () => {
    const c = client();
    await c.assetInfo("BTC");
    c.clearMetaCache();
    await c.assetInfo("BTC");
    expect(transport.callsTo("info:meta")).toHaveLength(2);
  });

  it("takes position direction from szi, not positionValue", async () => {
    transport.reply("info:clearinghouseState", STATE);
    const snapshot = await client().positionSnapshot();

    expect(snapshot.positionsUsd["ETH"]).toBeCloseTo(-100.02765, 5);
    expect(snapshot.positionsUsd["BTC"]).toBeCloseTo(12_500, 5);
    expect(snapshot.accountValueUsd).toBeCloseTo(13_109.482328, 5);
  });

  describe("in a Unified account", () => {
    // What the builder account returned on mainnet, 2026-09-21, while Unified:
    // perps reads $0 and the deposit sits in spot.
    const EMPTY_PERPS: ClearinghouseState = {
      assetPositions: [],
      marginSummary: { accountValue: "0.0", totalMarginUsed: "0.0", totalNtlPos: "0.0", totalRawUsd: "0.0" },
      withdrawable: "0.0",
    };
    const spot = (usdc: string) => ({
      balances: [
        { coin: "USDC", token: 0, total: usdc, hold: "0.0", entryNtl: "0.0" },
        { coin: "USDE", token: 235, total: "0.0", hold: "0.0", entryNtl: "0.0" },
        { coin: "HYPE", token: 150, total: "3.0", hold: "0.0", entryNtl: "280.0" },
      ],
    });

    beforeEach(() => {
      transport = new MockTransport().reply("info:meta", META).reply("info:userAbstraction", "unifiedAccount");
    });

    it("reads equity from the USDC spot balance, not the empty perps account", async () => {
      transport.reply("info:clearinghouseState", EMPTY_PERPS).reply("info:spotClearinghouseState", spot("104.8"));
      expect((await client().positionSnapshot()).accountValueUsd).toBeCloseTo(104.8, 6);
    });

    it("adds the positions' unrealized PnL, and ignores what perps calls account value", async () => {
      transport.reply("info:clearinghouseState", STATE).reply("info:spotClearinghouseState", spot("1000"));
      const snapshot = await client().positionSnapshot();
      expect(snapshot.accountValueUsd).toBeCloseTo(1000 + 35.5 - 0.0134, 6);
      expect(snapshot.positionsUsd["BTC"]).toBeCloseTo(12_500, 5);
    });

    it("treats Portfolio margin the same way", async () => {
      transport = new MockTransport().reply("info:meta", META).reply("info:userAbstraction", "portfolioMargin");
      transport.reply("info:clearinghouseState", EMPTY_PERPS).reply("info:spotClearinghouseState", spot("250"));
      expect((await client().positionSnapshot()).accountValueUsd).toBeCloseTo(250, 6);
    });

    it("reads $0 when there is no USDC at all", async () => {
      transport.reply("info:clearinghouseState", EMPTY_PERPS).reply("info:spotClearinghouseState", { balances: [] });
      expect((await client().positionSnapshot()).accountValueUsd).toBe(0);
    });
  });

  it("does not read spot balances for a Manual account", async () => {
    transport.reply("info:clearinghouseState", STATE);
    await client().positionSnapshot();
    expect(transport.callsTo("info:spotClearinghouseState")).toHaveLength(0);
  });

  it("lowercases the user address in the request", async () => {
    transport.reply("info:clearinghouseState", STATE);
    await client().clearinghouseState("0xAABBCC0000000000000000000000000000000001");

    expect(transport.callsTo("info:clearinghouseState")[0]?.body["user"]).toBe(
      "0xaabbcc0000000000000000000000000000000001",
    );
  });
});

describe("builderRewardsUsd", () => {
  it("reads Hyperliquid running total of fees credited to a builder", async () => {
    transport.reply("info:referral", {
      referredBy: null, cumVlm: "0.0", unclaimedRewards: "0.009477", claimedRewards: "0.0", builderRewards: "0.009477",
    });
    expect(await client().builderRewardsUsd("0x658DC3a1fc753262c83c7345032E6DB7Aa8fA997")).toBeCloseTo(0.009477, 9);
    expect(transport.lastCall?.body["user"]).toBe("0x658dc3a1fc753262c83c7345032e6db7aa8fa997");
  });

  it("reads zero from an account that has never earned any", async () => {
    transport.reply("info:referral", { referredBy: null, cumVlm: "0.0" });
    expect(await client().builderRewardsUsd("0x1111111111111111111111111111111111111111")).toBe(0);
  });
});

describe("fillsSince", () => {
  // Shapes from the live test on mainnet, 2026-09-21. A fill does not say it
  // came from a stop; the order history does.
  const fill = (oid: number, time: number, side: "A" | "B") => ({
    coin: "BTC", px: "85125.0", sz: "0.00014", side, time, startPosition: "0.00014", dir: "Close Long",
    closedPnl: "-0.00252", hash: "0x0", oid, crossed: true, fee: "0.007745", builderFee: "0.002383",
  });
  const order = (oid: number, isTrigger: boolean) => ({
    order: { coin: "BTC", oid, isTrigger, orderType: isTrigger ? "Stop Market" : "Limit" },
    status: "filled",
  });

  it("marks the fills that came from a stop, oldest first, and skips older ones", async () => {
    transport
      .reply("info:userFills", [fill(3, 3_000, "A"), fill(2, 2_000, "B"), fill(1, 1_000, "B")])
      .reply("info:historicalOrders", [order(3, true), order(2, false)]);
    const fills = await client().fillsSince(1_500);

    expect(fills.map((f) => [f.oid, f.side, f.stop])).toEqual([
      [2, "buy", false],
      [3, "sell", true],
    ]);
    expect(fills[1]).toMatchObject({ symbol: "BTC", size: 0.00014, price: 85125, feeUsd: 0.007745, closedPnlUsd: -0.00252 });
  });

  it("does not read the order history when there is nothing to explain", async () => {
    transport.reply("info:userFills", [fill(1, 1_000, "B")]);
    expect(await client().fillsSince(5_000)).toEqual([]);
    expect(transport.callsTo("info:historicalOrders")).toHaveLength(0);
  });
});

describe("candles", () => {
  // The shape candleSnapshot returned for BTC on mainnet, 2026-09-18.
  const CANDLE = {
    t: 1_789_750_800_000,
    T: 1_789_754_399_999,
    s: "BTC",
    i: "1h",
    o: "80877.0",
    c: "80928.0",
    h: "80967.0",
    l: "80594.0",
    v: "1345.18082",
    n: 17078,
  };

  it("asks candleSnapshot for the coin, interval and window", async () => {
    transport.reply("info:candleSnapshot", [CANDLE]);
    const candles = await client().candles("BTC", "1h", 1_000, 2_000);

    expect(candles).toEqual([CANDLE]);
    expect(transport.callsTo("info:candleSnapshot")[0]?.body).toEqual({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1h", startTime: 1_000, endTime: 2_000 },
    });
  });

  it("works without a signer, since it is market data", async () => {
    transport.reply("info:candleSnapshot", []);
    const readOnly = new HyperliquidClient({ fetch: transport.fetch });
    await expect(readOnly.candles("ETH", "1d", 0, 1)).resolves.toEqual([]);
  });

  it("explains the 500 with a null body that mainnet sends for an unknown coin", async () => {
    transport.failRoute("info:candleSnapshot", 500, "null");
    const error = await client().candles("NOPE", "1h", 0, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HyperliquidApiError);
    expect((error as HyperliquidApiError).message).toMatch(/"NOPE" — it is not a listed market/);
    expect((error as HyperliquidApiError).status).toBe(500);
  });

  it("handles a null sent with a 200 the same way", async () => {
    transport.reply("info:candleSnapshot", null);
    await expect(client().candles("NOPE", "1h", 0, 1)).rejects.toThrow(/not a listed market/);
  });

  it("passes any other failure through unchanged", async () => {
    transport.failRoute("info:candleSnapshot", 422, "Failed to deserialize the JSON body");
    await expect(client().candles("BTC", "1h", 0, 1)).rejects.toThrow(/422: Failed to deserialize/);
  });
});

describe("stop-loss orders", () => {
  const STOP = { symbol: "ETH", side: "sell" as const, size: 0.7557, triggerPrice: 2630.8 };

  function openOrder(overrides: Record<string, unknown> = {}) {
    return {
      coin: "ETH",
      side: "A",
      limitPx: "2499.3",
      sz: "0.7557",
      oid: 42,
      timestamp: 1,
      isTrigger: true,
      triggerPx: "2630.8",
      triggerCondition: "Price below 2630.8",
      orderType: "Stop Market",
      reduceOnly: true,
      isPositionTpsl: false,
      origSz: "0.7557",
      ...overrides,
    };
  }

  it("sends a reduce-only stop-market trigger in the SDK's shape", async () => {
    transport.reply("exchange:order", RESTING);
    await client({ builder: { address: "0x000000000000000000000000000000000000dEaD", feeTenthsBps: 20 } })
      .placeStopLoss(STOP);

    const order = lastOrderAction().orders[0]!;
    expect(order).toMatchObject({ a: 1, b: false, s: "0.7557", r: true });
    expect(order.t).toEqual({ trigger: { isMarket: true, triggerPx: "2630.8", tpsl: "sl" } });
    // Key order is part of the signed hash.
    expect(Object.keys((order.t as { trigger: object }).trigger)).toEqual(["isMarket", "triggerPx", "tpsl"]);
    // Worst fill 5% past the trigger, so the stop fills in a fast market.
    expect(order.p).toBe("2499.3");
    expect(lastOrderAction().builder).toEqual({ b: "0x000000000000000000000000000000000000dead", f: 20 });
  });

  it("sends an order and its stop together in the normalTpsl grouping", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "ETH", side: "buy", size: 0.7557, price: 2640, tif: "Alo", stopLoss: 2630.8 });

    const action = lastOrderAction();
    expect(action.grouping).toBe("normalTpsl");
    expect(action.orders).toHaveLength(2);
    expect(action.orders[0]).toMatchObject({ b: true, p: "2640", s: "0.7557", r: false, t: { limit: { tif: "Alo" } } });
    // The child closes what the parent opens, sized the same, reduce-only.
    expect(action.orders[1]).toEqual({
      a: 1,
      b: false,
      p: "2499.3",
      s: "0.7557",
      r: true,
      t: { trigger: { isMarket: true, triggerPx: "2630.8", tpsl: "sl" } },
    });
  });

  it("keeps the plain grouping when no stop rides along", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeOrder({ symbol: "ETH", side: "buy", size: 1, price: 2640 });
    expect(lastOrderAction()).toMatchObject({ grouping: "na" });
    expect(lastOrderAction().orders).toHaveLength(1);
  });

  it("puts a short's stop above the trigger", async () => {
    transport.reply("exchange:order", RESTING);
    await client().placeStopLoss({ ...STOP, side: "buy", triggerPrice: 2700 });
    expect(lastOrderAction().orders[0]).toMatchObject({ b: true, p: "2835" });
  });

  it("finds the order id when the exchange acknowledges with a bare string", async () => {
    transport
      .reply("exchange:order", { status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger"] } } })
      .reply("info:frontendOpenOrders", [openOrder()]);
    expect(await client().placeStopLoss(STOP)).toEqual({ kind: "resting", oid: 42 });
  });

  it("lists only reduce-only stop triggers as stop-losses", async () => {
    transport.reply("info:frontendOpenOrders", [
      openOrder(),
      openOrder({ oid: 43, isTrigger: false, orderType: "Limit", triggerPx: "0.0" }),
      openOrder({ oid: 44, orderType: "Take Profit Market" }),
      openOrder({ oid: 45, side: "B", coin: "BTC", triggerPx: "105000", sz: "0.01" }),
    ]);
    expect(await client().stopLosses()).toEqual([
      { oid: 42, symbol: "ETH", side: "sell", size: 0.7557, triggerPrice: 2630.8 },
      { oid: 45, symbol: "BTC", side: "buy", size: 0.01, triggerPrice: 105_000 },
    ]);
  });

  it("reads exact signed position sizes", async () => {
    transport.reply("info:clearinghouseState", STATE);
    expect(await client().openPositions()).toEqual({
      ETH: { size: -0.0335, entryPrice: 2986.3 },
      BTC: { size: 0.25, entryPrice: 50_000 },
    });
  });
});

describe("transport errors", () => {
  it("wraps a non-2xx response", async () => {
    transport.failWith(503, "upstream unavailable");
    await expect(client().assetInfo("BTC")).rejects.toBeInstanceOf(HyperliquidApiError);
  });

  it("wraps a non-JSON body", async () => {
    const bad = new MockTransport();
    bad.failWith(200, "<html>nope</html>");
    const c = new HyperliquidClient({ fetch: bad.fetch, signer });
    await expect(c.assetInfo("BTC")).rejects.toThrow(/non-JSON body/);
  });
});

describe("network selection", () => {
  it("defaults to testnet", async () => {
    await client().assetInfo("BTC");
    expect(transport.lastCall?.url).toBe("https://api.hyperliquid-testnet.xyz/info");
  });

  it("uses the mainnet host when asked", async () => {
    await client({ network: "mainnet" }).assetInfo("BTC");
    expect(transport.lastCall?.url).toBe("https://api.hyperliquid.xyz/info");
  });
});
