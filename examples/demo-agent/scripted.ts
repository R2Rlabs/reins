import type Anthropic from "@anthropic-ai/sdk";

/**
 * A stand-in for Claude that replays a fixed script.
 *
 * It exercises the whole pipeline — real Reins server, live Hyperliquid
 * prices, simulated fills, the decision log — without an API key or any API
 * spend. It is a wiring check, not a demo: every reason it writes is tagged
 * "[scripted]", and it logs to its own directory so nothing it produces can
 * end up in the decision log you publish.
 */

type Step = { text?: string; tool?: { name: string; input: Record<string, unknown> } };

const SCRIPT: Step[] = [
  { text: "Checking limits and recent history first.", tool: { name: "get_recent_decisions", input: { limit: 5 } } },
  { tool: { name: "get_limits", input: {} } },
  { tool: { name: "get_book", input: { symbol: "BTC", depth: 3 } } },
  {
    text: "Opening a small position to exercise the fill path.",
    tool: {
      name: "place_order",
      input: {
        symbol: "BTC",
        side: "buy",
        sizeUsd: 500,
        // Far below the market, so it never fires: this exercises placing a stop.
        stopLoss: 1_000,
        reason: "[scripted] Wiring check: a small marketable buy that fits inside every limit.",
      },
    },
  },
  {
    text: "Now an order deliberately over the cap, to exercise a refusal.",
    tool: {
      name: "place_order",
      input: {
        symbol: "BTC",
        side: "buy",
        sizeUsd: 50_000,
        stopLoss: 1_000,
        reason: "[scripted] Wiring check: deliberately oversized to confirm the position cap refuses it.",
      },
    },
  },
  {
    tool: {
      name: "close_position",
      input: { symbol: "BTC", reason: "[scripted] Wiring check: flatten what the first order opened." },
    },
  },
  { text: "Scripted check complete." },
];

export function scriptedModel(model: string) {
  let step = 0;
  return async (): Promise<Anthropic.Beta.BetaMessage> => {
    const entry = SCRIPT[Math.min(step, SCRIPT.length - 1)]!;
    step++;
    const content: unknown[] = [];
    if (entry.text) content.push({ type: "text", text: entry.text, citations: null });
    if (entry.tool) {
      content.push({ type: "tool_use", id: `toolu_scripted_${step}`, name: entry.tool.name, input: entry.tool.input });
    }
    return {
      id: `msg_scripted_${step}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: entry.tool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as unknown as Anthropic.Beta.BetaMessage;
  };
}
