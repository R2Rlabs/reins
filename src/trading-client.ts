import type { PlaceOrderParams } from "./client.js";
import type { AccountState } from "./risk.js";
import type {
  AccountFill,
  AssetMeta,
  CancelOutcome,
  Candle,
  CandleInterval,
  L2Book,
  OrderOutcome,
  StopLoss,
} from "./types.js";

/**
 * What the MCP server needs from whatever is executing orders.
 *
 * `HyperliquidClient` and `PaperClient` both satisfy this structurally, so the
 * same agent, the same tools and the same risk engine run against either one —
 * the only difference is whether fills are real.
 */
export interface TradingClient {
  accountState(): Promise<AccountState>;
  l2Book(coin: string): Promise<L2Book>;
  candles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]>;
  placeOrder(params: PlaceOrderParams): Promise<OrderOutcome>;
  cancelOrder(symbol: string, oid: number): Promise<CancelOutcome>;
  /** A reduce-only stop-market order; cancelled with cancelOrder like any other. */
  placeStopLoss(params: {
    symbol: string;
    side: "buy" | "sell";
    size: number;
    triggerPrice: number;
  }): Promise<OrderOutcome>;
  stopLosses(): Promise<StopLoss[]>;
  /** Signed sizes in asset units. accountState only carries USD notional. */
  openPositions(): Promise<Record<string, { size: number; entryPrice: number }>>;
  /**
   * The account's fills since `startTime`, oldest first. How Reins learns of
   * what the exchange did without being asked: a stop firing, a resting
   * order filling hours after it was placed.
   */
  fillsSince(startTime: number): Promise<AccountFill[]>;
}

/**
 * The live market data a paper account needs: books to price its simulated
 * fills, and candles to pass straight through to the agent.
 */
export interface MarketDataSource {
  l2Book(coin: string): Promise<L2Book>;
  candles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]>;
  assetInfo(symbol: string): Promise<AssetMeta & { index: number }>;
}
