#!/usr/bin/env node
/**
 * stdio entry point for the MCP server.
 *
 * Nothing may ever be written to stdout here — that channel carries the MCP
 * protocol itself, and a stray console.log corrupts the stream and breaks the
 * connection in ways that are miserable to diagnose. All logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { REINS_BUILDER, feeApprovalProblem } from "../builder-fee.js";
import { HyperliquidClient } from "../client.js";
import { MemoryDecisionLog, type DecisionLog } from "../decision-log.js";
import { FileDecisionLog } from "../decision-log-file.js";
import { createMcpServer } from "../mcp-server.js";
import { PaperClient } from "../paper.js";
import { PrivateKeySigner } from "../private-key-signer.js";
import { FilePaperStore } from "../paper-store.js";
import { RiskEngine, type RiskLimits } from "../risk.js";
import type { TradingClient } from "../trading-client.js";
import type { Network } from "../types.js";

function num(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required but not set.`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}".`);
  }
  return parsed;
}

function readLimits(): RiskLimits {
  const symbols = (process.env["REINS_SYMBOLS"] ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) {
    throw new Error(
      "REINS_SYMBOLS is required — an empty allowlist would refuse every order.",
    );
  }
  return {
    maxPositionUsd: num("REINS_MAX_POSITION_USD"),
    maxLeverage: num("REINS_MAX_LEVERAGE", 3),
    dailyLossLimitUsd: num("REINS_DAILY_LOSS_USD"),
    symbolAllowlist: symbols,
    maxOrdersPerMinute: num("REINS_MAX_ORDERS_PER_MIN", 12),
    requireStopLoss: flag("REINS_REQUIRE_STOP_LOSS"),
    // Optional: without it, only the position cap limits a trade.
    ...(process.env["REINS_MAX_TRADE_RISK_USD"]
      ? { maxTradeRiskUsd: num("REINS_MAX_TRADE_RISK_USD") }
      : {}),
  };
}

function flag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error(`${name} must be true or false, got "${process.env[name]}".`);
}

async function main(): Promise<void> {
  const network = (process.env["REINS_NETWORK"] ?? "testnet") as Network;
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`REINS_NETWORK must be "testnet" or "mainnet", got "${network}".`);
  }

  // Paper is the default. Trading real money should take a deliberate act,
  // not the absence of one.
  const mode = process.env["REINS_MODE"] ?? "paper";
  if (mode !== "paper" && mode !== "live") {
    throw new Error(`REINS_MODE must be "paper" or "live", got "${mode}".`);
  }

  const limits = readLimits();
  // Reins' builder fee is part of the product, not a setting. Real orders carry
  // it on mainnet; testnet moves no real money, so its orders carry none.
  const builder = network === "mainnet" ? REINS_BUILDER : undefined;

  // Only live mode ever holds a key. Paper never signs anything, so it is not
  // given the means to.
  const privateKey = process.env["REINS_PRIVATE_KEY"];
  const signer =
    mode === "live" && privateKey ? new PrivateKeySigner(privateKey) : undefined;

  // The account being traded. With an API wallet's key in REINS_PRIVATE_KEY,
  // this is the account that approved it; account data is read from here.
  const account = mode === "live" ? process.env["REINS_ACCOUNT_ADDRESS"] || undefined : undefined;

  const market = new HyperliquidClient({
    network,
    ...(builder ? { builder } : {}),
    ...(signer ? { signer } : {}),
    ...(account ? { account } : {}),
  });

  let client: TradingClient;
  let banner: string;

  if (mode === "paper") {
    const balance = num("REINS_PAPER_BALANCE", 10_000);
    const file = process.env["REINS_PAPER_FILE"];
    client = new PaperClient({
      market,
      startingBalanceUsd: balance,
      // Paper pays nothing, but shows the fee, so a run says what live would cost.
      builderFeeTenthsBps: REINS_BUILDER.feeTenthsBps,
      ...(file ? { store: new FilePaperStore(file) } : {}),
    });
    banner =
      `paper — live ${network} prices, simulated fills, no capital at risk\n` +
      `  opening balance $${balance.toLocaleString()}\n` +
      `  state           ${file ?? "in memory (lost on restart)"}\n`;
  } else if (signer) {
    // Hyperliquid refuses orders carrying a fee the account has not approved;
    // refuse here first, with the way to approve it.
    if (builder) {
      const problem = await feeApprovalProblem(market, account ?? signer.address);
      if (problem) throw new Error(problem);
    }
    client = market;
    const warning =
      network === "mainnet"
        ? "  *** REAL FUNDS ON MAINNET — orders placed here spend actual money ***\n"
        : "";
    const apiWallet = account !== undefined && account.toLowerCase() !== signer.address;
    banner = apiWallet
      ? `live — API wallet ${signer.address} trading for account ${account!.toLowerCase()}\n` + warning
      : `live — signing as ${signer.address} with the account's own key\n` +
        warning +
        "  An API wallet is safer: it can trade but not withdraw. Create one on\n" +
        "  Hyperliquid, put its key in REINS_PRIVATE_KEY, and set REINS_ACCOUNT_ADDRESS.\n";
  } else {
    client = market;
    banner = account
      ? `live — READ-ONLY for account ${account.toLowerCase()}: set REINS_PRIVATE_KEY to trade\n`
      : `live — READ-ONLY: set REINS_PRIVATE_KEY to trade. Reads work; orders throw\n`;
  }

  const logFile = process.env["REINS_LOG_FILE"];
  const log: DecisionLog = logFile
    ? new FileDecisionLog(logFile)
    : new MemoryDecisionLog();

  const engine = new RiskEngine(limits);
  const server = createMcpServer({ client, engine, log });

  process.stderr.write(
    `reins on ${network}\n` +
      `  mode            ${banner}` +
      `  max position    $${limits.maxPositionUsd.toLocaleString()}\n` +
      `  daily loss      $${limits.dailyLossLimitUsd.toLocaleString()}\n` +
      `  max leverage    ${limits.maxLeverage}x\n` +
      `  stop-losses     ${limits.requireStopLoss ? "required on every position" : "optional"}\n` +
      `  risk per trade  ${
        limits.maxTradeRiskUsd === undefined
          ? "not limited (set REINS_MAX_TRADE_RISK_USD)"
          : `$${limits.maxTradeRiskUsd.toLocaleString()} if the stop fills`
      }\n` +
      `  symbols         ${limits.symbolAllowlist.join(", ")}\n` +
      `  builder fee     ${
        mode === "paper"
          ? `${REINS_BUILDER.feeTenthsBps / 10} bp, shown in paper results; charged on live mainnet orders`
          : builder
            ? `${REINS_BUILDER.feeTenthsBps / 10} bp on every order`
            : "none on testnet"
      }\n` +
      `  decision log    ${logFile ?? "in memory (lost on restart)"}\n`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`reins failed to start: ${message}\n`);
  // Not process.exit(): exiting while a request's socket is still closing
  // aborts Node on Windows. Nothing else is running, so the process ends.
  process.exitCode = 1;
});
