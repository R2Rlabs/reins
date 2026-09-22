#!/usr/bin/env node
/**
 * The `reins` command.
 *
 *   reins                  start the MCP server on stdio (what MCP clients run)
 *   reins serve            the same, spelled out
 *   reins init             add a paper-trading Reins server to .mcp.json
 *   reins approve-builder  approve Reins' builder fee from your own wallet
 *   reins live-check       check Reins against the real exchange
 *   reins stats            trading through Reins' builder code, from Hyperliquid's data
 *
 * With no arguments this must behave exactly like serve.ts and print nothing
 * to stdout, because stdout then carries the MCP protocol.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { APPROVE_USAGE, ApprovalFailedError, runApproveBuilder } from "../approve-builder.js";
import { HyperliquidClient } from "../client.js";
import { DEFAULT_BUILDER_FEE_TENTHS_BPS, INIT_USAGE, REINS_BUILDER_ADDRESS, runInit } from "../init.js";
import { runLiveCheck } from "../live-check.js";
import { STATS_USAGE, runStats } from "../platform-stats.js";
import { PrivateKeySigner } from "../private-key-signer.js";

/** Stands in when this build has no builder address, so orders still carry the shape. */
const ZERO_BUILDER = "0x0000000000000000000000000000000000000000";

const USAGE = `Usage: reins [command]

Commands:
  serve            Start the MCP server on stdio (the default)
  init             Add a paper-trading Reins server to .mcp.json
  approve-builder  Approve Reins' builder fee, signed in your own wallet
  live-check       Check Reins against real Hyperliquid, on a live account
  stats            Accounts, trades, volume and fees through Reins' builder code

Run "reins <command> --help" for a command's options.
`;

/** Best effort: the URL is printed as well, for when no browser opens. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args as string[], { stdio: "ignore", detached: true })
      .on("error", () => undefined)
      .unref();
  } catch {
    // Nothing to do: the address is already on screen.
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === "serve") {
    await import("./serve.js");
    return;
  }

  if (command === "init") {
    await runInit(rest, {
      cwd: process.cwd(),
      scriptPath: fileURLToPath(import.meta.url),
      platform: process.platform,
      readFile: async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      writeFile: (path, content) => writeFile(path, content, "utf8"),
      out: (text) => process.stdout.write(text),
    });
    return;
  }

  if (command === "approve-builder") {
    // No signer: the approval is signed in the user's wallet, never here.
    await runApproveBuilder(rest, {
      clientFor: (network) => new HyperliquidClient({ network }),
      out: (text) => process.stdout.write(text),
      openBrowser,
      now: Date.now,
    });
    return;
  }

  if (command === "live-check") {
    const network = (process.env["REINS_NETWORK"] ?? "mainnet") as "mainnet" | "testnet";
    const account = process.env["REINS_ACCOUNT_ADDRESS"];
    const key = process.env["REINS_PRIVATE_KEY"];
    const results = await runLiveCheck(rest, {
      client: new HyperliquidClient({
        network,
        ...(account ? { account } : {}),
        ...(key ? { signer: new PrivateKeySigner(key) } : {}),
        builder: { address: REINS_BUILDER_ADDRESS || ZERO_BUILDER, feeTenthsBps: DEFAULT_BUILDER_FEE_TENTHS_BPS },
      }),
      out: (text) => process.stdout.write(text),
    });
    if (results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }

  if (command === "stats") {
    await runStats(rest, {
      feesCredited: (builder) => new HyperliquidClient({ network: "mainnet" }).builderRewardsUsd(builder),
      fetchBytes: async (url) => {
        const response = await fetch(url);
        return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
      },
      now: Date.now,
      out: (text) => process.stdout.write(text),
    });
    return;
  }

  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  process.stderr.write(`reins: unknown command "${command}".\n\n${USAGE}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  // The approval result has already been printed in full.
  if (!(error instanceof ApprovalFailedError)) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`reins: ${message}\n`);
  }
  // An unknown or malformed flag is worth the option list; a refusal is not.
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (code.startsWith("ERR_PARSE_ARGS")) {
    const usages: Record<string, string> = { "approve-builder": APPROVE_USAGE, stats: STATS_USAGE };
    process.stderr.write(`\n${usages[process.argv[2] ?? ""] ?? INIT_USAGE}`);
  }
  // Not process.exit(): approve-builder may still be closing its server, and
  // exiting mid-close aborts Node on Windows. Nothing else is left running.
  process.exitCode = 1;
});
