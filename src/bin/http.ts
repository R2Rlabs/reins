#!/usr/bin/env node
/**
 * `reins http` — the same limits and log, over HTTP, for bots that do not
 * speak MCP.
 *
 * Bound to 127.0.0.1 unless told otherwise, and every route but /health needs
 * a bearer token: this thing places orders, so it is not something to leave
 * open. A token is generated and printed if none is supplied.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { createHttpApi, type ApiRequest } from "../http-api.js";
import type { McpServerDeps } from "../mcp-server.js";

export const HTTP_USAGE = `Usage: reins http [options]

Serves Reins' tools as HTTP for bots in any language. Reads its limits from
the same REINS_* variables as "reins serve", and writes the same decision log.

Options:
  --port <n>        Port to listen on                      (default 8787)
  --host <addr>     Address to bind          (default 127.0.0.1, this machine)
  --token <secret>  Bearer token callers must send    (default: one is made)
  -h, --help        Show this help

The token may also come from REINS_HTTP_TOKEN. Binding anything other than
127.0.0.1 exposes order placement to your network: use a token you chose, and
put it behind TLS.
`;

export interface HttpOptions {
  port: number;
  host: string;
  token: string;
  help: boolean;
}

export function parseHttpArgs(argv: string[], env: Record<string, string | undefined> = {}): HttpOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      port: { type: "string", default: "8787" },
      host: { type: "string", default: "127.0.0.1" },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be a port number, got "${values.port}".`);
  }
  const token = values.token ?? env["REINS_HTTP_TOKEN"] ?? randomBytes(24).toString("base64url");
  if (token.length < 16) throw new Error("--token must be at least 16 characters.");
  return { port, host: values.host, token, help: values.help };
}

/** Reads a JSON body, refusing anything large enough to be an attack. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("The body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startHttpServer(deps: McpServerDeps, options: HttpOptions, banner: { mode?: "paper" | "live"; network?: string } = {}) {
  const api = createHttpApi(deps, {
    token: options.token,
    ...(banner.mode ? { mode: banner.mode } : {}),
    ...(banner.network ? { network: banner.network } : {}),
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const auth = request.headers.authorization ?? "";
      const call: ApiRequest = {
        method: request.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        token: auth.startsWith("Bearer ") ? auth.slice(7) : undefined,
      };
      let answer;
      try {
        call.body = await readBody(request);
        answer = await api(call);
      } catch (error) {
        answer = { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
      }
      const payload = JSON.stringify(answer.body, null, 2);
      response.writeHead(answer.status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    })();
  });

  return server;
}
