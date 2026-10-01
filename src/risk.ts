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
  /**
   * No new risk without a stop. When set, an order that opens or adds to a
   * position must carry its own stop-loss, and is refused while some position
   * has no stop covering all of it. The agent's own "I'll exit below X" becomes
   * an order the exchange executes whether or not the agent is awake.
   */
  requireStopLoss?: boolean;
  /**
   * Most a single trade may lose if its stop fills at the trigger, in USD.
   * The position cap limits how much is at stake; this limits how much of it
   * is actually risked, which is the number that decides a losing run: a
   * $2,500 position with a stop 5% away risks ten times one with a stop 0.5%
   * away. Checked against `riskUsd` on orders that add risk.
   */
  maxTradeRiskUsd?: number;
  /**
   * How close to liquidation a position may sit before the agent is refused
   * more risk, as a percentage of mark.
   *
   * The other caps measure notional; the exchange measures margin, and they
   * are not the same thing. A position inside the size cap, under max leverage
   * and carrying a stop can still be a wick away from being closed by the
   * exchange — at which point the stop never fires, because the position is
   * already gone. This is the limit that notices.
   */
  minLiquidationDistancePct?: number;
}

export interface AccountState {
  /** Current notional exposure per symbol, in USD. Signed: negative is short. */
  positionsUsd: Record<string, number>;
  /** Realised PnL since the start of the UTC day, in USD. Negative is a loss. */
  realizedPnlTodayUsd: number;
  /** Total account value in USD, used for the leverage check. */
  accountValueUsd: number;
  /** Symbols holding a position that no stop-loss fully covers. */
  unprotectedSymbols?: string[];
  /**
   * How far each position sits from its liquidation price, as a percentage of
   * mark. Absent where the venue does not report one — paper trading has no
   * margin engine — and a missing entry is never treated as safe or unsafe,
   * only as unknown.
   */
  liquidationDistancePct?: Record<string, number>;
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  /** Notional size of this order in USD. Always positive. */
  sizeUsd: number;
  /** Orders that can only shrink an existing position skip most checks. */
  reduceOnly?: boolean;
  /** Carries a stop-loss, placed as the order fills. */
  hasStopLoss?: boolean;
  /**
   * What this order loses if its stop fills at the trigger price: the
   * distance from entry to stop, times the size. The caller works it out,
   * because only it knows the entry price the order will use.
   */
  riskUsd?: number;
}

export type RiskCode =
  | "HALTED_DAILY_LOSS"
  | "NO_STOP_LOSS"
  | "TRADE_RISK_TOO_LARGE"
  | "SYMBOL_NOT_ALLOWED"
  | "RATE_LIMITED"
  | "POSITION_TOO_LARGE"
  | "LEVERAGE_TOO_HIGH"
  | "LIQUIDATION_TOO_CLOSE"
  | "INVALID_ORDER";

export type Decision =
  | { allowed: true }
  | { allowed: false; code: RiskCode; reason: string };

const WINDOW_MS = 60_000;

/**
 * Money in refusal messages. A fixed locale and at most two decimals, so the
 * agent and the published decision log read the same on every machine.
 */
function usd(value: number): string {
  const amount = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${value < 0 ? "-" : ""}$${amount}`;
}

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
          `Daily loss limit of ${usd(this.limits.dailyLossLimitUsd)} ` +
          `was hit (realised ${usd(state.realizedPnlTodayUsd)}). ` +
          `Only reduce-only orders are accepted until the next UTC day.`,
      };
    }

    const projected = projectedPositionUsd(order, state);
    const current = state.positionsUsd[order.symbol] ?? 0;
    const addsRisk =
      Math.abs(projected) > Math.abs(current) || Math.sign(projected) * Math.sign(current) < 0;

    if (this.limits.requireStopLoss && addsRisk) {
      // An order carrying its own stop will cover its symbol, so only other
      // unprotected positions stand in its way.
      const unprotected = (state.unprotectedSymbols ?? []).filter(
        (symbol) => !(order.hasStopLoss && symbol === order.symbol),
      );
      if (unprotected.length > 0) {
        return {
          allowed: false,
          code: "NO_STOP_LOSS",
          reason:
            `${unprotected.join(", ")} ${unprotected.length === 1 ? "has" : "have"} no stop-loss ` +
            `covering the whole position. Set one with set_stop_loss before adding risk.`,
        };
      }
      if (!order.hasStopLoss) {
        return {
          allowed: false,
          code: "NO_STOP_LOSS",
          reason:
            "An order that opens or adds to a position must carry a stopLoss, so the " +
            "position is never open without one.",
        };
      }
    }

    // How far the stop sits, not how big the order is, decides what a losing
    // trade costs. Size and stop distance are only safe together.
    const maxRisk = this.limits.maxTradeRiskUsd;
    if (maxRisk !== undefined && addsRisk && order.riskUsd !== undefined && order.riskUsd > maxRisk) {
      return {
        allowed: false,
        code: "TRADE_RISK_TOO_LARGE",
        reason:
          `Stopping out would lose ${usd(order.riskUsd)}, over the ${usd(maxRisk)} allowed on one trade. ` +
          `Move the stop closer or send a smaller order.`,
      };
    }

    if (Math.abs(projected) > this.limits.maxPositionUsd) {
      return {
        allowed: false,
        code: "POSITION_TOO_LARGE",
        reason:
          `Would put ${order.symbol} at ${usd(Math.abs(projected))}, ` +
          `over the ${usd(this.limits.maxPositionUsd)} cap.`,
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

    const minDistance = this.limits.minLiquidationDistancePct;
    if (minDistance !== undefined && addsRisk) {
      const distances = state.liquidationDistancePct ?? {};
      // Every open position matters, not just this symbol: under cross margin
      // a new position anywhere draws on the same margin that is keeping the
      // others alive.
      const tooClose = Object.entries(distances)
        .filter(([, distance]) => Number.isFinite(distance) && distance < minDistance)
        .sort((a, b) => a[1] - b[1]);
      const nearest = tooClose[0];
      if (nearest) {
        return {
          allowed: false,
          code: "LIQUIDATION_TOO_CLOSE",
          reason:
            `${nearest[0]} is ${nearest[1].toFixed(2)}% from liquidation, inside the ` +
            `${minDistance}% required before adding risk. Reduce it or add margin first.`,
        };
      }
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
