/** Wire types for the Hyperliquid REST API, matching the published shapes. */

export type Network = "mainnet" | "testnet";

export const API_URLS: Record<Network, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};

// --- info endpoint ---------------------------------------------------------

export interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface Meta {
  universe: AssetMeta[];
}

export interface AssetPosition {
  position: {
    coin: string;
    /** Signed position size in asset units. Negative is short. */
    szi: string;
    entryPx: string | null;
    /** Absolute notional value in USD. The sign lives in `szi`. */
    positionValue: string;
    unrealizedPnl: string;
    marginUsed: string;
    /**
     * Where the exchange closes this position. Null when nothing can liquidate
     * it — no position, or fully margined. This is the number the exchange acts
     * on, which is why a position can sit inside every notional limit and still
     * be one wick from being closed.
     */
    liquidationPx?: string | null;
    /** Cross shares the account's margin; isolated can only lose its own. */
    leverage?: { type: "cross" | "isolated"; value: number };
  };
}

export interface ClearinghouseState {
  assetPositions: AssetPosition[];
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  withdrawable: string;
}

export interface SpotBalance {
  coin: string;
  /** 0 is USDC. */
  token: number;
  total: string;
  hold: string;
}

export interface SpotClearinghouseState {
  balances: SpotBalance[];
}

/**
 * What `userAbstraction` answers. In `unifiedAccount` and `portfolioMargin`
 * the collateral sits in the spot balances and the perps clearinghouse holds
 * none of it; `disabled` (Manual in the app) and `default` keep them apart.
 */
export type AccountAbstraction = "unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction";

export interface BookLevel {
  px: string;
  sz: string;
  n: number;
}

export interface L2Book {
  coin: string;
  time: number;
  /** Exactly two entries: bids first, then asks. */
  levels: [BookLevel[], BookLevel[]];
}

/** Every interval `candleSnapshot` accepts. */
export const CANDLE_INTERVALS = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M",
] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/**
 * One candle as `candleSnapshot` returns it. Prices and volume are strings,
 * like every other number in the API. The most recent candle is usually still
 * forming: its close time `T` is in the future.
 */
export interface Candle {
  /** Open time, ms. */
  t: number;
  /** Close time, ms — the last millisecond inside the candle. */
  T: number;
  s: string;
  i: CandleInterval;
  o: string;
  c: string;
  h: string;
  l: string;
  /** Volume in the base asset. */
  v: string;
  /** Number of trades. */
  n: number;
}

export interface Fill {
  coin: string;
  px: string;
  sz: string;
  /** "B" for buy, "A" for sell. */
  side: string;
  time: number;
  closedPnl: string;
  fee: string;
  dir: string;
  oid: number;
  hash: string;
}

/**
 * A fill on the account, in the shape Reins reports it. `stop` says whether
 * the order that filled was a stop-loss rather than an ordinary order.
 */
export interface AccountFill {
  oid: number;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  time: number;
  feeUsd: number;
  closedPnlUsd: number;
  stop: boolean;
}

/** One entry of `historicalOrders`, as much of it as Reins reads. */
export interface HistoricalOrder {
  order: { oid: number; isTrigger: boolean };
  status: string;
}

// --- exchange endpoint -----------------------------------------------------

export type Tif = "Alo" | "Ioc" | "Gtc";

export interface WireOrder {
  /** Asset index. Perps use the universe index; spot uses 10000 + index. */
  a: number;
  /** isBuy */
  b: boolean;
  /** Price, as a string with trailing zeroes stripped. */
  p: string;
  /** Size, as a string with trailing zeroes stripped. */
  s: string;
  /** reduceOnly */
  r: boolean;
  t: { limit: { tif: Tif } } | { trigger: TriggerWire };
  /** Client order id, 128-bit hex. */
  c?: string;
}

/**
 * A trigger order type on the wire. Key order is part of the signed hash and
 * matches the Python SDK's order_type_to_wire: isMarket, triggerPx, tpsl.
 */
export interface TriggerWire {
  isMarket: boolean;
  /** Price, formatted like p. */
  triggerPx: string;
  tpsl: "tp" | "sl";
}

/** A reduce-only stop-market order protecting a position. */
export interface StopLoss {
  oid: number;
  symbol: string;
  /** The side that closes the position: sell for a long, buy for a short. */
  side: "buy" | "sell";
  /** Asset units. */
  size: number;
  triggerPrice: number;
}

/** One row of the frontendOpenOrders info response. */
export interface FrontendOpenOrder {
  coin: string;
  side: "A" | "B";
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  isTrigger: boolean;
  triggerPx: string;
  triggerCondition: string;
  orderType: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
  origSz: string;
}

export interface BuilderFee {
  /** Builder address, lowercased. */
  b: string;
  /** Fee in tenths of a basis point. 10 means 1 bp. */
  f: number;
}

export interface OrderAction {
  type: "order";
  orders: WireOrder[];
  /** "normalTpsl" when a stop-loss rides with the order and activates as it fills. */
  grouping: "na" | "normalTpsl";
  builder?: BuilderFee;
}

export interface CancelAction {
  type: "cancel";
  cancels: { a: number; o: number }[];
}

export interface Signature {
  r: string;
  s: string;
  v: number;
}

export interface ExchangeRequest {
  action: OrderAction | CancelAction;
  nonce: number;
  signature: Signature;
  vaultAddress: string | null;
}

export type OrderStatus =
  | { resting: { oid: number } }
  | { filled: { totalSz: string; avgPx: string; oid: number } }
  | { error: string }
  // Trigger orders can be acknowledged with a bare string rather than an oid.
  | "waitingForTrigger"
  | "waitingForFill";

export type ExchangeResponse =
  | {
      status: "ok";
      response: {
        type: "order";
        data: { statuses: OrderStatus[] };
      };
    }
  | {
      status: "ok";
      response: {
        type: "cancel";
        data: { statuses: ("success" | { error: string })[] };
      };
    }
  | { status: "err"; response: string };

// --- what this library hands back -------------------------------------------

export type OrderOutcome =
  | { kind: "resting"; oid: number }
  | { kind: "filled"; oid: number; totalSize: string; avgPrice: string }
  | { kind: "rejected"; message: string };

export type CancelOutcome =
  | { kind: "cancelled" }
  | { kind: "rejected"; message: string };

/**
 * Position and equity data shaped for the risk engine. `realizedPnlTodayUsd`
 * is deliberately absent — clearinghouseState does not report it, so the
 * caller tracks the day's realised PnL from fills and supplies it.
 */
/**
 * One hour of funding on a perp. Hyperliquid charges funding hourly, not
 * every eight hours as most venues do, so a rate here is already the hourly
 * fraction: 0.0000125 is 0.00125% an hour, about 11% a year.
 */
export interface FundingPoint {
  coin: string;
  /** Hourly fraction. Positive means longs pay shorts. */
  fundingRate: string;
  /** How far the perp traded from the index over the hour. */
  premium: string;
  /** When the funding was applied, ms. */
  time: number;
}

export interface PositionSnapshot {
  /** Signed notional per symbol, in USD. Negative is short. */
  positionsUsd: Record<string, number>;
  accountValueUsd: number;
  /**
   * How close each position sits to being liquidated, as a percentage of mark.
   * Absent for a venue that does not report it — paper trading has no margin
   * engine, so it reports nothing rather than guessing.
   */
  liquidation?: Record<string, LiquidationState>;
}

export interface LiquidationState {
  /** Where the exchange would close the position. */
  priceUsd: number;
  /** Mark price now, derived from the position's own notional and size. */
  markUsd: number;
  /** Distance from mark to that price, as a percentage of mark. */
  distancePct: number;
  /** Cross shares the account's margin; isolated can only lose its own. */
  marginMode?: "cross" | "isolated";
}
