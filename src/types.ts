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
  t: { limit: { tif: Tif } };
  /** Client order id, 128-bit hex. */
  c?: string;
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
  grouping: "na";
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
  | { error: string };

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
export interface PositionSnapshot {
  /** Signed notional per symbol, in USD. Negative is short. */
  positionsUsd: Record<string, number>;
  accountValueUsd: number;
}
