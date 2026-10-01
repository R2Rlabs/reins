import type { ApprovalRequest } from "./builder-approval.js";
import type { Signer } from "./signer.js";
import type { AccountState } from "./risk.js";
import { formatPrice, formatSize } from "./format.js";
import {
  API_URLS,
  type AssetMeta,
  type CancelAction,
  type Candle,
  type CandleInterval,
  type CancelOutcome,
  type AccountAbstraction,
  type AccountFill,
  type HistoricalOrder,
  type ClearinghouseState,
  type SpotClearinghouseState,
  type ExchangeRequest,
  type ExchangeResponse,
  type Fill,
  type FrontendOpenOrder,
  type L2Book,
  type Meta,
  type Network,
  type OrderAction,
  type OrderOutcome,
  type LiquidationState,
  type PositionSnapshot,
  type StopLoss,
  type Tif,
  type WireOrder,
} from "./types.js";

/** Midnight UTC on the day containing `ms`. */
function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<HttpResponse>;

export interface BuilderConfig {
  /** Your registered builder address. Needs >=100 USDC of perps account value. */
  address: string;
  /**
   * Fee in tenths of a basis point. 10 is 1 bp. Hyperliquid caps perps builder
   * fees at 0.1%, which is 100 in these units.
   */
  feeTenthsBps: number;
}

export interface ClientOptions {
  network?: Network;
  /** Omit for a read-only client: market data works, nothing can trade. */
  signer?: Signer;
  /**
   * The account traded, when the signer is an API wallet rather than the
   * account's own key. Hyperliquid's API wallets trade for an account but
   * cannot withdraw from it, so they are what a bot should hold. Account data
   * lives under the account's address, not the API wallet's: queried under the
   * API wallet, the account looks empty. Defaults to the signer's address.
   */
  account?: string;
  builder?: BuilderConfig;
  fetch?: FetchLike;
  now?: () => number;
}

export interface PlaceOrderParams {
  symbol: string;
  side: "buy" | "sell";
  /** Size in asset units, not USD. */
  size: number;
  price: number;
  reduceOnly?: boolean;
  tif?: Tif;
  /** Client order id, 128-bit hex. */
  cloid?: string;
  /**
   * Trigger price of a stop-loss that rides with this order: the exchange
   * places it for whatever fills, as it fills, so a resting entry is never
   * bare between filling and anyone noticing. Sent as Hyperliquid's
   * `normalTpsl` grouping, as the Python SDK's basic_tpsl example does.
   */
  stopLoss?: number;
}

/** Perps builder fees are capped at 0.1%, or 100 tenths of a basis point. */
export const MAX_PERP_BUILDER_FEE_TENTHS_BPS = 100;

/** USDC's token index in the spot balances. */
const USDC_TOKEN = 0;

export class ReadOnlyClientError extends Error {
  constructor() {
    super(
      "This client has no signer, so it is read-only. Market data works; " +
        "trading does not. Construct it with a signer to place orders.",
    );
    this.name = "ReadOnlyClientError";
  }
}

export class HyperliquidApiError extends Error {
  readonly status: number;
  /** The raw response body, when there was one. */
  readonly body: string | undefined;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = "HyperliquidApiError";
    this.status = status;
    this.body = body;
  }
}

export class HyperliquidClient {
  readonly network: Network;
  private readonly baseUrl: string;
  private readonly signer: Signer | undefined;
  private readonly account: string | undefined;
  private readonly builder: BuilderConfig | undefined;
  private readonly doFetch: FetchLike;
  private readonly now: () => number;

  private metaCache: Meta | undefined;
  private lastNonce = 0;

  constructor(options: ClientOptions = {}) {
    this.network = options.network ?? "testnet";
    this.baseUrl = API_URLS[this.network];
    this.signer = options.signer;
    if (options.account !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(options.account)) {
      throw new Error(`account must be a 0x address of 40 hex digits, got "${options.account}".`);
    }
    this.account = options.account?.toLowerCase();
    this.doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? Date.now;

    if (options.builder) {
      const { address, feeTenthsBps } = options.builder;
      if (!Number.isInteger(feeTenthsBps) || feeTenthsBps < 0) {
        throw new RangeError(
          `Builder fee must be a non-negative integer in tenths of a basis point, got ${feeTenthsBps}.`,
        );
      }
      if (feeTenthsBps > MAX_PERP_BUILDER_FEE_TENTHS_BPS) {
        throw new RangeError(
          `Builder fee of ${feeTenthsBps} tenths of a bp exceeds the perps cap of ` +
            `${MAX_PERP_BUILDER_FEE_TENTHS_BPS} (0.1%). Hyperliquid would reject the order.`,
        );
      }
      // Hyperliquid rejects mixed-case addresses in signed payloads.
      this.builder = { address: address.toLowerCase(), feeTenthsBps };
    }
  }

  /** Whose account data is read: the configured account, else the signer's own. */
  get accountAddress(): string | undefined {
    return this.account ?? this.signer?.address;
  }

  /** True when no signer was supplied: market data works, trading does not. */
  get isReadOnly(): boolean {
    return this.signer === undefined;
  }

  // --- info ----------------------------------------------------------------

  /** Perps metadata. Cached, because asset indices do not change often. */
  async meta(): Promise<Meta> {
    if (!this.metaCache) {
      this.metaCache = await this.postInfo<Meta>({ type: "meta" });
    }
    return this.metaCache;
  }

  /** Discard the cached universe, e.g. after a new listing. */
  clearMetaCache(): void {
    this.metaCache = undefined;
  }

  async assetInfo(symbol: string): Promise<AssetMeta & { index: number }> {
    const { universe } = await this.meta();
    const index = universe.findIndex((a) => a.name === symbol);
    const asset = universe[index];
    if (index < 0 || !asset) {
      throw new Error(
        `Unknown symbol "${symbol}". It is not in the ${this.network} perps universe.`,
      );
    }
    return { ...asset, index };
  }

  async clearinghouseState(user?: string): Promise<ClearinghouseState> {
    return this.postInfo<ClearinghouseState>({
      type: "clearinghouseState",
      user: this.requireAddress(user).toLowerCase(),
    });
  }

  private requireAddress(user?: string): string {
    const address = user ?? this.accountAddress;
    if (!address) {
      throw new Error("No user address given, and this client has neither an account nor a signer.");
    }
    return address;
  }

  async spotClearinghouseState(user?: string): Promise<SpotClearinghouseState> {
    return this.postInfo<SpotClearinghouseState>({
      type: "spotClearinghouseState",
      user: this.requireAddress(user).toLowerCase(),
    });
  }

  /** The account's mode: Unified, Portfolio margin, or Manual (`disabled`). */
  async accountAbstraction(user?: string): Promise<AccountAbstraction> {
    return this.postInfo<AccountAbstraction>({
      type: "userAbstraction",
      user: this.requireAddress(user).toLowerCase(),
    });
  }

  /**
   * Positions and equity in the shape the risk engine consumes. `positionValue`
   * is unsigned on the wire, so the direction is taken from `szi`.
   *
   * Equity depends on the account's mode. In Manual it is the perps account
   * value. In Unified and Portfolio margin — Unified is what the app gives a
   * new account — the collateral lives in the spot balances and perps reads
   * $0, so equity is the USDC balance plus the positions' unrealized PnL.
   * Other collateral a Portfolio-margin account may hold is left out: equity
   * is understated, which only ever makes the limits stricter.
   */
  async positionSnapshot(user?: string): Promise<PositionSnapshot> {
    const [state, mode] = await Promise.all([this.clearinghouseState(user), this.accountAbstraction(user)]);
    const positionsUsd: Record<string, number> = {};
    const liquidation: Record<string, LiquidationState> = {};
    let unrealizedUsd = 0;
    for (const { position } of state.assetPositions) {
      const notional = Math.abs(Number(position.positionValue));
      const size = Math.abs(Number(position.szi));
      const direction = Number(position.szi) < 0 ? -1 : 1;
      positionsUsd[position.coin] = direction * notional;
      unrealizedUsd += Number(position.unrealizedPnl);

      // Mark comes from the position itself — notional / size — so this needs
      // no second call. A position with no liquidation price cannot be
      // liquidated, so there is nothing to report.
      const liquidationPx = Number(position.liquidationPx);
      if (size > 0 && Number.isFinite(liquidationPx) && liquidationPx > 0) {
        const markUsd = notional / size;
        liquidation[position.coin] = {
          priceUsd: liquidationPx,
          markUsd,
          distancePct: (Math.abs(markUsd - liquidationPx) / markUsd) * 100,
          ...(position.leverage ? { marginMode: position.leverage.type } : {}),
        };
      }
    }
    const liquidationField = Object.keys(liquidation).length > 0 ? { liquidation } : {};
    if (mode === "unifiedAccount" || mode === "portfolioMargin") {
      const spot = await this.spotClearinghouseState(user);
      const usdc = spot.balances.find((b) => b.token === USDC_TOKEN);
      return {
        positionsUsd,
        accountValueUsd: Number(usdc?.total ?? 0) + unrealizedUsd,
        ...liquidationField,
      };
    }
    return {
      positionsUsd,
      accountValueUsd: Number(state.marginSummary.accountValue),
      ...liquidationField,
    };
  }

  async l2Book(coin: string): Promise<L2Book> {
    return this.postInfo<L2Book>({ type: "l2Book", coin });
  }

  /**
   * Candles whose open time falls in [startTime, endTime], oldest first. Only
   * the most recent 5000 candles of any interval are available.
   *
   * The API answers an unknown coin with a body of `null` — as HTTP 500 on
   * mainnet when this was written, so both that and a 200 are handled — which
   * becomes an error that says what actually went wrong.
   */
  async candles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    const unknownCoin = (status: number) =>
      new HyperliquidApiError(`No candles for "${coin}" — it is not a listed market.`, status, "null");
    let candles: Candle[] | null;
    try {
      candles = await this.postInfo<Candle[] | null>({
        type: "candleSnapshot",
        req: { coin, interval, startTime, endTime },
      });
    } catch (error) {
      if (error instanceof HyperliquidApiError && error.body?.trim() === "null") {
        throw unknownCoin(error.status);
      }
      throw error;
    }
    if (candles === null) throw unknownCoin(200);
    return candles;
  }

  async userFills(user?: string): Promise<Fill[]> {
    const address = user ?? this.accountAddress;
    if (!address) {
      throw new Error("No user address given, and this client has neither an account nor a signer.");
    }
    return this.postInfo<Fill[]>({
      type: "userFills",
      user: address.toLowerCase(),
      aggregateByTime: false,
    });
  }

  /**
   * Fills since `startTime`, oldest first, each marked with whether it came
   * from a stop. A fill does not say so itself; the order history does, so it
   * is read only when there is a fill to explain.
   */
  async fillsSince(startTime: number, user?: string): Promise<AccountFill[]> {
    const fills = (await this.userFills(user)).filter((fill) => fill.time >= startTime);
    if (fills.length === 0) return [];
    const history = await this.postInfo<HistoricalOrder[]>({
      type: "historicalOrders",
      user: this.requireAddress(user).toLowerCase(),
    });
    const stops = new Set(history.filter((entry) => entry.order.isTrigger).map((entry) => entry.order.oid));
    return fills
      .sort((a, b) => a.time - b.time)
      .map((fill) => ({
        oid: fill.oid,
        symbol: fill.coin,
        side: fill.side === "B" ? ("buy" as const) : ("sell" as const),
        size: Number(fill.sz),
        price: Number(fill.px),
        time: fill.time,
        feeUsd: Number(fill.fee),
        closedPnlUsd: Number(fill.closedPnl),
        stop: stops.has(fill.oid),
      }));
  }

  /**
   * Realised PnL since the start of the current UTC day, net of fees.
   *
   * Fees are subtracted from `closedPnl` rather than ignored. If Hyperliquid
   * ever folds fees into `closedPnl` this double-counts them slightly, which
   * would halt an agent marginally early — the safe direction to be wrong in
   * for a loss limit.
   */
  async realizedPnlToday(user?: string): Promise<number> {
    const fills = await this.userFills(user);
    const dayStart = startOfUtcDay(this.now());
    let total = 0;
    for (const fill of fills) {
      if (fill.time < dayStart) continue;
      total += Number(fill.closedPnl) - Number(fill.fee);
    }
    return total;
  }

  /**
   * Everything the risk engine needs, in one call. This is the composition
   * almost every caller wants, so it lives here rather than being reassembled
   * (and got subtly wrong) at each call site.
   */
  async accountState(user?: string): Promise<AccountState> {
    const [snapshot, realizedPnlTodayUsd] = await Promise.all([
      this.positionSnapshot(user),
      this.realizedPnlToday(user),
    ]);
    const { liquidation, ...rest } = snapshot;
    // The engine wants one number per symbol; the full state stays on the
    // snapshot for anything that wants to show it.
    const liquidationDistancePct = liquidation
      ? Object.fromEntries(Object.entries(liquidation).map(([coin, l]) => [coin, l.distancePct]))
      : undefined;
    return {
      ...rest,
      realizedPnlTodayUsd,
      ...(liquidationDistancePct ? { liquidationDistancePct } : {}),
    };
  }

  // --- exchange ------------------------------------------------------------

  async placeOrder(params: PlaceOrderParams): Promise<OrderOutcome> {
    const signer = this.requireSigner();
    const asset = await this.assetInfo(params.symbol);

    const order: WireOrder = {
      a: asset.index,
      b: params.side === "buy",
      p: formatPrice(params.price, asset.szDecimals),
      s: formatSize(params.size, asset.szDecimals),
      r: params.reduceOnly ?? false,
      t: { limit: { tif: params.tif ?? "Gtc" } },
    };
    if (params.cloid !== undefined) order.c = params.cloid;

    const orders = [order];
    if (params.stopLoss !== undefined) {
      orders.push(stopWire(asset, params.side === "buy" ? "sell" : "buy", order.s, params.stopLoss));
    }
    const action: OrderAction = {
      type: "order",
      orders,
      grouping: params.stopLoss !== undefined ? "normalTpsl" : "na",
    };
    // Attaching the builder code is how this library earns anything, so it is
    // done here rather than left to each call site to remember.
    if (this.builder) {
      action.builder = { b: this.builder.address, f: this.builder.feeTenthsBps };
    }

    const response = await this.postExchange(action, signer);
    return parseOrderResponse(response);
  }

  /**
   * A reduce-only stop-market order: once the price reaches `triggerPrice`,
   * the exchange closes `size` at market, whether or not the agent is awake.
   * The wire shape is the one the Python SDK signs in its tpsl test vector,
   * which this library reproduces byte for byte (see signing.test.ts).
   *
   * `p` is the worst price the triggered order may fill at. It sits 5% past
   * the trigger — the SDK's own default slippage for market orders — because a
   * stop that refuses to fill in a fast market protects nothing.
   */
  async placeStopLoss(params: {
    symbol: string;
    side: "buy" | "sell";
    size: number;
    triggerPrice: number;
  }): Promise<OrderOutcome> {
    const signer = this.requireSigner();
    const asset = await this.assetInfo(params.symbol);
    const order = stopWire(asset, params.side, formatSize(params.size, asset.szDecimals), params.triggerPrice);
    const triggerPx = formatPrice(params.triggerPrice, asset.szDecimals);
    const action: OrderAction = { type: "order", orders: [order], grouping: "na" };
    if (this.builder) {
      action.builder = { b: this.builder.address, f: this.builder.feeTenthsBps };
    }

    const response = await this.postExchange(action, signer);
    const status = response.status === "ok" && response.response.type === "order"
      ? response.response.data.statuses[0]
      : undefined;
    if (typeof status !== "string") return parseOrderResponse(response);

    // Acknowledged without an oid: find the order it created.
    const stop = (await this.stopLosses()).find(
      (s) => s.symbol === params.symbol && s.triggerPrice === Number(triggerPx),
    );
    return stop
      ? { kind: "resting", oid: stop.oid }
      : { kind: "rejected", message: `Stop acknowledged as "${status}" but not found among open orders.` };
  }

  /** Open stop-loss orders, read from the exchange. */
  async stopLosses(user?: string): Promise<StopLoss[]> {
    const address = user ?? this.accountAddress;
    if (!address) return [];
    const orders = await this.postInfo<FrontendOpenOrder[]>({
      type: "frontendOpenOrders",
      user: address.toLowerCase(),
    });
    return orders
      .filter((o) => o.isTrigger && o.reduceOnly && o.orderType.startsWith("Stop"))
      .map((o) => ({
        oid: o.oid,
        symbol: o.coin,
        side: o.side === "B" ? ("buy" as const) : ("sell" as const),
        size: Number(o.sz),
        triggerPrice: Number(o.triggerPx),
      }));
  }

  /** Exact position sizes in asset units, signed, with entry prices. */
  async openPositions(user?: string): Promise<Record<string, { size: number; entryPrice: number }>> {
    const state = await this.clearinghouseState(user);
    const out: Record<string, { size: number; entryPrice: number }> = {};
    for (const { position } of state.assetPositions) {
      const size = Number(position.szi);
      if (size !== 0) out[position.coin] = { size, entryPrice: Number(position.entryPx ?? 0) };
    }
    return out;
  }

  async cancelOrder(symbol: string, oid: number): Promise<CancelOutcome> {
    const signer = this.requireSigner();
    const asset = await this.assetInfo(symbol);
    const action: CancelAction = {
      type: "cancel",
      cancels: [{ a: asset.index, o: oid }],
    };
    const response = await this.postExchange(action, signer);
    return parseCancelResponse(response);
  }

  // --- plumbing ------------------------------------------------------------

  private requireSigner(): Signer {
    if (!this.signer) throw new ReadOnlyClientError();
    return this.signer;
  }

  /**
   * Nonces must strictly increase. Two orders inside the same millisecond would
   * otherwise collide and the second would be rejected.
   */
  private nextNonce(): number {
    const now = this.now();
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1;
    return this.lastNonce;
  }

  /**
   * The largest builder fee `user` has approved for `builder`, in tenths of a
   * basis point — the unit an order's `f` uses. 0 when nothing is approved.
   */
  async maxBuilderFee(user: string, builder: string): Promise<number> {
    return this.postInfo<number>({
      type: "maxBuilderFee",
      user: user.toLowerCase(),
      builder: builder.toLowerCase(),
    });
  }

  /**
   * Builder fees credited to `builder` so far, in USDC, claimed or not.
   * Hyperliquid's own running total: unlike the daily fill files, it is never
   * late, so it answers "has anyone traded through this builder code yet".
   */
  async builderRewardsUsd(builder: string): Promise<number> {
    const { builderRewards } = await this.postInfo<{ builderRewards?: string }>({
      type: "referral",
      user: builder.toLowerCase(),
    });
    return Number(builderRewards ?? 0);
  }

  /**
   * Sends an ApproveBuilderFee the user already signed in their own wallet.
   * This client's signer plays no part — the approval must come from the
   * user's main wallet, which Reins never holds.
   */
  async submitBuilderApproval(
    request: ApprovalRequest,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const response = await this.post<{ status: "ok" } | { status: "err"; response: string }>(
      "/exchange",
      { ...request, vaultAddress: null },
    );
    return response.status === "ok" ? { ok: true } : { ok: false, message: response.response };
  }

  private async postExchange(
    action: OrderAction | CancelAction,
    signer: Signer,
  ): Promise<ExchangeResponse> {
    const nonce = this.nextNonce();
    const signature = await signer.signL1Action({
      action,
      nonce,
      vaultAddress: null,
      isTestnet: this.network === "testnet",
    });
    const request: ExchangeRequest = { action, nonce, signature, vaultAddress: null };
    return this.post<ExchangeResponse>("/exchange", request);
  }

  private postInfo<T>(body: unknown): Promise<T> {
    return this.post<T>("/info", body);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HyperliquidApiError(
        `${path} returned ${response.status}: ${text.slice(0, 300)}`,
        response.status,
        text,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HyperliquidApiError(
        `${path} returned a non-JSON body: ${text.slice(0, 300)}`,
        response.status,
        text,
      );
    }
  }
}

/**
 * A reduce-only stop-market trigger on the wire, in the shape the Python SDK
 * signs in its tpsl test vector. `p` is the worst fill, 5% past the trigger —
 * the SDK's own default slippage — because a stop that refuses to fill in a
 * fast market protects nothing. `side` is the side that closes the position.
 */
function stopWire(
  asset: AssetMeta & { index: number },
  side: "buy" | "sell",
  size: string,
  triggerPrice: number,
): WireOrder {
  const worst = side === "sell" ? triggerPrice * 0.95 : triggerPrice * 1.05;
  return {
    a: asset.index,
    b: side === "buy",
    p: formatPrice(worst, asset.szDecimals),
    s: size,
    r: true,
    t: {
      trigger: {
        isMarket: true,
        triggerPx: formatPrice(triggerPrice, asset.szDecimals),
        tpsl: "sl",
      },
    },
  };
}

/**
 * Hyperliquid answers 200 with `status: "ok"` even when an individual order was
 * rejected, so the real outcome lives in the per-order status.
 */
export function parseOrderResponse(response: ExchangeResponse): OrderOutcome {
  if (response.status === "err") {
    return { kind: "rejected", message: response.response };
  }
  if (response.response.type !== "order") {
    return {
      kind: "rejected",
      message: `Expected an order response, got "${response.response.type}".`,
    };
  }
  const status = response.response.data.statuses[0];
  if (!status) {
    return { kind: "rejected", message: "Exchange returned no order status." };
  }
  if (typeof status === "string") {
    // Accepted, but without an oid; placeStopLoss looks the order up instead.
    return { kind: "rejected", message: `Order acknowledged as "${status}" with no order id.` };
  }
  if ("resting" in status) return { kind: "resting", oid: status.resting.oid };
  if ("filled" in status) {
    return {
      kind: "filled",
      oid: status.filled.oid,
      totalSize: status.filled.totalSz,
      avgPrice: status.filled.avgPx,
    };
  }
  return { kind: "rejected", message: status.error };
}

export function parseCancelResponse(response: ExchangeResponse): CancelOutcome {
  if (response.status === "err") {
    return { kind: "rejected", message: response.response };
  }
  if (response.response.type !== "cancel") {
    return {
      kind: "rejected",
      message: `Expected a cancel response, got "${response.response.type}".`,
    };
  }
  const status = response.response.data.statuses[0];
  if (!status) {
    return { kind: "rejected", message: "Exchange returned no cancel status." };
  }
  return status === "success" ? { kind: "cancelled" } : { kind: "rejected", message: status.error };
}
