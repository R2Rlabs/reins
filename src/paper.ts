import type { PlaceOrderParams } from "./client.js";
import type { AccountState } from "./risk.js";
import type { MarketDataSource, TradingClient } from "./trading-client.js";
import type {
  AccountFill,
  BookLevel,
  CancelOutcome,
  Candle,
  CandleInterval,
  L2Book,
  OrderOutcome,
  StopLoss,
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
 * - Fills and stop-loss triggers between polls, from one-minute candles.
 *
 * Not modelled, and most of them flatter the simulation:
 * - Latency. Fills are priced off the book as it was when the tool was called.
 * - Market impact. Your own order never moves the price or removes liquidity
 *   that other participants would have taken.
 * - Funding payments on perps, which accrue against open positions.
 * - Slippage past a stop's trigger inside a minute that has already gone by:
 *   such a stop fills at its trigger, or at the candle's open if it gapped.
 * - Triggering on mark price. Hyperliquid triggers stops on the mark price;
 *   this uses traded prices, which can differ briefly.
 * - The minute an order was placed in, and anything older than the last 5000
 *   one-minute candles (about three days). A fill there is missed either way.
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
  /** Candles opening before this have been checked already. Absent on older saves. */
  candlesCheckedFrom?: number;
  /** A stop-loss placed for this order's fill the moment it fills. */
  stopLoss?: number;
}

/** A reduce-only stop-market order, waiting for its trigger. */
export interface PaperStop {
  oid: number;
  symbol: string;
  /** The side that closes the position. */
  side: "buy" | "sell";
  size: number;
  triggerPrice: number;
  placedAt: number;
  candlesCheckedFrom?: number;
}

/** Anything the matcher watches the market for. */
type Watched = { symbol: string; placedAt: number; candlesCheckedFrom?: number };

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
  /** Set when a stop-loss made the fill. Fills from before this existed lack it. */
  stop?: true;
}

export interface PaperState {
  balanceUsd: number;
  positions: Record<string, PaperPosition>;
  resting: RestingOrder[];
  /** Absent in saves from before stop-losses existed. */
  stops?: PaperStop[];
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
    stops: [],
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

    // Gtc and Alo both rest whatever did not fill; only Ioc cancels it. An Alo
    // reaching here did not cross, so it filled nothing and rests in full,
    // which is the whole point of posting one.
    const rests = tif !== "Ioc";
    const stopLoss = reduceOnly ? undefined : params.stopLoss;
    if (filled > 0 && stopLoss !== undefined) {
      this.attachStop(state, params.symbol, params.side, filled, stopLoss, this.now());
    }

    const remainder = roundTo(wantSize - filled, asset.szDecimals);
    if (remainder > 0 && rests) {
      state.resting.push({
        oid,
        symbol: params.symbol,
        side: params.side,
        size: remainder,
        price: params.price,
        reduceOnly,
        placedAt: this.now(),
        ...(stopLoss !== undefined ? { stopLoss } : {}),
      });
    }

    await this.persist();

    if (filled <= 0) {
      return rests
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
    // An order the market traded through since the last call has filled; the
    // exchange would refuse to cancel it, so this must too.
    await this.matchResting(state);
    const filled = state.fills.find((fill) => fill.oid === oid && fill.symbol === symbol);
    if (filled && !state.resting.some((order) => order.oid === oid)) {
      return {
        kind: "rejected",
        message:
          `Order ${oid} already filled: ${filled.side} ${filled.size} ${symbol} at ` +
          `${filled.price}, ${new Date(filled.time).toISOString()}.`,
      };
    }
    const matches = (order: { oid: number; symbol: string }) =>
      order.oid === oid && order.symbol === symbol;
    const stops = state.stops ?? [];
    if (!state.resting.some(matches) && !stops.some(matches)) {
      return {
        kind: "rejected",
        message: "Order was never placed, already cancelled, or filled.",
      };
    }
    state.resting = state.resting.filter((order) => !matches(order));
    state.stops = stops.filter((stop) => !matches(stop));
    await this.persist();
    return { kind: "cancelled" };
  }

  placeStopLoss(params: {
    symbol: string;
    side: "buy" | "sell";
    size: number;
    triggerPrice: number;
  }): Promise<OrderOutcome> {
    return this.serialize(async () => {
      const state = await this.load();
      await this.matchResting(state);
      const held = state.positions[params.symbol]?.size ?? 0;
      const closes = (held > 0 && params.side === "sell") || (held < 0 && params.side === "buy");
      if (!closes) {
        return {
          kind: "rejected",
          message: `A ${params.side} stop would not reduce an existing ${params.symbol} position.`,
        };
      }
      const asset = await this.market.assetInfo(params.symbol);
      const size = roundTo(Math.min(params.size, Math.abs(held)), asset.szDecimals);
      if (size <= 0) {
        return { kind: "rejected", message: `Stop size rounds to zero for ${params.symbol}.` };
      }
      const oid = state.nextOid++;
      (state.stops ??= []).push({
        oid,
        symbol: params.symbol,
        side: params.side,
        size,
        triggerPrice: params.triggerPrice,
        placedAt: this.now(),
      });
      await this.persist();
      return { kind: "resting", oid };
    });
  }

  stopLosses(): Promise<StopLoss[]> {
    return this.serialize(async () => {
      const state = await this.load();
      await this.matchResting(state);
      return (state.stops ?? []).map(({ oid, symbol, side, size, triggerPrice }) => ({
        oid,
        symbol,
        side,
        size,
        triggerPrice,
      }));
    });
  }

  openPositions(): Promise<Record<string, { size: number; entryPrice: number }>> {
    return this.serialize(async () => {
      const state = await this.load();
      await this.matchResting(state);
      return structuredClone(state.positions);
    });
  }

  fillsSince(startTime: number): Promise<AccountFill[]> {
    return this.serialize(async () => {
      const state = await this.load();
      await this.matchResting(state);
      return state.fills
        .filter((fill) => fill.time >= startTime)
        .sort((a, b) => a.time - b.time)
        .map((fill) => ({
          oid: fill.oid,
          symbol: fill.symbol,
          side: fill.side,
          size: fill.size,
          price: fill.price,
          time: fill.time,
          feeUsd: fill.feeUsd,
          closedPnlUsd: fill.realizedPnlUsd,
          stop: fill.stop ?? false,
        }));
    });
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
   * Fill resting orders the market has traded through, including between polls.
   *
   * A resting buy fills only once the market trades strictly below its price —
   * not merely at it. At your own price you are somewhere in a queue this
   * simulation cannot see, so assuming a fill there would flatter the result.
   * Strictly through is different: a trade cannot print below a resting bid, so
   * once one has, that bid was taken.
   *
   * Two sources say whether that happened. The book now catches it at the
   * moment of the call. One-minute candles since the order rested catch the
   * dips in between, which the book alone missed: the demo agent's first
   * breakout bid sat under a 5-minute dip that went unfilled, and the agent
   * then cancelled an order the exchange would already have filled. Only
   * candles that opened after the order was placed count, so the minute it was
   * placed in never fills it. Orders fill in the order the market reached
   * them, so a reduce-only order sees the position as it was at the time.
   */
  private async matchResting(state: PaperState): Promise<void> {
    const stops = (state.stops ??= []);
    if (state.resting.length === 0 && stops.length === 0) return;

    const now = this.now();
    const watched: Watched[] = [...state.resting, ...stops];
    const symbols = [...new Set(watched.map((order) => order.symbol))];
    const books = new Map<string, L2Book>();
    const candles = new Map<string, Candle[]>();
    await Promise.all(
      symbols.map(async (symbol) => {
        books.set(symbol, await this.market.l2Book(symbol));
        candles.set(symbol, await this.candlesSince(symbol, watched, now));
      }),
    );

    type Due =
      | { kind: "resting"; order: RestingOrder; time: number }
      | { kind: "stop"; stop: PaperStop; time: number; price: number | undefined };
    const due: Due[] = [];
    const restingLeft: RestingOrder[] = [];
    const stopsLeft: PaperStop[] = [];

    const markChecked = (order: Watched) => {
      // Complete candles need not be read again; a still-forming one does.
      const last = candles.get(order.symbol)?.at(-1);
      if (last) order.candlesCheckedFrom = last.T < now ? last.T + 1 : last.t;
    };

    for (const order of state.resting) {
      const time = tradedThroughAt(order, candles.get(order.symbol) ?? [], books.get(order.symbol), now);
      if (time === undefined) {
        markChecked(order);
        restingLeft.push(order);
      } else {
        due.push({ kind: "resting", order, time });
      }
    }
    for (const stop of stops) {
      const hit = stopTriggeredAt(stop, candles.get(stop.symbol) ?? [], books.get(stop.symbol), now);
      if (hit === undefined) {
        markChecked(stop);
        stopsLeft.push(stop);
      } else {
        due.push({ kind: "stop", stop, time: hit.time, price: hit.price });
      }
    }

    const changed = due.length > 0;
    const stopsBefore = stops.length;
    due.sort((a, b) => a.time - b.time);
    for (const event of due) {
      if (event.kind === "resting") this.fillResting(state, event.order, event.time);
      else this.fillStop(state, event.stop, event.time, event.price, books.get(event.stop.symbol));
    }
    // Stops that rode in with an entry filled just now; they watch from next time.
    const attached = stops.slice(stopsBefore);

    // A stop with no position left to protect has nothing to do.
    const protecting = [...stopsLeft, ...attached].filter((stop) => {
      const held = state.positions[stop.symbol]?.size ?? 0;
      return (held > 0 && stop.side === "sell") || (held < 0 && stop.side === "buy");
    });

    if (changed || restingLeft.length !== state.resting.length || protecting.length !== stops.length) {
      state.resting = restingLeft;
      state.stops = protecting;
      await this.persist();
    }
  }

  private fillResting(state: PaperState, order: RestingOrder, time: number): void {
    let size = order.size;
    if (order.reduceOnly) {
      const held = state.positions[order.symbol]?.size ?? 0;
      const opposes = (held > 0 && order.side === "sell") || (held < 0 && order.side === "buy");
      if (held === 0 || !opposes) return; // the position it was protecting is gone; drop it
      // Sized when it was placed; the position may have shrunk since. Reduce-only
      // never takes more than is left, or it would flip the position.
      size = Math.min(size, Math.abs(held));
    }
    this.applyFill(
      state,
      {
        oid: order.oid,
        symbol: order.symbol,
        side: order.side,
        size,
        price: order.price,
        liquidity: "maker",
      },
      time,
    );
    if (order.stopLoss !== undefined) {
      this.attachStop(state, order.symbol, order.side, size, order.stopLoss, time);
    }
  }

  /**
   * The stop that rides with an entry, placed for what just filled at the
   * moment it filled — as Hyperliquid does for an order sent with a stop in
   * the normalTpsl grouping. A fill found in a past candle is timed at that
   * candle's open, so the stop watches that same minute too: if it went on
   * through the stop, it fires, since whether the dip came before or after the
   * fill is unknowable from a candle and the kinder guess would flatter the
   * result. A fill that happened just now watches only what comes after it.
   */
  private attachStop(
    state: PaperState,
    symbol: string,
    entrySide: "buy" | "sell",
    size: number,
    triggerPrice: number,
    time: number,
  ): void {
    (state.stops ??= []).push({
      oid: state.nextOid++,
      symbol,
      side: entrySide === "buy" ? "sell" : "buy",
      size,
      triggerPrice,
      placedAt: time,
    });
  }

  /**
   * A triggered stop closes what is left of the position, as a taker. Seen in
   * the book right now, it walks the real bids or asks. Seen only in a past
   * candle, the book at that moment is gone, so it fills at the trigger — or
   * at the candle's open if the market gapped straight past it. That ignores
   * slippage beyond the trigger inside the minute, which flatters the result,
   * and the README says so.
   */
  private fillStop(
    state: PaperState,
    stop: PaperStop,
    time: number,
    candlePrice: number | undefined,
    book: L2Book | undefined,
  ): void {
    const held = state.positions[stop.symbol]?.size ?? 0;
    const opposes = (held > 0 && stop.side === "sell") || (held < 0 && stop.side === "buy");
    if (!opposes) return;
    const size = Math.min(stop.size, Math.abs(held));

    let price = candlePrice;
    let filled = size;
    if (price === undefined && book) {
      const levels = stop.side === "sell" ? book.levels[0] : book.levels[1];
      const worst = stop.side === "sell" ? stop.triggerPrice * 0.95 : stop.triggerPrice * 1.05;
      const walked = walkBook(levels ?? [], stop.side, worst, size);
      price = walked.avgPrice;
      filled = walked.filled;
    }
    if (price === undefined || filled <= 0) return;

    this.applyFill(
      state,
      { oid: stop.oid, symbol: stop.symbol, side: stop.side, size: filled, price, liquidity: "taker", stop: true },
      time,
    );
  }

  /**
   * One-minute candles covering every watched order on `symbol` since it was
   * last checked. The API keeps the latest 5000, a little over three days, so
   * an order resting longer than that is only checked across those. If the
   * candles cannot be fetched, the book check still runs; the gap it leaves is
   * the one this closes, not a wrong fill.
   */
  private async candlesSince(symbol: string, watched: Watched[], now: number): Promise<Candle[]> {
    const from = Math.min(
      ...watched
        .filter((order) => order.symbol === symbol)
        .map((order) => Math.max(order.placedAt, order.candlesCheckedFrom ?? 0)),
    );
    const start = Math.max(from, now - 5_000 * 60_000);
    if (start >= now) return [];
    try {
      return await this.market.candles(symbol, "1m", start, now);
    } catch {
      return [];
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
      stop?: true;
    },
    time: number = this.now(),
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
      time,
    });
  }
}

/**
 * When a stop triggered, and at what price if that was in a past candle.
 * Triggers fire on reaching the price — a stop is not in a queue — so a sell
 * stop goes off when the low touches it. From the book right now, the price is
 * left to walking the book.
 */
export function stopTriggeredAt(
  stop: PaperStop,
  candles: Candle[],
  book: L2Book | undefined,
  now: number,
): { time: number; price: number | undefined } | undefined {
  const from = Math.max(stop.placedAt, stop.candlesCheckedFrom ?? 0);
  for (const candle of candles) {
    if (candle.t < from) continue;
    const open = Number(candle.o);
    if (stop.side === "sell" && Number(candle.l) <= stop.triggerPrice) {
      return { time: candle.t, price: Math.min(stop.triggerPrice, open) };
    }
    if (stop.side === "buy" && Number(candle.h) >= stop.triggerPrice) {
      return { time: candle.t, price: Math.max(stop.triggerPrice, open) };
    }
  }
  if (!book) return undefined;
  const reached =
    stop.side === "sell"
      ? (bestBid(book) ?? Infinity) <= stop.triggerPrice
      : (bestAsk(book) ?? -Infinity) >= stop.triggerPrice;
  return reached ? { time: now, price: undefined } : undefined;
}

/**
 * When the market first traded strictly through a resting order, or undefined
 * if it has not: the earliest one-minute candle that opened after the order
 * rested and went through its price, else the book right now.
 */
export function tradedThroughAt(
  order: RestingOrder,
  candles: Candle[],
  book: L2Book | undefined,
  now: number,
): number | undefined {
  const from = Math.max(order.placedAt, order.candlesCheckedFrom ?? 0);
  for (const candle of candles) {
    if (candle.t < from) continue;
    const through =
      order.side === "buy" ? Number(candle.l) < order.price : Number(candle.h) > order.price;
    if (through) return candle.t;
  }
  if (!book) return undefined;
  const through =
    order.side === "buy"
      ? (bestAsk(book) ?? Infinity) < order.price
      : (bestBid(book) ?? -Infinity) > order.price;
  return through ? now : undefined;
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
