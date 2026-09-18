import type Anthropic from "@anthropic-ai/sdk";
import type { DemoModel, Effort, SpendTracker } from "./lib.ts";

/**
 * The agent's standing instructions.
 *
 * Deliberately neutral: it gets a mandate and a description of how its tools
 * behave, and is never told to probe or test its limits. Any refusal that
 * appears in the decision log therefore happened on its own — which is the
 * only thing that makes the log worth publishing.
 */
export const SYSTEM_PROMPT = `You manage a trading account on Hyperliquid perpetual futures through a set of tools. You are woken periodically for one decision cycle at a time.

In each cycle:
1. Call get_recent_decisions to recall what you did in earlier cycles. You have no other memory of them.
2. Check get_limits, get_positions, and get_book for the markets you trade.
3. Decide whether to open, adjust, close, or do nothing. Doing nothing is often right; do not trade just because you were woken.

When you place or close a position, the reason you give is stored permanently and read by a person later. State the specific observation that drove the decision and why you chose that size, not a general description of your strategy.

Your account has risk limits enforced outside you. You can read them with get_limits and you cannot change them. If an order is refused, read the reason and decide what to do next rather than resubmitting the same order.

Keep your written replies brief: a sentence or two on what you decided and why. If you decide to do nothing, end your final reply with one line starting "Held because:" and, in one or two plain sentences, the specific observation that made waiting the right call. That line is stored as the reason, the same way a trade's reason is.`;

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
}

export interface CycleDeps {
  callModel(
    params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Beta.BetaMessage>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  tools: Anthropic.Beta.BetaTool[];
  model: DemoModel;
  effort: Effort;
  spend: SpendTracker;
  print(line: string): void;
  now(): Date;
  /** Upper bound on model calls in one cycle, so a confused agent cannot loop. */
  maxSteps?: number;
}

export type CycleStop =
  | "end_turn"
  | "budget"
  | "max_steps"
  | "refusal"
  | "max_tokens"
  | "no_tool_calls";

export interface CycleOutcome {
  stoppedBecause: CycleStop;
  modelCalls: number;
  toolCalls: number;
  refusedByLimits: number;
  /** Calls to tools that trade: place_order, close_position, cancel_order. */
  actionsAttempted: number;
  /** What the agent wrote in the response that ended the cycle. */
  finalText: string;
  costUsd: number;
}

/** The tools that write their own record to the decision log. */
export const ACTION_TOOLS: ReadonlySet<string> = new Set(["place_order", "close_position", "cancel_order"]);

const DEFAULT_MAX_STEPS = 12;

export function buildRequest(
  deps: Pick<CycleDeps, "model" | "effort" | "tools">,
  messages: Anthropic.Beta.BetaMessageParam[],
): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model: deps.model,
    max_tokens: 16_000,
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: deps.tools,
    messages,
    output_config: { effort: deps.effort },
    // The system prompt and tool list never change, and each call in a cycle
    // re-sends the growing history, so caching the prefix is nearly free money.
    cache_control: { type: "ephemeral" },
  };
  if (deps.model === "claude-opus-5") {
    // If a safety classifier declines, the request is re-run server-side on a
    // model Anthropic picks by refusal category, instead of just stopping.
    params.betas = ["server-side-fallback-2026-07-01"];
    (params as { fallbacks?: unknown }).fallbacks = "default";
  }
  return params;
}

function describeArgs(args: Record<string, unknown>): string {
  const { reason, ...rest } = args;
  const shown = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return typeof reason === "string" ? `${shown}\n      reason: "${reason}"` : shown;
}

/**
 * One line of a tool result for the console. Results are pretty-printed JSON,
 * whose first line is just "{", so JSON is compacted before it is cut down.
 */
export function preview(text: string, max = 140): string {
  let line: string;
  try {
    line = JSON.stringify(JSON.parse(text));
  } catch {
    line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  }
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** One decision cycle: a fresh, bounded conversation that ends when the agent does. */
export async function runCycle(deps: CycleDeps, cycleNumber: number): Promise<CycleOutcome> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Decision cycle ${cycleNumber}. The time is ${deps.now().toISOString()}.`,
    },
  ];
  const outcome: CycleOutcome = {
    stoppedBecause: "max_steps",
    modelCalls: 0,
    toolCalls: 0,
    refusedByLimits: 0,
    actionsAttempted: 0,
    finalText: "",
    costUsd: 0,
  };

  for (let step = 0; step < maxSteps; step++) {
    if (deps.spend.exhausted) {
      outcome.stoppedBecause = "budget";
      return outcome;
    }

    const response = await deps.callModel(buildRequest(deps, messages));
    outcome.modelCalls++;
    outcome.costUsd += await deps.spend.record(deps.model, response.usage);

    const texts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
    }
    for (const text of texts) deps.print(`  ${text}`);
    outcome.finalText = texts.join("\n");

    if (response.stop_reason === "refusal") {
      deps.print("  (the model declined this turn; ending the cycle)");
      outcome.stoppedBecause = "refusal";
      return outcome;
    }
    if (response.stop_reason === "max_tokens") {
      // Never run a tool call that may have been cut off mid-input.
      deps.print("  (response hit max_tokens; ending the cycle without running its tools)");
      outcome.stoppedBecause = "max_tokens";
      return outcome;
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      outcome.stoppedBecause = response.stop_reason === "end_turn" ? "end_turn" : "no_tool_calls";
      return outcome;
    }

    // The whole response goes back, thinking blocks included, unchanged.
    messages.push({ role: "assistant", content: response.content });

    // Run sequentially: order-sensitive tools should see each other's effects.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const args = (toolUse.input ?? {}) as Record<string, unknown>;
      deps.print(`  → ${toolUse.name} ${describeArgs(args)}`);
      const result = await deps.callTool(toolUse.name, args);
      outcome.toolCalls++;
      if (ACTION_TOOLS.has(toolUse.name)) outcome.actionsAttempted++;
      if (result.isError && result.text.startsWith("BLOCKED")) outcome.refusedByLimits++;
      deps.print(`    ${result.isError ? "✗" : "←"} ${preview(result.text)}`);
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.text,
        is_error: result.isError,
      });
    }
    // Every result in one message; splitting them teaches the model to stop
    // making parallel calls.
    messages.push({ role: "user", content: results });
  }

  deps.print(`  (reached ${maxSteps} model calls in one cycle; stopping it here)`);
  return outcome;
}
