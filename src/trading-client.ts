import type { PlaceOrderParams } from "./client.js";
import type { AccountState } from "./risk.js";
import type { AssetMeta, CancelOutcome, L2Book, OrderOutcome } from "./types.js";

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
  placeOrder(params: PlaceOrderParams): Promise<OrderOutcome>;
  cancelOrder(symbol: string, oid: number): Promise<CancelOutcome>;
}

/** The live market data a paper account needs to price its simulated fills. */
export interface MarketDataSource {
  l2Book(coin: string): Promise<L2Book>;
  assetInfo(symbol: string): Promise<AssetMeta & { index: number }>;
}
