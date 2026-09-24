/**
 * `npm run demo:settle` — let the paper account catch up with the market,
 * without the agent.
 *
 * The simulator only checks resting orders and stops when something asks it
 * for the account, which during a run is the agent's own tool calls. Once a
 * run stops — its budget spent — a position with a stop on the exchange sits
 * frozen: in a real account that stop would have fired, here nothing polled.
 *
 * This polls once. Anything the market reached while the demo was idle fills
 * at the price and time it would have, from the one-minute candles, and each
 * fill is written to the same decision log as an `exchange_fill` record.
 * It costs nothing: no Claude calls, no orders of its own, no decisions.
 */
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HyperliquidClient } from "../../dist/client.js";
import { REINS_BUILDER } from "../../dist/builder-fee.js";
import { FileDecisionLog } from "../../dist/decision-log-file.js";
import { recordExchangeFills } from "../../dist/mcp-server.js";
import { PaperClient } from "../../dist/paper.js";
import { FilePaperStore } from "../../dist/paper-store.js";
import { RiskEngine } from "../../dist/risk.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    network: { type: "string", default: "mainnet" },
    // Whatever the run itself charged, so its last fill is priced like the
    // rest: runs before Reins' fee became fixed simulated 1 bp (--fee 10).
    fee: { type: "string" },
  },
});
const dataDir = resolve(process.cwd(), values["data-dir"] ?? "demo-data");
const network = values.network === "testnet" ? "testnet" : "mainnet";

const client = new PaperClient({
  market: new HyperliquidClient({ network }),
  startingBalanceUsd: 10_000,
  builderFeeTenthsBps: values.fee === undefined ? REINS_BUILDER.feeTenthsBps : Number(values.fee),
  store: new FilePaperStore(join(dataDir, "paper-account.json")),
});

const before = await client.snapshot();
const state = await client.accountState(); // the poll: matches orders and stops
const after = await client.snapshot();

const filled = after.fills.slice(before.fills.length);
for (const fill of filled) {
  const when = new Date(fill.time).toISOString().slice(0, 16).replace("T", " ");
  console.log(
    `${when}  ${fill.side} ${fill.size} ${fill.symbol} at ${fill.price}` +
      `${fill.stop ? " (stop-loss)" : ""}, PnL ${fill.realizedPnlUsd.toFixed(2)}, fee ${fill.feeUsd.toFixed(2)}`,
  );
}

// The same catch-up the server does before every tool call, so a stop that
// fired while nobody was watching still reaches the log.
const engine = new RiskEngine({
  maxPositionUsd: Number.MAX_SAFE_INTEGER,
  maxLeverage: Number.MAX_SAFE_INTEGER,
  dailyLossLimitUsd: Number.MAX_SAFE_INTEGER,
  symbolAllowlist: [],
  maxOrdersPerMinute: 1,
});
const written = await recordExchangeFills({
  client,
  engine,
  log: new FileDecisionLog(join(dataDir, "decisions.jsonl")),
});

const open = Object.entries(after.positions);
console.log(
  `${filled.length} fill${filled.length === 1 ? "" : "s"} caught up, ${written} written to the log.\n` +
    `Balance $${after.balanceUsd.toFixed(2)} · ` +
    (open.length === 0
      ? "no open positions"
      : open.map(([s, p]) => `${s} ${p.size > 0 ? "long" : "short"} ${Math.abs(p.size)} @ ${p.entryPrice}`).join(", ")) +
    `${after.resting.length > 0 ? ` · ${after.resting.length} resting order(s)` : ""}` +
    `${(after.stops ?? []).length > 0 ? ` · ${(after.stops ?? []).length} stop(s)` : ""}\n` +
    `Account value $${state.accountValueUsd.toFixed(2)} at current prices.`,
);
