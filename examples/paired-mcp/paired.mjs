/**
 * Two MCP servers, one job: someone else's data server does the reading,
 * Reins does the trading and refuses what breaks a limit.
 *
 * This one pairs Reins with alekskram/hyperliquid-agent-gateway, a read-only
 * Hyperliquid server on PyPI. Any data server works — the point is the split:
 * their tools answer "what is happening", ours decide "what may be sent", and
 * neither has to trust the other.
 *
 * No model and no API key: this drives both servers directly, so it costs
 * nothing to run and shows exactly what an agent would see. Reins runs in
 * paper mode, so nothing is signed.
 *
 *   npm run build
 *   pip install hyperliquid-agent-gateway
 *   node examples/paired-mcp/paired.mjs
 *
 * GATEWAY_PYTHON can point at the interpreter that has it installed; by
 * default this uses whatever `python` is on PATH.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const RISK_USD = 20;
const COIN = "BTC";

/** Tool results come back as text; every server here answers with JSON. */
function json(result) {
  const text = result.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function connect(name, command, args, env) {
  const client = new Client({ name: "paired-example", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command, args, ...(env ? { env } : {}) }));
  const { tools } = await client.listTools();
  console.log(`${name.padEnd(8)} ${tools.length} tools`);
  return client;
}

const reads = await connect(
  "gateway",
  process.env["GATEWAY_PYTHON"] ?? "python",
  ["-c", "from hyperliquid_mcp.server import main; main()"],
);

const trades = await connect("reins", process.execPath, ["dist/bin/serve.js"], {
  ...process.env,
  REINS_MODE: "paper",
  REINS_NETWORK: "mainnet",
  REINS_SYMBOLS: COIN,
  REINS_MAX_POSITION_USD: "5000",
  REINS_DAILY_LOSS_USD: "500",
  REINS_MAX_TRADE_RISK_USD: "50",
  REINS_REQUIRE_STOP_LOSS: "true",
});

// --- their half: what is happening ----------------------------------------

const quote = json(await reads.callTool({ name: "quote", arguments: { coin: COIN } }));
console.log(`\nquote    ${COIN} ${quote.bid} / ${quote.ask}, spread ${quote.spread_bps} bp`);

const overview = json(await reads.callTool({ name: "market_overview", arguments: { limit: 100 } }));
const market = (overview.perps ?? []).find((r) => r.coin === COIN);
if (market) {
  const fundingBps = (market.funding * 10_000).toFixed(2);
  console.log(
    `market   mark ${market.mark_px}, funding ${fundingBps} bp/h, ` +
      `OI $${(market.open_interest_usd / 1e9).toFixed(2)}bn, max ${market.max_leverage}x`,
  );
}

// --- our half: what may be sent -------------------------------------------

// Size so that being stopped out costs about RISK_USD. This is the same
// arithmetic Reins checks, so the order is built to pass rather than to be
// refused: size = risk / (distance to the stop, as a fraction of entry).
const entry = Number((quote.bid * 0.995).toFixed(1));
const stop = Number((entry * 0.99).toFixed(1));
const sizeUsd = Math.round(RISK_USD / (Math.abs(entry - stop) / entry));
console.log(`\nplan     buy $${sizeUsd} at ${entry}, stop ${stop} — risks about $${RISK_USD}`);

const placed = json(
  await trades.callTool({
    name: "place_order",
    arguments: {
      symbol: COIN,
      side: "buy",
      sizeUsd,
      price: entry,
      stopLoss: stop,
      tif: "Alo",
      reason: `paired example: bid ${quote.bid} from the gateway, stop 1% under entry`,
    },
  }),
);
console.log(`order    ${placed.kind} #${placed.oid}, stop attached at ${placed.stopLoss?.triggerPrice}`);

// The same trade with the stop far away breaks the per-trade cap. The agent
// is told why, in a sentence it can act on, and nothing reaches the exchange.
const tooMuch = await trades.callTool({
  name: "place_order",
  arguments: {
    symbol: COIN,
    side: "buy",
    sizeUsd: 5000,
    price: entry,
    stopLoss: Number((entry * 0.9).toFixed(1)),
    reason: "paired example: deliberately more risk than the limit allows",
  },
});
console.log(`refused  ${tooMuch.content?.[0]?.text?.split("\n")[0]}`);

await trades.callTool({
  name: "cancel_order",
  arguments: { symbol: COIN, orderId: placed.oid, reason: "end of the example" },
});

// --- the record -----------------------------------------------------------

const log = json(await trades.callTool({ name: "get_recent_decisions", arguments: { limit: 10 } }));
const decisions = log.decisions ?? [];
const refused = decisions.filter((d) => d.risk?.allowed === false);
console.log(`\nlog      ${decisions.length} records, ${refused.length} refused`);
for (const d of decisions.slice(0, 4)) {
  const verdict = d.risk?.allowed === false ? `REFUSED ${d.risk.code}` : "allowed";
  console.log(`  ${d.time.slice(11, 19)}  ${d.tool.padEnd(13)} ${verdict.padEnd(28)} ${d.reason}`);
}

await reads.close();
await trades.close();
console.log("\nTheir server never saw a key. Ours never guessed a price.");
