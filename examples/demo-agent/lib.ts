import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { DecisionContext, DecisionRecord } from "../../src/decision-log.js";
import type { PaperState } from "../../src/paper.js";
import type { CycleOutcome } from "./cycle.ts";

// --- pricing ---------------------------------------------------------------

/** USD per million tokens. Cache writes bill at 1.25x input, cache reads at 0.1x. */
export const PRICES_PER_MTOK = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
} as const;

export type DemoModel = keyof typeof PRICES_PER_MTOK;
export const DEMO_MODELS = Object.keys(PRICES_PER_MTOK) as DemoModel[];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

type Usage = Pick<
  Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>;

/**
 * An estimate, not a bill. It prices every token at the requested model's
 * rates, so a turn a server-side fallback answered is priced as the model you
 * asked for rather than the one that ran.
 */
export function estimateCostUsd(model: DemoModel, usage: Usage): number {
  const price = PRICES_PER_MTOK[model];
  const input =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE_MULTIPLIER +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ_MULTIPLIER;
  return (input * price.input + usage.output_tokens * price.output) / 1_000_000;
}

// --- spending cap ----------------------------------------------------------

interface SpendFile {
  spentUsd: number;
  calls: number;
  updatedAt: string;
}

/**
 * A hard cap on what the demo may spend on the Claude API, persisted to disk.
 *
 * Cumulative across runs on purpose. A demo meant to run for weeks gets
 * restarted, and a cap that reset on every restart would not be a cap. The
 * check happens before each call, so a run can overshoot by at most the cost
 * of the one call in flight when the budget ran out.
 */
export class SpendTracker {
  readonly budgetUsd: number;
  private readonly path: string;
  private state: SpendFile;

  private constructor(path: string, budgetUsd: number, state: SpendFile) {
    this.path = path;
    this.budgetUsd = budgetUsd;
    this.state = state;
  }

  static async load(path: string, budgetUsd: number): Promise<SpendTracker> {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new RangeError(`Budget must be a positive number of USD, got ${budgetUsd}.`);
    }
    let state: SpendFile = { spentUsd: 0, calls: 0, updatedAt: new Date(0).toISOString() };
    try {
      state = JSON.parse(await readFile(path, "utf8")) as SpendFile;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    return new SpendTracker(path, budgetUsd, state);
  }

  get spentUsd(): number {
    return this.state.spentUsd;
  }

  get calls(): number {
    return this.state.calls;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.state.spentUsd);
  }

  get exhausted(): boolean {
    return this.state.spentUsd >= this.budgetUsd;
  }

  /** Records one API call and returns what it cost. */
  async record(model: DemoModel, usage: Usage): Promise<number> {
    const cost = estimateCostUsd(model, usage);
    this.state = {
      spentUsd: this.state.spentUsd + cost,
      calls: this.state.calls + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    return cost;
  }

  async reset(): Promise<void> {
    this.state = { spentUsd: 0, calls: 0, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(temp, this.path);
  }
}

// --- MCP <-> Claude --------------------------------------------------------

export interface McpToolDescription {
  name: string;
  description?: string | undefined;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/** MCP already describes tools in JSON Schema, which is what Claude takes. */
export function mcpToolsToClaude(tools: McpToolDescription[]): Anthropic.Beta.BetaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: { ...tool.inputSchema, type: "object" },
  }));
}

export interface McpToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean | undefined;
}

export function toolResultText(result: McpToolResult): string {
  const parts = result.content.map((part) =>
    part.type === "text" && typeof part.text === "string"
      ? part.text
      : `[${part.type} content omitted]`,
  );
  return parts.join("\n") || "(empty result)";
}

// --- the server's environment ----------------------------------------------

export interface DemoServerConfig {
  network: "mainnet" | "testnet";
  symbols: string[];
  maxPositionUsd: number;
  dailyLossUsd: number;
  maxLeverage: number;
  maxOrdersPerMin: number;
  paperBalanceUsd: number;
  builderFeeTenthsBps: number;
  paperFile: string;
  logFile: string;
}

/**
 * The Reins server's environment, built from scratch rather than inherited.
 *
 * This is the only guarantee that matters in the demo: whatever is in the
 * shell that launches it, the server it talks to is in paper mode and has no
 * key. A `REINS_MODE=live` or `REINS_PRIVATE_KEY` left in someone's profile
 * never reaches it.
 */
export function buildServerEnv(
  base: Record<string, string>,
  config: DemoServerConfig,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("REINS_")) env[key] = value;
  }
  Object.assign(env, {
    REINS_MODE: "paper",
    REINS_NETWORK: config.network,
    REINS_SYMBOLS: config.symbols.join(","),
    REINS_MAX_POSITION_USD: String(config.maxPositionUsd),
    REINS_DAILY_LOSS_USD: String(config.dailyLossUsd),
    REINS_MAX_LEVERAGE: String(config.maxLeverage),
    REINS_MAX_ORDERS_PER_MIN: String(config.maxOrdersPerMin),
    REINS_PAPER_BALANCE: String(config.paperBalanceUsd),
    REINS_PAPER_FILE: config.paperFile,
    REINS_LOG_FILE: config.logFile,
    // A builder address only switches the fee on; paper mode never sends
    // anything, so this one is never used for real. It is here so simulated
    // trades pay what a real user of Reins would.
    REINS_BUILDER_ADDRESS: "0x000000000000000000000000000000000000dead",
    REINS_BUILDER_FEE_TENTHS_BPS: String(config.builderFeeTenthsBps),
  });

  if (env["REINS_MODE"] !== "paper" || "REINS_PRIVATE_KEY" in env) {
    throw new Error("Refusing to start: the demo server must be in paper mode with no key.");
  }
  return env;
}

// --- holds -----------------------------------------------------------------

/**
 * A cycle in which the agent chose not to trade.
 *
 * Reins only logs actions, so without this a cycle spent waiting leaves no
 * trace, and a sensible agent that mostly waits would publish a log that looks
 * like it did nothing. It goes in the same file as the actions, so the agent
 * reads its own earlier holds back through get_recent_decisions, and it has
 * the same shape: `reason` is the agent's final reply, testimony like any
 * other reason in the log.
 */
export interface HoldRecord {
  id: string;
  time: string;
  tool: "hold";
  reason: string;
  request: { cycle: number };
  context?: DecisionContext;
}

export type LogRecord = DecisionRecord | HoldRecord;

const HELD_BECAUSE = /^[\s*_#>-]*held because[\s*_]*:[\s*_]*/im;

/**
 * The reason to store for a hold: the "Held because:" line the system prompt
 * asks for, or the whole reply when the agent did not write one. Only the last
 * such line counts, and markdown emphasis around it is dropped, since the log
 * is read as plain text.
 */
export function holdReason(finalText: string): string {
  const lines = finalText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!HELD_BECAUSE.test(line)) continue;
    const reason = [line.replace(HELD_BECAUSE, ""), ...lines.slice(i + 1)]
      .join(" ")
      .replace(/\*\*|__/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (reason) return reason;
  }
  return finalText.trim();
}

/**
 * The hold record for a finished cycle, or undefined when there should not be
 * one: the agent traded (its actions are already logged), or the cycle ended
 * for some reason other than the agent deciding it was done.
 */
export function holdRecord(
  outcome: Pick<CycleOutcome, "stoppedBecause" | "actionsAttempted" | "finalText">,
  cycle: number,
  time: Date,
  context?: DecisionContext,
): HoldRecord | undefined {
  if (outcome.stoppedBecause !== "end_turn" || outcome.actionsAttempted > 0) return undefined;
  const iso = time.toISOString();
  return {
    id: `${iso}#hold`,
    time: iso,
    tool: "hold",
    reason: holdReason(outcome.finalText) || "(the agent ended the cycle without saying why)",
    request: { cycle },
    ...(context ? { context } : {}),
  };
}

/** Account state from a get_positions result, or undefined if it is not one. */
export function contextFromPositions(text: string): DecisionContext | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<DecisionContext>;
    if (
      typeof parsed.accountValueUsd !== "number" ||
      typeof parsed.realizedPnlTodayUsd !== "number" ||
      typeof parsed.positionsUsd !== "object" ||
      parsed.positionsUsd === null
    ) {
      return undefined;
    }
    return {
      accountValueUsd: parsed.accountValueUsd,
      realizedPnlTodayUsd: parsed.realizedPnlTodayUsd,
      positionsUsd: parsed.positionsUsd,
    };
  } catch {
    return undefined;
  }
}

/**
 * Appends one line to the decision log. The server writes the same file, but
 * only while a tool call is in flight, and this runs after the cycle's last
 * one has returned, so the two never write at once.
 */
export async function appendToLog(path: string, record: LogRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

// --- reporting -------------------------------------------------------------

export interface DemoSummary {
  decisions: number;
  placed: number;
  filled: number;
  refusedByLimits: DecisionRecord[];
  held: HoldRecord[];
  rejectedByExchange: number;
  errors: number;
  firstAt?: string;
  lastAt?: string;
}

export function summarize(records: LogRecord[]): DemoSummary {
  const ordered = [...records].sort((a, b) => a.time.localeCompare(b.time));
  const summary: DemoSummary = {
    decisions: ordered.length,
    placed: 0,
    filled: 0,
    refusedByLimits: [],
    held: [],
    rejectedByExchange: 0,
    errors: 0,
  };
  for (const record of ordered) {
    if (record.tool === "hold") {
      summary.held.push(record);
      continue;
    }
    if (record.risk && !record.risk.allowed) {
      summary.refusedByLimits.push(record);
      continue;
    }
    if (record.error) {
      summary.errors++;
      continue;
    }
    if (record.tool === "cancel_order") continue;
    summary.placed++;
    if (record.outcome?.kind === "filled") summary.filled++;
    if (record.outcome?.kind === "rejected") summary.rejectedByExchange++;
  }
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first) summary.firstAt = first.time;
  if (last) summary.lastAt = last.time;
  return summary;
}

export function parseDecisionLog(raw: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as LogRecord);
    } catch {
      // A torn final line should not hide everything before it.
    }
  }
  return records;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatReport(
  summary: DemoSummary,
  paper: PaperState | undefined,
  openingBalanceUsd: number,
  spend: { spentUsd: number; calls: number } | undefined,
): string {
  const lines: string[] = [];
  lines.push("Reins demo — an AI agent trading Hyperliquid on paper");
  if (summary.firstAt && summary.lastAt) {
    lines.push(`${summary.firstAt.slice(0, 16)} → ${summary.lastAt.slice(0, 16)} UTC`);
  }
  lines.push("");

  if (paper) {
    const change = paper.balanceUsd - openingBalanceUsd;
    const pct = (change / openingBalanceUsd) * 100;
    const fees = paper.fills.reduce((sum, fill) => sum + fill.feeUsd, 0);
    lines.push(
      `Realised balance: ${usd(openingBalanceUsd)} → ${usd(paper.balanceUsd)} ` +
        `(${change >= 0 ? "+" : ""}${pct.toFixed(2)}%), net of ${usd(fees)} in fees`,
    );
    const open = Object.entries(paper.positions);
    lines.push(
      open.length === 0
        ? "Open positions: none"
        : `Open positions: ${open
            .map(([s, p]) => `${s} ${p.size > 0 ? "long" : "short"} ${Math.abs(p.size)} @ ${p.entryPrice.toFixed(1)}`)
            .join(", ")} (unrealised PnL not included)`,
    );
    lines.push("");
  }

  lines.push(
    `Actions: ${summary.placed} orders sent, ${summary.filled} filled, ` +
      `${summary.refusedByLimits.length} refused by the limits, ` +
      `${summary.rejectedByExchange} rejected by the market`,
  );

  const lastHold = summary.held.at(-1);
  if (lastHold) {
    const n = summary.held.length;
    lines.push(
      "",
      `Chose not to trade in ${n} cycle${n === 1 ? "" : "s"}. The most recent, in the agent's own words:`,
      `  ${lastHold.time.slice(0, 16)}  "${lastHold.reason}"`,
    );
  }

  if (summary.refusedByLimits.length > 0) {
    lines.push("", "Refused by the limits, in the agent's own words:");
    for (const record of summary.refusedByLimits) {
      const req = record.request as { symbol?: string; side?: string; sizeUsd?: number };
      const what = [req.symbol, req.side, req.sizeUsd !== undefined ? usd(req.sizeUsd) : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`  ${record.time.slice(0, 16)}  ${record.tool} ${what} — ${record.risk?.code}`);
      lines.push(`    "${record.reason}"`);
    }
  }

  if (spend) {
    lines.push("", `Claude API spend: ${usd(spend.spentUsd)} across ${spend.calls} calls (estimated)`);
  }
  lines.push("", "Paper trading: live Hyperliquid prices, simulated fills, no real money.");
  return lines.join("\n");
}
