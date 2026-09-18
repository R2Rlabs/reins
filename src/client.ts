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
  type ClearinghouseState,
  type ExchangeRequest,
  type ExchangeResponse,
  type Fill,
  type L2Book,
  type Meta,
  type Network,
  type OrderAction,
  type OrderOutcome,
  type PositionSnapshot,
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
}

/** Perps builder fees are capped at 0.1%, or 100 tenths of a basis point. */
export const MAX_PERP_BUILDER_FEE_TENTHS_BPS = 100;

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
  private readonly builder: BuilderConfig | undefined;
  private readonly doFetch: FetchLike;
  private readonly now: () => number;

  private metaCache: Meta | undefined;
  private lastNonce = 0;

  constructor(options: ClientOptions = {}) {
    this.network = options.network ?? "testnet";
    this.baseUrl = API_URLS[this.network];
    this.signer = options.signer;
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
    const address = user ?? this.signer?.address;
    if (!address) {
      throw new Error("No user address given, and this client has no signer.");
    }
    return this.postInfo<ClearinghouseState>({
      type: "clearinghouseState",
      user: address.toLowerCase(),
    });
  }

  /**
   * Positions and equity in the shape the risk engine consumes. `positionValue`
   * is unsigned on the wire, so the direction is taken from `szi`.
   */
  async positionSnapshot(user?: string): Promise<PositionSnapshot> {
    const state = await this.clearinghouseState(user);
    const positionsUsd: Record<string, number> = {};
    for (const { position } of state.assetPositions) {
      const notional = Math.abs(Number(position.positionValue));
      const direction = Number(position.szi) < 0 ? -1 : 1;
      positionsUsd[position.coin] = direction * notional;
    }
    return {
      positionsUsd,
      accountValueUsd: Number(state.marginSummary.accountValue),
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
    const address = user ?? this.signer?.address;
    if (!address) {
      throw new Error("No user address given, and this client has no signer.");
    }
    return this.postInfo<Fill[]>({
      type: "userFills",
      user: address.toLowerCase(),
      aggregateByTime: false,
    });
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
    return { ...snapshot, realizedPnlTodayUsd };
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

    const action: OrderAction = {
      type: "order",
      orders: [order],
      grouping: "na",
    };
    // Attaching the builder code is how this library earns anything, so it is
    // done here rather than left to each call site to remember.
    if (this.builder) {
      action.builder = { b: this.builder.address, f: this.builder.feeTenthsBps };
    }

    const response = await this.postExchange(action, signer);
    return parseOrderResponse(response);
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
