import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BUILDER_FEE_TENTHS_BPS } from "./builder-fee.js";
import { TOOL_NAMES } from "./mcp-server.js";
import type { Network } from "./types.js";

/**
 * `reins init` — writes an MCP server entry for Reins into a client config
 * (`.mcp.json` by default), so an agent can be pointed at it in one step.
 *
 * It only ever writes a paper-mode entry. Going live stays a deliberate edit
 * by hand, and no key is ever asked for, read or written here.
 */

export { DEFAULT_BUILDER_FEE_TENTHS_BPS, REINS_BUILDER_ADDRESS } from "./builder-fee.js";

export const INIT_USAGE = `Usage: reins init [options]

Adds a paper-trading Reins server to an MCP client config. Paper mode uses
live prices and simulated fills; nothing is signed and no key is written.

Options:
  --symbols <list>         Allowlist, comma separated          (default BTC,ETH)
  --max-position <usd>     Max position per symbol, USD        (default 5000)
  --daily-loss <usd>       Daily realised loss before halting  (default 500)
  --max-trade-risk <usd>   Most one trade may lose if stopped     (default 100)
  --max-leverage <x>       Max leverage                        (default 3)
  --max-orders <n>         Max orders per minute               (default 12)
  --balance <usd>          Opening paper balance               (default 10000)
  --network <name>         Prices from testnet or mainnet      (default testnet)
  --log <path>             Decision log file         (default ./decisions.jsonl)
  --paper-file <path>      Paper account file        (default ./paper-run.json)
  --file <path>            Config file to write           (default ./.mcp.json)
  --print                  Print the entry instead of writing a file
  --force                  Replace an existing "reins" entry
  -h, --help               Show this help
`;

export interface InitOptions {
  symbols: string[];
  maxPositionUsd: number;
  dailyLossUsd: number;
  maxTradeRiskUsd: number;
  maxLeverage: number;
  maxOrdersPerMinute: number;
  balanceUsd: number;
  network: Network;
  logFile: string;
  paperFile: string;
  configFile: string;
  print: boolean;
  force: boolean;
  help: boolean;
}

function positive(flag: string, raw: string): number {
  const value = Number(raw.replace(/[_,]/g, ""));
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive number, got "${raw}".`);
  }
  return value;
}

export function parseInitArgs(argv: string[]): InitOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      symbols: { type: "string", default: "BTC,ETH" },
      "max-position": { type: "string", default: "5000" },
      "daily-loss": { type: "string", default: "500" },
      "max-trade-risk": { type: "string", default: "100" },
      "max-leverage": { type: "string", default: "3" },
      "max-orders": { type: "string", default: "12" },
      balance: { type: "string", default: "10000" },
      network: { type: "string", default: "testnet" },
      log: { type: "string", default: "./decisions.jsonl" },
      "paper-file": { type: "string", default: "./paper-run.json" },
      file: { type: "string", default: "./.mcp.json" },
      print: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const symbols = [
    ...new Set(
      values.symbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (symbols.length === 0) {
    throw new Error("--symbols is empty — an empty allowlist would refuse every order.");
  }

  const network = values.network;
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`--network must be "testnet" or "mainnet", got "${network}".`);
  }

  const maxOrdersPerMinute = positive("max-orders", values["max-orders"]);
  if (!Number.isInteger(maxOrdersPerMinute)) {
    throw new Error(`--max-orders must be a whole number, got "${values["max-orders"]}".`);
  }

  return {
    symbols,
    maxPositionUsd: positive("max-position", values["max-position"]),
    dailyLossUsd: positive("daily-loss", values["daily-loss"]),
    maxTradeRiskUsd: positive("max-trade-risk", values["max-trade-risk"]),
    maxLeverage: positive("max-leverage", values["max-leverage"]),
    maxOrdersPerMinute,
    balanceUsd: positive("balance", values.balance),
    network,
    logFile: values.log,
    paperFile: values["paper-file"],
    configFile: values.file,
    print: values.print,
    force: values.force,
    help: values.help,
  };
}

/** The npm package. npm refused plain "reins" as too close to "redis". */
export const PACKAGE_NAME = "@r2rlabs/reins";

export interface Launch {
  command: string;
  args: string[];
}

/**
 * How the MCP client should start Reins. Run from npx's cache, the script
 * path is temporary, so the entry goes back through npx; anywhere else it
 * points node at the script directly. Windows cannot spawn `npx` without a
 * shell, hence `cmd /c`.
 */
export function launchCommand(scriptPath: string, platform: NodeJS.Platform): Launch {
  const fromNpxCache = scriptPath.split(/[\\/]/).includes("_npx");
  if (fromNpxCache) {
    const npx = ["-y", PACKAGE_NAME, "serve"];
    return platform === "win32"
      ? { command: "cmd", args: ["/c", "npx", ...npx] }
      : { command: "npx", args: npx };
  }
  return { command: "node", args: [scriptPath, "serve"] };
}

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The entry itself. File paths are made absolute: MCP clients start servers
 * from a working directory of their own choosing, and a relative log path
 * would scatter decision logs wherever that happened to be.
 *
 * No builder fee is written: it is part of Reins, not a setting.
 */
export function serverEntry(opts: InitOptions, launch: Launch, cwd: string): ServerEntry {
  return {
    command: launch.command,
    args: launch.args,
    env: {
      REINS_MODE: "paper",
      REINS_NETWORK: opts.network,
      REINS_SYMBOLS: opts.symbols.join(","),
      REINS_MAX_POSITION_USD: String(opts.maxPositionUsd),
      REINS_DAILY_LOSS_USD: String(opts.dailyLossUsd),
      REINS_MAX_TRADE_RISK_USD: String(opts.maxTradeRiskUsd),
      REINS_MAX_LEVERAGE: String(opts.maxLeverage),
      REINS_MAX_ORDERS_PER_MIN: String(opts.maxOrdersPerMinute),
      REINS_PAPER_BALANCE: String(opts.balanceUsd),
      REINS_PAPER_FILE: resolve(cwd, opts.paperFile),
      REINS_LOG_FILE: resolve(cwd, opts.logFile),
    },
  };
}

/**
 * Adds the entry to an existing config's `mcpServers`, leaving every other
 * server and key untouched. An existing `reins` entry is only replaced with
 * `force` — it may hold limits someone chose on purpose.
 */
export function mergeConfig(
  existing: string | undefined,
  entry: ServerEntry,
  force: boolean,
  file: string,
): string {
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      throw new Error(
        `${file} is not valid JSON, so it was left alone: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`${file} does not hold a JSON object, so it was left alone.`);
    }
    config = parsed;
  }

  const servers = config["mcpServers"] ?? {};
  if (!isRecord(servers)) {
    throw new Error(`"mcpServers" in ${file} is not an object, so it was left alone.`);
  }
  if ("reins" in servers && !force) {
    throw new Error(
      `${file} already has a "reins" server. Pass --force to replace it.`,
    );
  }

  const merged = { ...config, mcpServers: { ...servers, reins: entry } };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

export interface InitDeps {
  cwd: string;
  scriptPath: string;
  platform: NodeJS.Platform;
  /** Resolves to undefined when the file does not exist. */
  readFile: (path: string) => Promise<string | undefined>;
  writeFile: (path: string, content: string) => Promise<void>;
  out: (text: string) => void;
}

export async function runInit(argv: string[], deps: InitDeps): Promise<void> {
  const opts = parseInitArgs(argv);
  if (opts.help) {
    deps.out(INIT_USAGE);
    return;
  }

  const entry = serverEntry(opts, launchCommand(deps.scriptPath, deps.platform), deps.cwd);

  if (opts.print) {
    deps.out(`${JSON.stringify({ mcpServers: { reins: entry } }, null, 2)}\n`);
    return;
  }

  const configPath = resolve(deps.cwd, opts.configFile);
  const existing = await deps.readFile(configPath);
  await deps.writeFile(configPath, mergeConfig(existing, entry, opts.force, display(configPath, deps.cwd)));

  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  deps.out(
    `✓ Paper mode — live ${opts.network} prices, simulated fills, no capital at risk\n` +
      `✓ Limits — max position ${usd(opts.maxPositionUsd)} · daily loss ${usd(opts.dailyLossUsd)} · ` +
      `${usd(opts.maxTradeRiskUsd)} risk per trade · ` +
      `${opts.symbols.join(", ")}\n` +
      `✓ Paper account — ${usd(opts.balanceUsd)} · ${display(entry.env["REINS_PAPER_FILE"]!, deps.cwd)}\n` +
      `✓ Decision log — ${display(entry.env["REINS_LOG_FILE"]!, deps.cwd)}\n` +
      builderLine() +
      `✓ ${existing === undefined ? "Created" : "Updated"} ${display(configPath, deps.cwd)}\n` +
      `→ ${TOOL_NAMES.length} tools on stdio. Point your agent at it.\n`,
  );
}

/**
 * Said out loud up front: a fee nobody was told about is the fastest way to
 * lose the people paying it.
 */
function builderLine(): string {
  return (
    `✓ Builder fee — ${DEFAULT_BUILDER_FEE_TENTHS_BPS / 10} bp to Reins on live orders; paper results include it\n` +
    `  Live trading needs a one-time approval: npx ${PACKAGE_NAME} approve-builder\n`
  );
}

/** A path as the user would type it: relative when it sits under cwd. */
function display(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return `.${sep}${rel}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
