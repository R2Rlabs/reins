/**
 * Reins demo agent: Claude trading Hyperliquid on paper, through the Reins
 * MCP server, with every decision written to a log you can publish.
 *
 *   npm run build                         # the demo drives the built server
 *   npm run demo -- --scripted            # free wiring check, no API key
 *   ANTHROPIC_API_KEY=... npm run demo -- --once
 *   ANTHROPIC_API_KEY=... npm run demo    # a cycle every hour until the budget runs out
 *   npm run demo:report                   # a postable summary of the run so far
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runCycle, type CycleDeps } from "./cycle.ts";
import {
  appendToLog,
  buildServerEnv,
  contextFromPositions,
  CycleCounter,
  holdRecord,
  DEMO_MODELS,
  EFFORTS,
  mcpToolsToClaude,
  SpendTracker,
  toolResultText,
  type DemoModel,
  type DemoServerConfig,
  type Effort,
  type McpToolDescription,
  type McpToolResult,
} from "./lib.ts";
import { scriptedModel } from "./scripted.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The account the agent trades. Mainnet prices so the market is real; paper
 * fills so the money is not. Edit these to change the demo's limits.
 */
const SERVER: Omit<DemoServerConfig, "paperFile" | "logFile"> = {
  network: "mainnet",
  symbols: ["BTC", "ETH"],
  maxPositionUsd: 2_500,
  dailyLossUsd: 300,
  maxLeverage: 3,
  maxOrdersPerMin: 6,
  paperBalanceUsd: 10_000,
  // Run 2's trades each risked about $20; this caps a careless one.
  maxTradeRiskUsd: 30,
  // Every position gets a stop the exchange holds, so an exit the agent
  // describes is one that happens even between cycles.
  requireStopLoss: true,
};

const HELP = `Reins demo agent — Claude trading Hyperliquid on paper through Reins.

Options:
  --scripted              Replay a fixed script instead of calling Claude. Free; no key.
  --once                  Run a single decision cycle, then exit.
  --cycles <n>            Stop after n cycles.
  --interval-minutes <n>  Minutes between cycles (default 60).
  --budget-usd <n>        Hard cap on Claude API spend, across all runs (default 5).
  --reset-spend           Zero the spend counter before starting.
  --model <id>            ${DEMO_MODELS.join(" | ")} (default claude-opus-5).
  --effort <level>        ${EFFORTS.join(" | ")} (default high, the API default).
  --data-dir <path>       Where the log, paper account and spend live (default demo-data).
  --idle-when-spent       On a spent budget, wait until stopped instead of exiting. For
                          servers that restart whatever exits.
  --help`;

/**
 * For a server: sit still instead of exiting. A supervisor that restarts
 * whatever exits would otherwise restart a demo with no budget left, watch it
 * exit again, and loop. Ends on SIGINT or SIGTERM.
 */
function idleUntilStopped(): Promise<void> {
  console.log("Idling until stopped (--idle-when-spent).");
  const keepAlive = setInterval(() => undefined, 1 << 30);
  return new Promise((resolve) => {
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scripted: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      cycles: { type: "string" },
      "interval-minutes": { type: "string", default: "60" },
      "budget-usd": { type: "string", default: "5" },
      "reset-spend": { type: "boolean", default: false },
      model: { type: "string", default: "claude-opus-5" },
      effort: { type: "string", default: "high" },
      "data-dir": { type: "string" },
      "idle-when-spent": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const model = values.model as DemoModel;
  if (!DEMO_MODELS.includes(model)) fail(`--model must be one of: ${DEMO_MODELS.join(", ")}`);
  const effort = values.effort as Effort;
  if (!EFFORTS.includes(effort)) fail(`--effort must be one of: ${EFFORTS.join(", ")}`);

  const intervalMinutes = Number(values["interval-minutes"]);
  if (!(intervalMinutes > 0)) fail("--interval-minutes must be a positive number.");
  const maxCycles = values.scripted || values.once ? 1 : values.cycles ? Number(values.cycles) : Infinity;
  if (!(maxCycles >= 1)) fail("--cycles must be at least 1.");

  const serverPath = join(REPO_ROOT, "dist", "bin", "serve.js");
  if (!existsSync(serverPath)) fail("The Reins server is not built yet. Run `npm run build` first.");

  // Scripted runs get their own directory so a wiring check can never leak
  // into the decision log that gets published.
  const dataDir = resolve(
    REPO_ROOT,
    values["data-dir"] ?? (values.scripted ? join("demo-data", "scripted") : "demo-data"),
  );
  const paperFile = join(dataDir, "paper-account.json");
  const logFile = join(dataDir, "decisions.jsonl");

  const spend = await SpendTracker.load(join(dataDir, "spend.json"), Number(values["budget-usd"]));
  const cycles = await CycleCounter.load(join(dataDir, "cycles.json"));
  if (values["reset-spend"]) await spend.reset();
  if (spend.exhausted && !values.scripted) {
    const message =
      `The budget is spent: $${spend.spentUsd.toFixed(2)} of $${spend.budgetUsd.toFixed(2)}.\n` +
      "Raise it with --budget-usd, or start over with --reset-spend.";
    if (!values["idle-when-spent"]) fail(message);
    console.log(message);
    await idleUntilStopped();
    return;
  }

  let callModel: CycleDeps["callModel"];
  if (values.scripted) {
    callModel = scriptedModel(model);
  } else {
    let anthropic: Anthropic;
    try {
      anthropic = new Anthropic();
    } catch {
      fail("No Claude API credentials found. Set ANTHROPIC_API_KEY, or use --scripted for a free check.");
    }
    callModel = (params) => anthropic.beta.messages.create(params);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: buildServerEnv(getDefaultEnvironment(), { ...SERVER, paperFile, logFile }),
  });
  const mcp = new Client({ name: "reins-demo-agent", version: "0.0.1" });
  await mcp.connect(transport);

  let stopping = false;
  let budgetSpent = false;
  const wake = new AbortController();
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    wake.abort();
    console.log("\nStopping after the current cycle. Press Ctrl+C again to quit now.");
  });

  try {
    const { tools: mcpTools } = await mcp.listTools();
    const deps: CycleDeps = {
      callModel,
      callTool: async (name, args) => {
        const result = (await mcp.callTool({ name, arguments: args })) as McpToolResult;
        return { text: toolResultText(result), isError: result.isError === true };
      },
      tools: mcpToolsToClaude(mcpTools as McpToolDescription[]),
      model,
      effort,
      spend,
      print: (line) => console.log(line),
      now: () => new Date(),
    };

    console.log(
      `\nReins demo — ${values.scripted ? "SCRIPTED wiring check, no API calls" : `${model}, effort ${effort}`}\n` +
        `  paper account on live ${SERVER.network} prices · limits: $${SERVER.maxPositionUsd} max position, ` +
        `$${SERVER.dailyLossUsd} daily loss, ${SERVER.symbols.join("/")}\n` +
        (values.scripted
          ? ""
          : `  budget: $${spend.spentUsd.toFixed(2)} of $${spend.budgetUsd.toFixed(2)} spent\n`) +
        `  data: ${dataDir}\n`,
    );

    for (let run = 1; run <= maxCycles && !stopping; run++) {
      const cycle = await cycles.next();
      console.log(`[${new Date().toISOString().slice(0, 19)}Z] cycle ${cycle}`);
      try {
        const outcome = await runCycle(deps, cycle);
        const hold = holdRecord(outcome, cycle, new Date());
        if (hold) {
          try {
            const positions = await deps.callTool("get_positions", {});
            const context = positions.isError ? undefined : contextFromPositions(positions.text);
            await appendToLog(logFile, context ? { ...hold, context } : hold);
            console.log("  no trade this cycle; the decision to hold is in the log");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`  could not record the hold: ${message}`);
          }
        }
        const costLine = values.scripted
          ? ""
          : ` · $${outcome.costUsd.toFixed(3)} this cycle, $${spend.remainingUsd.toFixed(2)} left`;
        console.log(
          `  done: ${outcome.toolCalls} tool calls, ${outcome.refusedByLimits} refused by limits, ` +
            `ended on ${outcome.stoppedBecause}${costLine}\n`,
        );
        if (outcome.stoppedBecause === "budget") {
          console.log("Budget reached. Stopping.");
          budgetSpent = true;
          break;
        }
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          fail("Claude rejected the API key. Check ANTHROPIC_API_KEY.");
        }
        // Anything else — a rate limit, a network blip, an exchange outage —
        // costs one cycle, not the whole run. The SDK has already retried.
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  cycle ${cycle} failed: ${message}\n`);
      }

      if (run < maxCycles && !stopping) {
        try {
          await sleep(intervalMinutes * 60_000, undefined, { signal: wake.signal });
        } catch {
          // Woken early by Ctrl+C.
        }
      }
    }
  } finally {
    await mcp.close();
  }

  console.log(`Decision log: ${logFile}\nSummarise it with: npm run demo:report${
    values.scripted ? " -- --data-dir demo-data/scripted" : ""}`);
  if (budgetSpent && values["idle-when-spent"] && !stopping) await idleUntilStopped();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
