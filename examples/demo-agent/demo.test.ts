import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionRecord } from "../../src/decision-log.js";
import { FileDecisionLog } from "../../src/decision-log-file.js";
import { buildRequest, preview, runCycle, SYSTEM_PROMPT, type CycleDeps, type ToolCallOutcome } from "./cycle.ts";
import {
  appendToLog,
  buildServerEnv,
  contextFromPositions,
  CycleCounter,
  estimateCostUsd,
  formatReport,
  holdReason,
  holdRecord,
  mcpToolsToClaude,
  parseDecisionLog,
  SpendTracker,
  summarize,
  toolResultText,
  type DemoServerConfig,
} from "./lib.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reins-demo-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

describe("estimateCostUsd", () => {
  it("prices plain input and output tokens", () => {
    // 1M in at $5, 1M out at $25.
    expect(
      estimateCostUsd("claude-opus-5", { ...zeroUsage, input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(30, 6);
  });

  it("charges cache writes at 1.25x and reads at 0.1x", () => {
    const cost = estimateCostUsd("claude-opus-5", {
      ...zeroUsage,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 * 1.25 + 5 * 0.1, 6);
  });

  it("treats missing cache fields as zero", () => {
    expect(
      estimateCostUsd("claude-sonnet-5", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }),
    ).toBeCloseTo(2, 6);
  });
});

describe("SpendTracker", () => {
  it("accumulates and persists across instances", async () => {
    const path = join(dir, "spend.json");
    const first = await SpendTracker.load(path, 10);
    await first.record("claude-opus-5", { ...zeroUsage, output_tokens: 40_000 }); // $1
    const second = await SpendTracker.load(path, 10);
    expect(second.spentUsd).toBeCloseTo(1, 6);
    expect(second.calls).toBe(1);
  });

  it("is exhausted once spend reaches the budget", async () => {
    const tracker = await SpendTracker.load(join(dir, "spend.json"), 1);
    expect(tracker.exhausted).toBe(false);
    await tracker.record("claude-opus-5", { ...zeroUsage, output_tokens: 40_000 });
    expect(tracker.exhausted).toBe(true);
    expect(tracker.remainingUsd).toBe(0);
  });

  it("can be reset", async () => {
    const tracker = await SpendTracker.load(join(dir, "spend.json"), 1);
    await tracker.record("claude-opus-5", { ...zeroUsage, output_tokens: 40_000 });
    await tracker.reset();
    expect(tracker.spentUsd).toBe(0);
    expect(tracker.exhausted).toBe(false);
  });

  it("refuses a nonsense budget", async () => {
    await expect(SpendTracker.load(join(dir, "s.json"), 0)).rejects.toThrow(RangeError);
    await expect(SpendTracker.load(join(dir, "s.json"), Number.NaN)).rejects.toThrow(RangeError);
  });
});

describe("CycleCounter", () => {
  it("starts at 1 and carries on across runs", async () => {
    const path = join(dir, "cycles.json");
    const first = await CycleCounter.load(path);
    expect(first.last).toBe(0);
    expect(await first.next()).toBe(1);
    expect(await first.next()).toBe(2);

    const second = await CycleCounter.load(path);
    expect(second.last).toBe(2);
    expect(await second.next()).toBe(3);
  });

  it("refuses a file that does not hold a count, rather than restarting at 1", async () => {
    const path = join(dir, "cycles.json");
    await writeFile(path, '{"last": "three"}', "utf8");
    await expect(CycleCounter.load(path)).rejects.toThrow(/does not hold a cycle count/);
  });
});

describe("MCP to Claude", () => {
  it("maps an MCP tool onto a Claude tool definition", () => {
    const [tool] = mcpToolsToClaude([
      {
        name: "get_book",
        description: "Top of book",
        inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
      },
    ]);
    expect(tool).toEqual({
      name: "get_book",
      description: "Top of book",
      input_schema: { type: "object", properties: { symbol: { type: "string" } } },
    });
  });

  it("gives a tool with no description an empty one", () => {
    const [tool] = mcpToolsToClaude([{ name: "x", inputSchema: { type: "object" } }]);
    expect(tool?.description).toBe("");
  });

  it("joins text content and marks anything else as omitted", () => {
    expect(
      toolResultText({
        content: [
          { type: "text", text: "one" },
          { type: "image" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\n[image content omitted]\ntwo");
    expect(toolResultText({ content: [] })).toBe("(empty result)");
  });
});

describe("buildServerEnv", () => {
  const config: DemoServerConfig = {
    network: "mainnet",
    symbols: ["BTC", "ETH"],
    maxPositionUsd: 2500,
    dailyLossUsd: 300,
    maxLeverage: 3,
    maxOrdersPerMin: 6,
    paperBalanceUsd: 10_000,
    builderFeeTenthsBps: 10,
    requireStopLoss: true,
    paperFile: "/data/paper.json",
    logFile: "/data/decisions.jsonl",
  };

  it("always runs the server in paper mode", () => {
    expect(buildServerEnv({}, config)["REINS_MODE"]).toBe("paper");
  });

  it("never lets a live setting or key from the shell through", () => {
    const hostile = {
      PATH: "/usr/bin",
      REINS_MODE: "live",
      REINS_PRIVATE_KEY: "0xdeadbeef",
      REINS_MAX_POSITION_USD: "999999",
    };
    const env = buildServerEnv(hostile, config);
    expect(env["REINS_MODE"]).toBe("paper");
    expect(env).not.toHaveProperty("REINS_PRIVATE_KEY");
    expect(env["REINS_MAX_POSITION_USD"]).toBe("2500");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("passes the demo's limits and file locations", () => {
    const env = buildServerEnv({}, config);
    expect(env).toMatchObject({
      REINS_NETWORK: "mainnet",
      REINS_SYMBOLS: "BTC,ETH",
      REINS_DAILY_LOSS_USD: "300",
      REINS_LOG_FILE: "/data/decisions.jsonl",
      REINS_PAPER_FILE: "/data/paper.json",
      REINS_REQUIRE_STOP_LOSS: "true",
    });
  });
});

describe("buildRequest", () => {
  const tools: Anthropic.Beta.BetaTool[] = [
    { name: "get_limits", description: "", input_schema: { type: "object" } },
  ];

  it("asks Opus 5 for server-side refusal fallbacks", () => {
    const params = buildRequest({ model: "claude-opus-5", effort: "high", tools }, []);
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect((params as { fallbacks?: unknown }).fallbacks).toBe("default");
  });

  it("does not send the fallback parameter to other models", () => {
    const params = buildRequest({ model: "claude-sonnet-5", effort: "medium", tools }, []);
    expect(params.betas).toBeUndefined();
    expect(params).not.toHaveProperty("fallbacks");
  });

  it("passes effort, the system prompt, and caching", () => {
    const params = buildRequest({ model: "claude-opus-5", effort: "medium", tools }, []);
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(params.system).toEqual([{ type: "text", text: SYSTEM_PROMPT }]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("SYSTEM_PROMPT", () => {
  it("never tells the agent to probe its limits", () => {
    // If it did, every refusal in the published log would be staged.
    expect(SYSTEM_PROMPT).not.toMatch(/probe|test (the|your) limits|exceed|push (the|your) limits/i);
  });
});

// --- the loop ----------------------------------------------------------------

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function message(content: Block[], stop_reason: string, outputTokens = 0): Anthropic.Beta.BetaMessage {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { ...zeroUsage, output_tokens: outputTokens },
  } as unknown as Anthropic.Beta.BetaMessage;
}

async function harness(
  responses: Anthropic.Beta.BetaMessage[],
  tool: (name: string, args: Record<string, unknown>) => ToolCallOutcome = () => ({ text: "ok", isError: false }),
  budget = 100,
) {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const printed: string[] = [];
  let i = 0;
  const deps: CycleDeps = {
    callModel: async (params) => {
      // Snapshot, because the loop keeps appending to the same array.
      requests.push(structuredClone(params));
      const next = responses[Math.min(i++, responses.length - 1)]!;
      return next;
    },
    callTool: async (name, args) => {
      toolCalls.push({ name, args });
      return tool(name, args);
    },
    tools: [],
    model: "claude-opus-5",
    effort: "high",
    spend: await SpendTracker.load(join(dir, "spend.json"), budget),
    print: (line) => printed.push(line),
    now: () => new Date("2026-09-17T12:00:00Z"),
  };
  return { deps, requests, toolCalls, printed };
}

describe("runCycle", () => {
  it("runs tool calls and ends when the agent ends its turn", async () => {
    const { deps, toolCalls } = await harness([
      message([{ type: "tool_use", id: "t1", name: "get_limits", input: {} }], "tool_use"),
      message([{ type: "text", text: "Nothing to do." }], "end_turn"),
    ]);
    const outcome = await runCycle(deps, 1);
    expect(outcome.stoppedBecause).toBe("end_turn");
    expect(toolCalls.map((c) => c.name)).toEqual(["get_limits"]);
    expect(outcome.modelCalls).toBe(2);
  });

  it("hands a refused order back to the model as an error", async () => {
    const { deps, requests } = await harness(
      [
        message(
          [{ type: "tool_use", id: "t1", name: "place_order", input: { symbol: "BTC", sizeUsd: 90_000 } }],
          "tool_use",
        ),
        message([{ type: "text", text: "Understood." }], "end_turn"),
      ],
      () => ({ text: "BLOCKED (POSITION_TOO_LARGE): over the cap", isError: true }),
    );
    const outcome = await runCycle(deps, 1);
    expect(outcome.refusedByLimits).toBe(1);

    const followUp = requests[1]!.messages.at(-1)!;
    const result = (followUp.content as Anthropic.Beta.BetaToolResultBlockParam[])[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect(result.content).toContain("BLOCKED");
  });

  it("returns every result from one turn in a single message", async () => {
    const { deps, requests } = await harness([
      message(
        [
          { type: "tool_use", id: "a", name: "get_limits", input: {} },
          { type: "tool_use", id: "b", name: "get_positions", input: {} },
        ],
        "tool_use",
      ),
      message([], "end_turn"),
    ]);
    await runCycle(deps, 1);
    const followUp = requests[1]!.messages.at(-1)!;
    expect(followUp.role).toBe("user");
    expect((followUp.content as unknown[]).length).toBe(2);
  });

  it("does not call the model once the budget is spent", async () => {
    const { deps, requests } = await harness(
      [
        message([{ type: "tool_use", id: "t", name: "get_limits", input: {} }], "tool_use", 40_000), // $1
        message([], "end_turn"),
      ],
      undefined,
      1,
    );
    const outcome = await runCycle(deps, 1);
    expect(outcome.stoppedBecause).toBe("budget");
    expect(requests).toHaveLength(1);
  });

  it("never runs tools from a response cut off at max_tokens", async () => {
    const { deps, toolCalls } = await harness([
      message([{ type: "tool_use", id: "t", name: "place_order", input: { symbol: "BT" } }], "max_tokens"),
    ]);
    const outcome = await runCycle(deps, 1);
    expect(outcome.stoppedBecause).toBe("max_tokens");
    expect(toolCalls).toHaveLength(0);
  });

  it("stops on a refusal", async () => {
    const { deps } = await harness([message([], "refusal")]);
    expect((await runCycle(deps, 1)).stoppedBecause).toBe("refusal");
  });

  it("caps the number of model calls in one cycle", async () => {
    const { deps, requests } = await harness([
      message([{ type: "tool_use", id: "t", name: "get_limits", input: {} }], "tool_use"),
    ]);
    deps.maxSteps = 3;
    const outcome = await runCycle(deps, 1);
    expect(outcome.stoppedBecause).toBe("max_steps");
    expect(requests).toHaveLength(3);
  });
});

describe("runCycle, for holds", () => {
  it("counts trading tools and keeps the reply that ended the cycle", async () => {
    const { deps } = await harness([
      message(
        [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "a", name: "get_book", input: { symbol: "BTC" } },
          { type: "tool_use", id: "b", name: "cancel_order", input: { oid: 1 } },
        ],
        "tool_use",
      ),
      message([{ type: "text", text: "Spread is wide; waiting." }], "end_turn"),
    ]);
    const outcome = await runCycle(deps, 1);
    expect(outcome.actionsAttempted).toBe(1);
    expect(outcome.finalText).toBe("Spread is wide; waiting.");
  });

  it("counts a refused order as an attempted action", async () => {
    const { deps } = await harness(
      [
        message([{ type: "tool_use", id: "t", name: "place_order", input: {} }], "tool_use"),
        message([{ type: "text", text: "Fine." }], "end_turn"),
      ],
      () => ({ text: "BLOCKED (POSITION_TOO_LARGE): over", isError: true }),
    );
    expect((await runCycle(deps, 1)).actionsAttempted).toBe(1);
  });
});

describe("holdRecord", () => {
  const at = new Date("2026-09-18T17:45:00Z");
  const held = { stoppedBecause: "end_turn" as const, actionsAttempted: 0, finalText: " Book is thin; waiting. " };

  it("records a cycle the agent ended without trading, in its own words", () => {
    expect(holdRecord(held, 3, at)).toEqual({
      id: "2026-09-18T17:45:00.000Z#hold",
      time: "2026-09-18T17:45:00.000Z",
      tool: "hold",
      reason: "Book is thin; waiting.",
      request: { cycle: 3 },
    });
  });

  it("is not written when the agent traded, since those records exist already", () => {
    expect(holdRecord({ ...held, actionsAttempted: 2 }, 1, at)).toBeUndefined();
  });

  it.each(["budget", "max_steps", "refusal", "max_tokens", "no_tool_calls"] as const)(
    "is not written when the cycle stopped on %s rather than by choice",
    (stoppedBecause) => {
      expect(holdRecord({ ...held, stoppedBecause }, 1, at)).toBeUndefined();
    },
  );

  it("stores only the Held because line when there is one", () => {
    const finalText = [
      "First cycle, one snapshot per market.",
      "",
      "BTC's book looks lopsided but that is one frame.",
      "",
      "**Held because:** no price history yet, and a single-snapshot",
      "imbalance is too noisy to trade on.",
    ].join("\n");
    expect(holdRecord({ ...held, finalText }, 1, at)?.reason).toBe(
      "no price history yet, and a single-snapshot imbalance is too noisy to trade on.",
    );
  });

  it("keeps the whole reply when there is no Held because line", () => {
    expect(holdReason("Nothing moved.\nWaiting.")).toBe("Nothing moved.\nWaiting.");
    expect(holdReason("Held because:")).toBe("Held because:");
  });

  it("takes the last Held because line, however it is marked up", () => {
    expect(holdReason("Held because: first\nmore\n- held because: second")).toBe("second");
    expect(holdReason("HELD BECAUSE : caps")).toBe("caps");
    expect(holdReason("I held because nothing moved.")).toBe("I held because nothing moved.");
  });

  it("says so when the agent gave no reason", () => {
    expect(holdRecord({ ...held, finalText: "" }, 1, at)?.reason).toMatch(/without saying why/);
  });

  it("takes account state from a get_positions result", () => {
    const text = JSON.stringify({ positionsUsd: { BTC: 500 }, accountValueUsd: 10_000, realizedPnlTodayUsd: -1.2 });
    expect(contextFromPositions(text)).toEqual({
      positionsUsd: { BTC: 500 },
      accountValueUsd: 10_000,
      realizedPnlTodayUsd: -1.2,
    });
    expect(contextFromPositions("Error: network")).toBeUndefined();
    expect(contextFromPositions('{"accountValueUsd": 1}')).toBeUndefined();
  });

  it("lands in the log where get_recent_decisions reads it back", async () => {
    const path = join(dir, "decisions.jsonl");
    const serverLog = new FileDecisionLog(path);
    await serverLog.append(record({ time: "2026-09-18T17:00:00.000Z" }));
    await appendToLog(path, holdRecord(held, 2, at)!);

    const [latest] = await serverLog.read(1);
    expect(latest).toMatchObject({ tool: "hold", reason: "Book is thin; waiting." });
    expect(parseDecisionLog(await readFile(path, "utf8"))).toHaveLength(2);
  });
});

// --- reporting ---------------------------------------------------------------

function record(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: "x",
    time: "2026-09-17T12:00:00.000Z",
    tool: "place_order",
    reason: "r",
    request: { symbol: "BTC", side: "buy", sizeUsd: 100 },
    ...overrides,
  };
}

describe("summarize", () => {
  it("counts fills, refusals, rejections and errors separately", () => {
    const summary = summarize([
      record({ risk: { allowed: true }, outcome: { kind: "filled", oid: 1, totalSize: "1", avgPrice: "1" } }),
      record({ risk: { allowed: false, code: "POSITION_TOO_LARGE", detail: "d" } }),
      record({ risk: { allowed: true }, outcome: { kind: "rejected", message: "min value" } }),
      record({ risk: { allowed: true }, error: "network" }),
      record({ tool: "cancel_order", outcome: { kind: "cancelled" } }),
    ]);
    expect(summary).toMatchObject({ placed: 2, filled: 1, rejectedByExchange: 1, errors: 1 });
    expect(summary.refusedByLimits).toHaveLength(1);
  });

  it("counts holds on their own, not as orders", () => {
    const hold = holdRecord(
      { stoppedBecause: "end_turn", actionsAttempted: 0, finalText: "Nothing worth doing." },
      1,
      new Date("2026-09-18T18:00:00Z"),
    )!;
    const summary = summarize([record({ risk: { allowed: true } }), hold]);
    expect(summary.placed).toBe(1);
    expect(summary.held).toEqual([hold]);
    expect(summary.lastAt).toBe(hold.time);

    const text = formatReport(summary, undefined, 10_000, undefined);
    expect(text).toContain("Chose not to trade in 1 cycle.");
    expect(text).toContain('"Nothing worth doing."');
  });

  it("skips a torn final line in the log", () => {
    const raw = `${JSON.stringify(record({}))}\n{"id":"tru`;
    expect(parseDecisionLog(raw)).toHaveLength(1);
  });

  it("puts the agent's own words next to each refusal", () => {
    const text = formatReport(
      summarize([
        record({
          reason: "Breakout, going large.",
          risk: { allowed: false, code: "POSITION_TOO_LARGE", detail: "d" },
        }),
      ]),
      undefined,
      10_000,
      { spentUsd: 1.5, calls: 12 },
    );
    expect(text).toContain("POSITION_TOO_LARGE");
    expect(text).toContain('"Breakout, going large."');
    expect(text).toContain("$1.50 across 12 calls");
    expect(text).toContain("no real money");
  });
});

describe("preview", () => {
  it("compacts pretty-printed JSON instead of showing a lone brace", () => {
    expect(preview('{\n  "kind": "filled",\n  "oid": 1\n}')).toBe('{"kind":"filled","oid":1}');
  });

  it("keeps the first line of plain text and truncates long lines", () => {
    expect(preview("BLOCKED (RATE_LIMITED): wait\nmore")).toBe("BLOCKED (RATE_LIMITED): wait");
    expect(preview("x".repeat(200), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
