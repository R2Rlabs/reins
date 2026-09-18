#!/usr/bin/env node
/**
 * The `reins` command.
 *
 *   reins                  start the MCP server on stdio (what MCP clients run)
 *   reins serve            the same, spelled out
 *   reins init             add a paper-trading Reins server to .mcp.json
 *   reins approve-builder  approve Reins' builder fee from your own wallet
 *
 * With no arguments this must behave exactly like serve.ts and print nothing
 * to stdout, because stdout then carries the MCP protocol.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { APPROVE_USAGE, ApprovalFailedError, runApproveBuilder } from "../approve-builder.js";
import { HyperliquidClient } from "../client.js";
import { INIT_USAGE, runInit } from "../init.js";

const USAGE = `Usage: reins [command]

Commands:
  serve            Start the MCP server on stdio (the default)
  init             Add a paper-trading Reins server to .mcp.json
  approve-builder  Approve Reins' builder fee, signed in your own wallet

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
    process.stderr.write(`\n${process.argv[2] === "approve-builder" ? APPROVE_USAGE : INIT_USAGE}`);
  }
  // Not process.exit(): approve-builder may still be closing its server, and
  // exiting mid-close aborts Node on Windows. Nothing else is left running.
  process.exitCode = 1;
});
