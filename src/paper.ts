import type { PlaceOrderParams } from "./client.js";
import type { AccountState } from "./risk.js";
import type { MarketDataSource, TradingClient } from "./trading-client.js";
import type {
  BookLevel,
  CancelOutcome,
  Candle,
  CandleInterval,
  L2Book,
  OrderOutcome,
  Tif,
} from "./types.js";

/**
 * Paper trading against live prices.
 *
 * Prices, depth and spreads are real; fills are simulated. Nothing is signed
 * and nothing reaches the exchange.
 *
 * ## What this model does and does not capture
 *
 * The point of paper trading is to find out whether a strategy is any good
 * before it costs money, so the simulation errs pessimistic wherever it has a
 * choice. Being flattered by your own backtest is the failure mode that matters.
 *
 * Modelled:
 * - Walking real book depth, so a large order pays real slippage rather than
 *   filling entirely at the touch.
 * - Partial fills when the book is too thin inside the limit price.
 * - Taker and maker fees at Hyperliquid's base tier, plus any builder fee.
 * - Resting orders that only fill once the market trades strictly *through*
 *   them, never merely to them — at your own price you are behind a queue you
 *   cannot see, and assuming you get filled there is the most common way a
 *   paper equity curve lies.
 *
 * Not modelled, and each one flatters the simulation:
 * - Latency. Fills are priced off the book as it was when the tool was called.
 * - Market impact. Your own order never moves the price or removes liquidity
 *   that other participants would have taken.
 * - Funding payments on perps, which accrue against open positions.
 * - Book movement between polls. A wick that would have filled a resting order
 *   is missed unless a tool happens to be called while it is happening.
 *
 * Treat a paper equity curve as an upper bound on live performance, not an
 * estimate of it.
 */

/** Hyperliquid base-tier perps fees. Lower tiers exist at higher volume. */
export const BASE_TAKER_FEE_RATE = 0.00045;
export const BASE_MAKER_FEE_RATE = 0.00015;

export interface PaperPosition {
  /** Signed size in asset units. Negative is short. */
  size: number;
  /** Volume-weighted average entry price. */
  entryPrice: number;
}

export interface RestingOrder {
  oid: number;
  symbol: string;
  side: "buy" | "sell";
  /** Remaining size in asset units. */
  size: number;
  price: number;
  reduceOnly: boolean;
  placedAt: number;
}

export interface PaperFill {
  oid: number;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  notionalUsd: number;
  feeUsd: number;
  realizedPnlUsd: number;
  liquidity: "taker" | "maker";
  time: number;
}

export interface PaperState {
  balanceUsd: number;
  positions: Record<string, PaperPosition>;
  resting: RestingOrder[];
  fills: PaperFill[];
  nextOid: number;
}

export interface PaperStore {
  load(): Promise<PaperState | undefined>;
  save(state: PaperState): Promise<void>;
}

export class MemoryPaperStore implements PaperStore {
  private state: PaperState | undefined;
  async load(): Promise<PaperState | undefined> {
    return this.state;
  }
  async save(state: PaperState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export interface PaperClientOptions {
  market: MarketDataSource;
  startingBalanceUsd: number;
  takerFeeRate?: number;
  makerFeeRate?: number;
  /** Builder fee in tenths of a basis point, so the simulation pays it too. */
  builderFeeTenthsBps?: number;
  store?: PaperStore;
  now?: () => number;
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function bestBid(book: L2Book): number | undefined {
  const level = book.levels[0]?.[0];
  return level ? Number(level.px) : undefined;
}

function bestAsk(book: L2Book): number | undefined {
  const level = book.levels[1]?.[0];
  return level ? Number(level.px) : undefined;
}

/**
 * Consume book levels up to a limit price, returning what actually filled and
 * the volume-weighted price paid. This is what makes a large paper order pay
 * for the depth it eats instead of pretending the whole thing fills at the touch.
 */
export function walkBook(
  levels: BookLevel[],
  side: "buy" | "sell",
  limitPrice: number,
  wantSize: number,
): { filled: number; avgPrice: number } {
  let remaining = wantSize;
  let cost = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const px = Number(level.px);
    const crosses = side === "buy" ? px <= limitPrice : px >= limitPrice;
    if (!crosses) break;
    const available = Number(level.sz);
    if (!Number.isFinite(available) || available <= 0) continue;
    const take = Math.min(remaining, available);
    cost += take * px;
    remaining -= take;
  }
  const filled = wantSize - remaining;
  return { filled, avgPrice: filled > 0 ? cost / filled : 0 };
}

function emptyState(startingBalanceUsd: number): PaperState {
  return {
    balanceUsd: startingBalanceUsd,
    positions: {},
    resting: [],
    fills: [],
    nextOid: 1,
  };
}

export class PaperClient implements TradingClient {
  private readonly market: MarketDataSource;
  private readonly store: PaperStore;
  private readonly takerFeeRate: number;
  private readonly makerFeeRate: number;
  private readonly builderFeeRate: number;
  private readonly startingBalanceUsd: number;
  private readonly now: () => number;
  private state: PaperState | undefined;
  /**
   * Every mutating operation runs one at a time.
   *
   * Each one reads state, awaits the market, then writes back. Two overlapping
   * calls would interleave across those awaits and could hand out the same
   * order id or fill a resting order twice. An agent that waits for each tool
   * result never triggers it, but an MCP server answers requests concurrently,
   * so the guarantee has to live here rather than in the caller's manners.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    // Swallow rejections on the chain itself so one failure cannot poison
    // every operation queued behind it.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  constructor(options: PaperClientOptions) {
    this.market = options.market;
    this.store = options.store ?? new MemoryPaperStore();
    this.takerFeeRate = options.takerFeeRate ?? BASE_TAKER_FEE_RATE;
    this.makerFeeRate = options.makerFeeRate ?? BASE_MAKER_FEE_RATE;
    // Tenths of a basis point: 10 means 1 bp, which is 0.0001 as a rate.
    this.builderFeeRate = (options.builderFeeTenthsBps ?? 0) / 100_000;
    this.startingBalanceUsd = options.startingBalanceUsd;
    this.now = options.now ?? Date.now;
  }

  /** Discard everything and start the run again from the opening balance. */
  reset(): Promise<void> {
    return this.serialize(async () => {
      this.state = emptyState(this.startingBalanceUsd);
      await this.store.save(this.state);
    });
  }

  snapshot(): Promise<PaperState> {
    return this.serialize(async () => structuredClone(await this.load()));
  }

  private async load(): Promise<PaperState> {
    if (!this.state) {
      this.state = (await this.store.load()) ?? emptyState(this.startingBalanceUsd);
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    if (this.state) await this.store.save(this.state);
  }

  async l2Book(coin: string): Promise<L2Book> {
    return this.market.l2Book(coin);
  }

  /** Real candles: price history is market data, so paper has nothing to simulate. */
  async candles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    return this.market.candles(coin, interval, startTime, endTime);
  }

  accountState(): Promise<AccountState> {
    return this.serialize(() => this.accountStateUnsafe());
  }

  private async accountStateUnsafe(): Promise<AccountState> {
    const state = await this.load();
    await this.matchResting(state);

    const symbols = Object.keys(state.positions);
    const marks = await this.markPrices(symbols);

    const positionsUsd: Record<string, number> = {};
    let unrealized = 0;
    for (const [symbol, position] of Object.entries(state.positions)) {
      const mark = marks[symbol] ?? position.entryPrice;
      positionsUsd[symbol] = position.size * mark;
      unrealized += position.size * (mark - position.entryPrice);
    }

    const dayStart = startOfUtcDay(this.now());
    const realizedPnlTodayUsd = state.fills
      .filter((fill) => fill.time >= dayStart)
      .reduce((sum, fill) => sum + fill.realizedPnlUsd - fill.feeUsd, 0);

    return {
      positionsUsd,
      accountValueUsd: state.balanceUsd + unrealized,
      realizedPnlTodayUsd,
    };
  }

  placeOrder(params: PlaceOrderParams): Promise<OrderOutcome> {
    return this.serialize(() => this.placeOrderUnsafe(params));
  }

  private async placeOrderUnsafe(params: PlaceOrderParams): Promise<OrderOutcome> {
    const state = await this.load();
    await this.matchResting(state);

    const asset = await this.market.assetInfo(params.symbol);
    const size = roundTo(params.size, asset.szDecimals);
    if (size <= 0) {
      return {
        kind: "rejected",
        message: `Size rounds to zero at ${asset.szDecimals} decimals for ${params.symbol}.`,
      };
    }

    const position = state.positions[params.symbol];
    const reduceOnly = params.reduceOnly ?? false;
    let wantSize = size;

    if (reduceOnly) {
      const held = position?.size ?? 0;
      const opposes = (held > 0 && params.side === "sell") || (held < 0 && params.side === "buy");
      if (held === 0 || !opposes) {
        return {
          kind: "rejected",
          message: `Reduce-only order would not reduce an existing ${params.symbol} position.`,
        };
      }
      wantSize = Math.min(wantSize, Math.abs(held));
    }

    const book = await this.market.l2Book(params.symbol);
    const opposite = params.side === "buy" ? book.levels[1] : book.levels[0];
    const tif: Tif = params.tif ?? "Gtc";

    const touch = params.side === "buy" ? bestAsk(book) : bestBid(book);
    const wouldCross =
      touch !== undefined &&
      (params.side === "buy" ? params.price >= touch : params.price <= touch);

    // Post-only orders that would cross are rejected outright, as on the real
    // exchange, rather than quietly becoming taker fills.
    if (tif === "Alo" && wouldCross) {
      return {
        kind: "rejected",
        message: "Post-only (Alo) order would cross the spread and was rejected.",
      };
    }

    const { filled, avgPrice } = walkBook(
      opposite ?? [],
      params.side,
      params.price,
      wantSize,
    );

    const oid = state.nextOid++;
    if (filled > 0) {
      this.applyFill(state, {
        oid,
        symbol: params.symbol,
        side: params.side,
        size: filled,
        price: avgPrice,
        liquidity: "taker",
      });
    }

    const remainder = roundTo(wantSize - filled, asset.szDecimals);
    if (remainder > 0 && tif === "Gtc") {
      state.resting.push({
        oid,
        symbol: params.symbol,
        side: params.side,
        size: remainder,
        price: params.price,
        reduceOnly,
        placedAt: this.now(),
      });
    }

    await this.persist();

    if (filled <= 0) {
      return tif === "Gtc"
        ? { kind: "resting", oid }
        : { kind: "rejected", message: "No liquidity inside the limit price; Ioc cancelled." };
    }
    return {
      kind: "filled",
      oid,
      totalSize: String(filled),
      avgPrice: String(avgPrice),
    };
  }

  cancelOrder(symbol: string, oid: number): Promise<CancelOutcome> {
    return this.serialize(() => this.cancelOrderUnsafe(symbol, oid));
  }

  private async cancelOrderUnsafe(symbol: string, oid: number): Promise<CancelOutcome> {
    const state = await this.load();
    const before = state.resting.length;
    state.resting = state.resting.filter(
      (order) => !(order.oid === oid && order.symbol === symbol),
    );
    if (state.resting.length === before) {
      return {
        kind: "rejected",
        message: "Order was never placed, already cancelled, or filled.",
      };
    }
    await this.persist();
    return { kind: "cancelled" };
  }

  // --- simulation internals -------------------------------------------------

  private async markPrices(symbols: string[]): Promise<Record<string, number>> {
    const books = await Promise.all(
      symbols.map(async (symbol) => [symbol, await this.market.l2Book(symbol)] as const),
    );
    const marks: Record<string, number> = {};
    for (const [symbol, book] of books) {
      const bid = bestBid(book);
      const ask = bestAsk(book);
      if (bid !== undefined && ask !== undefined) marks[symbol] = (bid + ask) / 2;
      else if (bid !== undefined) marks[symbol] = bid;
      else if (ask !== undefined) marks[symbol] = ask;
    }
    return marks;
  }

  /**
   * Fill resting orders the market has traded through.
   *
   * A resting buy fills only once the best ask is strictly below its price —
   * not merely equal to it. At your own price you are somewhere in a queue this
   * simulation cannot see, so assuming a fill there would flatter the result.
   */
  private async matchResting(state: PaperState): Promise<void> {
    if (state.resting.length === 0) return;

    const symbols = [...new Set(state.resting.map((order) => order.symbol))];
    const books = new Map<string, L2Book>();
    await Promise.all(
      symbols.map(async (symbol) => {
        books.set(symbol, await this.market.l2Book(symbol));
      }),
    );

    const survivors: RestingOrder[] = [];
    let changed = false;

    for (const order of state.resting) {
      const book = books.get(order.symbol);
      if (!book) {
        survivors.push(order);
        continue;
      }
      const through =
        order.side === "buy"
          ? (bestAsk(book) ?? Infinity) < order.price
          : (bestBid(book) ?? -Infinity) > order.price;

      if (!through) {
        survivors.push(order);
        continue;
      }

      if (order.reduceOnly) {
        const held = state.positions[order.symbol]?.size ?? 0;
        const opposes =
          (held > 0 && order.side === "sell") || (held < 0 && order.side === "buy");
        if (held === 0 || !opposes) {
          changed = true; // the position it was protecting is gone; drop it
          continue;
        }
      }

      this.applyFill(state, {
        oid: order.oid,
        symbol: order.symbol,
        side: order.side,
        size: order.size,
        price: order.price,
        liquidity: "maker",
      });
      changed = true;
    }

    if (changed || survivors.length !== state.resting.length) {
      state.resting = survivors;
      await this.persist();
    }
  }

  private applyFill(
    state: PaperState,
    fill: {
      oid: number;
      symbol: string;
      side: "buy" | "sell";
      size: number;
      price: number;
      liquidity: "taker" | "maker";
    },
  ): void {
    const signed = fill.side === "buy" ? fill.size : -fill.size;
    const notionalUsd = fill.size * fill.price;
    const feeRate = fill.liquidity === "taker" ? this.takerFeeRate : this.makerFeeRate;
    const feeUsd = notionalUsd * (feeRate + this.builderFeeRate);

    const existing = state.positions[fill.symbol] ?? { size: 0, entryPrice: 0 };
    const realizedPnlUsd = applyToPosition(existing, signed, fill.price);

    if (existing.size === 0) delete state.positions[fill.symbol];
    else state.positions[fill.symbol] = existing;

    state.balanceUsd += realizedPnlUsd - feeUsd;
    state.fills.push({
      ...fill,
      notionalUsd,
      feeUsd,
      realizedPnlUsd,
      time: this.now(),
    });
  }
}

/**
 * Apply a signed fill to a position in place, returning realised PnL.
 *
 * Adding to a position re-averages the entry. Reducing one realises PnL on the
 * closed portion. Flipping through zero does both: it realises the whole old
 * position, then opens the remainder at the fill price.
 */
export function applyToPosition(
  position: PaperPosition,
  signedSize: number,
  price: number,
): number {
  const before = position.size;

  if (before === 0) {
    position.size = signedSize;
    position.entryPrice = price;
    return 0;
  }

  const sameDirection = Math.sign(before) === Math.sign(signedSize);
  if (sameDirection) {
    const total = before + signedSize;
    position.entryPrice =
      (position.entryPrice * Math.abs(before) + price * Math.abs(signedSize)) /
      Math.abs(total);
    position.size = total;
    return 0;
  }

  const closing = Math.min(Math.abs(signedSize), Math.abs(before));
  const realized = closing * (price - position.entryPrice) * Math.sign(before);
  const after = before + signedSize;

  if (after === 0) {
    position.size = 0;
    position.entryPrice = 0;
  } else if (Math.sign(after) === Math.sign(before)) {
    position.size = after;
  } else {
    // Flipped through zero: the remainder opens fresh at this price.
    position.size = after;
    position.entryPrice = price;
  }
  return realized;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
