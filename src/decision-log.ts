import type { Decision, RiskCode } from "./risk.js";
import type { CancelOutcome, OrderOutcome } from "./types.js";

/**
 * An append-only record of every action an agent attempted.
 *
 * Blocked attempts are recorded as carefully as successful ones — arguably more
 * carefully. "The agent tried to open six times its position cap at 3am, and
 * here is what it said it was doing" is the single most useful thing this
 * system can tell you, and it only exists if refusals are written down.
 *
 * ## On `reason`
 *
 * The `reason` on each record is the model's own stated rationale, captured
 * because there is no other way to get it: reasoning that is not asked for is
 * not recoverable afterwards. It is a self-report, not ground truth — a model
 * can rationalise after the fact, and a confident explanation is not evidence
 * that the explanation is what actually drove the decision. Treat it as
 * testimony, useful for debugging and audit, not as proof of mechanism.
 */

export type DecisionTool = "place_order" | "close_position" | "cancel_order" | "set_stop_loss";

export interface DecisionContext {
  accountValueUsd: number;
  realizedPnlTodayUsd: number;
  positionsUsd: Record<string, number>;
}

export interface DecisionRisk {
  allowed: boolean;
  code?: RiskCode;
  detail?: string;
}

export interface DecisionRecord {
  id: string;
  time: string;
  tool: DecisionTool;
  /** The agent's stated rationale. See the note above on what this is worth. */
  reason: string;
  request: Record<string, unknown>;
  context?: DecisionContext;
  risk?: DecisionRisk;
  outcome?: OrderOutcome | CancelOutcome;
  /** Set when the attempt failed for a reason other than a risk block. */
  error?: string;
}

export interface DecisionLog {
  append(record: DecisionRecord): Promise<void>;
  /** Most recent first. */
  read(limit: number): Promise<DecisionRecord[]>;
}

export class MemoryDecisionLog implements DecisionLog {
  readonly records: DecisionRecord[] = [];

  async append(record: DecisionRecord): Promise<void> {
    this.records.push(record);
  }

  async read(limit: number): Promise<DecisionRecord[]> {
    return this.records.slice(-limit).reverse();
  }
}

/** Turns a risk decision into the shape stored on a record. */
export function riskOf(decision: Decision): DecisionRisk {
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, code: decision.code, detail: decision.reason };
}

/**
 * Sortable, human-readable ids with no dependency on a UUID implementation.
 * Line order in the log is already the true ordering; this exists so a record
 * can be referred to.
 */
export function createIdFactory(now: () => number = Date.now): () => string {
  let sequence = 0;
  return () => `${new Date(now()).toISOString()}#${(sequence++).toString(36)}`;
}
