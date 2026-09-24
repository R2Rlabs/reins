#!/usr/bin/env node
/**
 * stdio entry point for the MCP server.
 *
 * Nothing may ever be written to stdout here — that channel carries the MCP
 * protocol itself, and a stray console.log corrupts the stream and breaks the
 * connection in ways that are miserable to diagnose. All logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../mcp-server.js";
import { buildRuntime } from "../runtime.js";

async function main(): Promise<void> {
  const { client, engine, log, banner } = await buildRuntime();
  const server = createMcpServer({ client, engine, log });
  process.stderr.write(banner);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`reins failed to start: ${message}\n`);
  // Not process.exit(): exiting while a request's socket is still closing
  // aborts Node on Windows. Nothing else is running, so the process ends.
  process.exitCode = 1;
});
