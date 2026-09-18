#!/usr/bin/env node
/**
 * The `reins` command.
 *
 *   reins            start the MCP server on stdio (what MCP clients run)
 *   reins serve      the same, spelled out
 *   reins init       add a paper-trading Reins server to .mcp.json
 *
 * With no arguments this must behave exactly like serve.ts and print nothing
 * to stdout, because stdout then carries the MCP protocol.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { INIT_USAGE, runInit } from "../init.js";

const USAGE = `Usage: reins [command]

Commands:
  serve    Start the MCP server on stdio (the default)
  init     Add a paper-trading Reins server to .mcp.json

Run "reins init --help" for init's options.
`;

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

  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  process.stderr.write(`reins: unknown command "${command}".\n\n${USAGE}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`reins: ${message}\n`);
  // An unknown or malformed flag is worth the option list; a refusal is not.
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (code.startsWith("ERR_PARSE_ARGS")) process.stderr.write(`\n${INIT_USAGE}`);
  process.exit(1);
});
