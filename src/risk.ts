/**
 * The risk engine. Every order an agent requests passes through `check()`
 * before it is allowed anywhere near Hyperliquid.
 *
 * This lives outside the model on purpose. An agent is told its limits exist
 * (via get_limits) but has no tool that can change them, so no amount of
 * reasoning, retrying or prompt injection gets past this file.
 */

export interface RiskLimits {
  /** Largest notional position, in USD, the agent may hold in one symbol. */
  maxPositionUsd: number;
  /** Largest account-wide leverage the agent may reach. */
  maxLeverage: number;
  /** Realised loss for the day that halts the agent entirely. */
  dailyLossLimitUsd: number;
  /** Symbols the agent may touch. Empty means none. */
  symbolAllowlist: string[];
  /** Orders per rolling 60s window. */
  maxOrdersPerMinute: number;
}

export interface AccountState {
  /** Current notional exposure per symbol, in USD. Signed: negative is short. */
  positionsUsd: Record<string, number>;
  /** Realised PnL since the start of the UTC day, in USD. Negative is a loss. */
  realizedPnlTodayUsd: number;
  /** Total account value in USD, used for the leverage check. */
  accountValueUsd: number;
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  /** Notional size of this order in USD. Always positive. */
  sizeUsd: number;
  /** Orders that can only shrink an existing position skip most checks. */
  reduceOnly?: boolean;
}

export type RiskCode =
  | "HALTED_DAILY_LOSS"
  | "SYMBOL_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "POSITION_TOO_LARGE"
  | "LEVERAGE_TOO_HIGH"
  | "INVALID_ORDER";

export type Decision =
  | { allowed: true }
  | { allowed: false; code: RiskCode; reason: string };

const WINDOW_MS = 60_000;

export class RiskEngine {
  private readonly limits: RiskLimits;
  private readonly now: () => number;
  private orderTimes: number[] = [];

  constructor(limits: RiskLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  /**
   * A read-only copy of the limits. Deliberately a copy: the agent is shown
   * these through get_limits, and handing out the live object would give
   * anything downstream a way to edit them.
   */
  get configuredLimits(): Readonly<RiskLimits> {
    return Object.freeze({
      ...this.limits,
      symbolAllowlist: [...this.limits.symbolAllowlist],
    });
  }

  /** Orders still permitted in the current rolling minute. */
  ordersRemaining(): number {
    return Math.max(0, this.limits.maxOrdersPerMinute - this.ordersInWindow());
  }

  /**
   * True once the day's realised loss has breached the limit. A halted agent
   * can still close positions, but cannot open or add to them.
   */
  isHalted(state: AccountState): boolean {
    return state.realizedPnlTodayUsd <= -Math.abs(this.limits.dailyLossLimitUsd);
  }

  /**
   * Decide whether an order may proceed. Pure apart from the rate-limit clock,
   * so it is safe to call speculatively — call `recordOrder()` only once the
   * order is actually sent.
   */
  check(order: OrderRequest, state: AccountState): Decision {
    if (!Number.isFinite(order.sizeUsd) || order.sizeUsd <= 0) {
      return {
        allowed: false,
        code: "INVALID_ORDER",
        reason: `Order size must be a positive number, got ${order.sizeUsd}.`,
      };
    }

    // Reduce-only orders lower risk, so they survive a halt and the size and
    // leverage caps. They still respect the allowlist and the rate limit,
    // because a runaway loop of closes is its own kind of damage.
    const reducing = order.reduceOnly === true;

    if (!this.limits.symbolAllowlist.includes(order.symbol)) {
      return {
        allowed: false,
        code: "SYMBOL_NOT_ALLOWED",
        reason:
          `${order.symbol} is not on the allowlist ` +
          `(${this.limits.symbolAllowlist.join(", ") || "empty"}).`,
      };
    }

    if (this.ordersInWindow() >= this.limits.maxOrdersPerMinute) {
      return {
        allowed: false,
        code: "RATE_LIMITED",
        reason:
          `${this.limits.maxOrdersPerMinute} orders per minute already sent. ` +
          `Wait before placing another.`,
      };
    }

    if (reducing) return { allowed: true };

    if (this.isHalted(state)) {
      return {
        allowed: false,
        code: "HALTED_DAILY_LOSS",
        reason:
          `Daily loss limit of $${this.limits.dailyLossLimitUsd.toLocaleString()} ` +
          `was hit (realised $${state.realizedPnlTodayUsd.toLocaleString()}). ` +
          `Only reduce-only orders are accepted until the next UTC day.`,
      };
    }

    const projected = projectedPositionUsd(order, state);
    if (Math.abs(projected) > this.limits.maxPositionUsd) {
      return {
        allowed: false,
        code: "POSITION_TOO_LARGE",
        reason:
          `Would put ${order.symbol} at $${Math.abs(projected).toLocaleString()}, ` +
          `over the $${this.limits.maxPositionUsd.toLocaleString()} cap.`,
      };
    }

    const exposure = projectedTotalExposureUsd(order, state);
    if (state.accountValueUsd <= 0) {
      return {
        allowed: false,
        code: "LEVERAGE_TOO_HIGH",
        reason: "Account value is zero or negative; no new risk may be opened.",
      };
    }
    const leverage = exposure / state.accountValueUsd;
    if (leverage > this.limits.maxLeverage) {
      return {
        allowed: false,
        code: "LEVERAGE_TOO_HIGH",
        reason:
          `Would put account leverage at ${leverage.toFixed(2)}x, ` +
          `over the ${this.limits.maxLeverage}x cap.`,
      };
    }

    return { allowed: true };
  }

  /** Call once an order has actually been submitted. */
  recordOrder(): void {
    this.orderTimes.push(this.now());
  }

  private ordersInWindow(): number {
    const cutoff = this.now() - WINDOW_MS;
    this.orderTimes = this.orderTimes.filter((t) => t > cutoff);
    return this.orderTimes.length;
  }
}

/** Signed notional the symbol would hold if this order filled completely. */
export function projectedPositionUsd(
  order: OrderRequest,
  state: AccountState,
): number {
  const current = state.positionsUsd[order.symbol] ?? 0;
  const delta = order.side === "buy" ? order.sizeUsd : -order.sizeUsd;
  return current + delta;
}

/** Gross exposure across every symbol if this order filled completely. */
export function projectedTotalExposureUsd(
  order: OrderRequest,
  state: AccountState,
): number {
  let total = 0;
  for (const [symbol, notional] of Object.entries(state.positionsUsd)) {
    if (symbol === order.symbol) continue;
    total += Math.abs(notional);
  }
  return total + Math.abs(projectedPositionUsd(order, state));
}
