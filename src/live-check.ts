import { parseArgs } from "node:util";
import { isAddress } from "viem";
import { REINS_BUILDER_ADDRESS, DEFAULT_BUILDER_FEE_TENTHS_BPS } from "./init.js";
import type { OrderOutcome, StopLoss } from "./types.js";

/**
 * `reins live-check` — the one thing tests cannot do: prove the exchange
 * accepts what Reins sends.
 *
 * Every order path here is signed the way the unit tests check and the way
 * Hyperliquid's own SDK signs, but a signature that matches a vector is not
 * the same as an exchange that takes the order. This walks the whole path on
 * a real account with the smallest position the venue allows: a resting order
 * with a stop attached, a market entry, a stop moved, an order cancelled, a
 * position closed. It stops at the first step whose answer is not what Reins
 * expects, and says what it got instead.
 *
 * Reads cost nothing and change nothing. The trading steps only run with
 * --trade, spend a few cents in fees, and always try to close what they open.
 */

export const LIVE_CHECK_USAGE = `Usage: reins live-check [options]

Checks Reins against real Hyperliquid. Reads are free; the trading steps open
and close one tiny position and cost a few cents in fees.

Needs REINS_ACCOUNT_ADDRESS and, for --trade, REINS_PRIVATE_KEY (an API
wallet's key).

Options:
  --trade              Also place, protect, cancel and close a real order
  --size-usd <n>       Notional for the test order, 10 to 100  (default 12)
  --symbol <sym>       Market to test on                       (default BTC)
  --network <name>     mainnet or testnet                 (default mainnet)
  -h, --help           Show this help
`;

export interface LiveCheckOptions {
  trade: boolean;
  sizeUsd: number;
  symbol: string;
  network: "mainnet" | "testnet";
  help: boolean;
}

export function parseLiveCheckArgs(argv: string[]): LiveCheckOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      trade: { type: "boolean", default: false },
      "size-usd": { type: "string", default: "12" },
      symbol: { type: "string", default: "BTC" },
      network: { type: "string", default: "mainnet" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const sizeUsd = Number(values["size-usd"]);
  // Hyperliquid refuses orders under $10; the ceiling is here so a typo cannot
  // turn a wiring check into a real position.
  if (!Number.isFinite(sizeUsd) || sizeUsd < 10 || sizeUsd > 100) {
    throw new Error(`--size-usd must be between 10 and 100, got "${values["size-usd"]}".`);
  }
  const network = values.network;
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(`--network must be "mainnet" or "testnet", got "${network}".`);
  }
  return { trade: values.trade, sizeUsd, symbol: values.symbol.toUpperCase(), network, help: values.help };
}

/** What the check needs from the client; the live one satisfies it. */
export interface LiveCheckClient {
  readonly accountAddress: string | undefined;
  readonly isReadOnly: boolean;
  assetInfo(symbol: string): Promise<{ name: string; szDecimals: number; index: number }>;
  accountState(): Promise<{ accountValueUsd: number; realizedPnlTodayUsd: number; positionsUsd: Record<string, number> }>;
  openPositions(): Promise<Record<string, { size: number; entryPrice: number }>>;
  l2Book(coin: string): Promise<{ levels: [{ px: string }[], { px: string }[]] }>;
  stopLosses(): Promise<StopLoss[]>;
  maxBuilderFee(user: string, builder: string): Promise<number>;
  placeOrder(params: {
    symbol: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    reduceOnly?: boolean;
    tif?: "Gtc" | "Ioc" | "Alo";
    stopLoss?: number;
  }): Promise<OrderOutcome>;
  placeStopLoss(params: {
    symbol: string;
    side: "buy" | "sell";
    size: number;
    triggerPrice: number;
  }): Promise<OrderOutcome>;
  cancelOrder(symbol: string, oid: number): Promise<{ kind: "cancelled" } | { kind: "rejected"; message: string }>;
}

export interface LiveCheckDeps {
  client: LiveCheckClient;
  out(line: string): void;
  builderAddress?: string;
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

class CheckFailed extends Error {}

/** Fails the step with a message, rather than returning a wrong "pass". */
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

function describeOutcome(outcome: OrderOutcome): string {
  if (outcome.kind === "filled") return `filled ${outcome.totalSize} at ${outcome.avgPrice}`;
  if (outcome.kind === "resting") return `resting as order ${outcome.oid}`;
  return `rejected: ${outcome.message}`;
}

/**
 * Runs the checks in order and stops at the first failure, because a later
 * step usually depends on the one before it. Anything opened is closed in the
 * same run: a check that leaves a position behind is worse than no check.
 */
export async function runLiveCheck(argv: string[], deps: LiveCheckDeps): Promise<StepResult[]> {
  const opts = parseLiveCheckArgs(argv);
  if (opts.help) {
    deps.out(LIVE_CHECK_USAGE);
    return [];
  }
  const { client } = deps;
  const builder = deps.builderAddress ?? REINS_BUILDER_ADDRESS;
  const results: StepResult[] = [];

  const step = async (name: string, run: () => Promise<string>): Promise<boolean> => {
    try {
      const detail = await run();
      results.push({ name, ok: true, detail });
      deps.out(`✓ ${name} — ${detail}\n`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
      deps.out(`✗ ${name} — ${detail}\n`);
      return false;
    }
  };

  deps.out(
    `Checking Reins against ${opts.network} for account ${client.accountAddress ?? "(none)"}\n` +
      (opts.trade ? `Trading steps on ${opts.symbol}, about $${opts.sizeUsd} a time.\n\n` : "Reads only; --trade to test orders.\n\n"),
  );

  const account = client.accountAddress;
  if (!account || !isAddress(account, { strict: false })) {
    deps.out("✗ account — no account address. Set REINS_ACCOUNT_ADDRESS.\n");
    return [{ name: "account", ok: false, detail: "no account address" }];
  }

  let equity = 0;
  const readsOk =
    (await step("account", async () => {
      const state = await client.accountState();
      equity = state.accountValueUsd;
      expect(equity > 0, `account value is ${equity}. Deposit to it first, or check the address.`);
      const open = Object.keys(await client.openPositions());
      return `$${equity.toFixed(2)}, ${open.length === 0 ? "no open positions" : `open: ${open.join(", ")}`}`;
    })) &&
    (await step("market data", async () => {
      const asset = await client.assetInfo(opts.symbol);
      const book = await client.l2Book(opts.symbol);
      const bid = Number(book.levels[0][0]?.px);
      const ask = Number(book.levels[1][0]?.px);
      expect(bid > 0 && ask > 0, `no two-sided book for ${opts.symbol}.`);
      return `${opts.symbol} is asset ${asset.index}, ${asset.szDecimals} size decimals, ${bid} / ${ask}`;
    })) &&
    (await step("open orders", async () => {
      const stops = await client.stopLosses();
      return stops.length === 0 ? "no stop-losses on the account" : `${stops.length} stop-loss order(s)`;
    }));

  if (readsOk && builder !== "") {
    await step("builder fee", async () => {
      const approved = await client.maxBuilderFee(account, builder);
      expect(
        approved >= DEFAULT_BUILDER_FEE_TENTHS_BPS,
        `this account approved ${approved / 10} bp for ${builder}, under the ${DEFAULT_BUILDER_FEE_TENTHS_BPS / 10} bp Reins charges. ` +
          `Run "reins approve-builder" from it. Orders carrying the fee would be refused.`,
      );
      return `approved up to ${approved / 10} bp for ${builder}`;
    });
  }

  if (!readsOk || !opts.trade) {
    summarise(results, deps);
    return results;
  }

  if (client.isReadOnly) {
    deps.out("✗ trading — no key. Set REINS_PRIVATE_KEY to an API wallet's key.\n");
    results.push({ name: "trading", ok: false, detail: "no key" });
    summarise(results, deps);
    return results;
  }

  const asset = await client.assetInfo(opts.symbol);
  const book = await client.l2Book(opts.symbol);
  const bid = Number(book.levels[0][0]!.px);
  const ask = Number(book.levels[1][0]!.px);
  const sizeOf = (price: number) => opts.sizeUsd / price;

  // A bid 3% under the market will not fill while the check runs, which is
  // what makes it a safe test of resting orders.
  const restPrice = bid * 0.97;
  let restingOid: number | undefined;

  const restingOk = await step("resting order with a stop attached", async () => {
    const outcome = await client.placeOrder({
      symbol: opts.symbol,
      side: "buy",
      size: sizeOf(restPrice),
      price: restPrice,
      tif: "Alo",
      stopLoss: restPrice * 0.99,
    });
    expect(outcome.kind === "resting", `expected it to rest, got ${describeOutcome(outcome)}`);
    restingOid = outcome.kind === "resting" ? outcome.oid : undefined;
    return `${describeOutcome(outcome)}, 3% under the market, stop attached`;
  });

  if (restingOk && restingOid !== undefined) {
    await step("cancel", async () => {
      const cancelled = await client.cancelOrder(opts.symbol, restingOid!);
      expect(cancelled.kind === "cancelled", `cancel was refused: ${JSON.stringify(cancelled)}`);
      return `order ${restingOid} cancelled`;
    });
  }

  let filledSize = 0;
  const entryOk = await step("market entry", async () => {
    const outcome = await client.placeOrder({
      symbol: opts.symbol,
      side: "buy",
      size: sizeOf(ask),
      price: ask * 1.002,
      tif: "Ioc",
    });
    expect(outcome.kind === "filled", `expected a fill, got ${describeOutcome(outcome)}`);
    filledSize = outcome.kind === "filled" ? Number(outcome.totalSize) : 0;
    expect(filledSize > 0, "the exchange reported a fill of zero.");
    return describeOutcome(outcome);
  });

  if (entryOk) {
    // Equity is read differently in Manual and Unified accounts, and only an
    // open position tells the two readings apart: one that counts the margin
    // twice, or loses it, moves by the margin the moment the entry fills.
    // Fees and a few seconds of price stay well inside this allowance.
    await step("account value with a position open", async () => {
      const state = await client.accountState();
      const notional = state.positionsUsd[opts.symbol] ?? 0;
      expect(
        notional > opts.sizeUsd * 0.8 && notional < opts.sizeUsd * 1.2,
        `expected about $${opts.sizeUsd} of ${opts.symbol} long, Reins reads $${notional.toFixed(2)}.`,
      );
      const allowance = opts.sizeUsd * 0.01 + 0.05;
      const moved = state.accountValueUsd - equity;
      expect(
        Math.abs(moved) <= allowance,
        `account value went from $${equity.toFixed(2)} to $${state.accountValueUsd.toFixed(2)} on opening ` +
          `$${notional.toFixed(2)}; more than fees and price explain, so Reins is misreading this account's equity.`,
      );
      return `$${state.accountValueUsd.toFixed(2)} with $${notional.toFixed(2)} ${opts.symbol} open (moved ${moved >= 0 ? "+" : "-"}$${Math.abs(moved).toFixed(2)})`;
    });

    let stopOid: number | undefined;
    const stopOk = await step("stop-loss on the position", async () => {
      const outcome = await client.placeStopLoss({
        symbol: opts.symbol,
        side: "sell",
        size: filledSize,
        triggerPrice: bid * 0.97,
      });
      expect(outcome.kind === "resting", `expected the stop to rest, got ${describeOutcome(outcome)}`);
      stopOid = outcome.kind === "resting" ? outcome.oid : undefined;
      const stops = await client.stopLosses();
      expect(
        stops.some((s) => s.oid === stopOid),
        `the stop was accepted as order ${stopOid} but is not among the open orders Reins can read.`,
      );
      return `order ${stopOid}, trigger ${(bid * 0.97).toFixed(2)}, and Reins can read it back`;
    });

    if (stopOk && stopOid !== undefined) {
      await step("move the stop", async () => {
        const moved = await client.placeStopLoss({
          symbol: opts.symbol,
          side: "sell",
          size: filledSize,
          triggerPrice: bid * 0.98,
        });
        expect(moved.kind === "resting", `expected the new stop to rest, got ${describeOutcome(moved)}`);
        const cancelled = await client.cancelOrder(opts.symbol, stopOid!);
        expect(cancelled.kind === "cancelled", `the old stop would not cancel: ${JSON.stringify(cancelled)}`);
        stopOid = moved.kind === "resting" ? moved.oid : undefined;
        return `replaced by order ${stopOid}, old one cancelled`;
      });
    }

    await step("close the position", async () => {
      const held = (await client.openPositions())[opts.symbol]?.size ?? 0;
      expect(held > 0, `expected a long ${opts.symbol} position to close, found ${held}.`);
      const outcome = await client.placeOrder({
        symbol: opts.symbol,
        side: "sell",
        size: held,
        price: bid * 0.998,
        reduceOnly: true,
        tif: "Ioc",
      });
      expect(outcome.kind === "filled", `the close did not fill: ${describeOutcome(outcome)}`);
      const left = (await client.openPositions())[opts.symbol]?.size ?? 0;
      expect(Math.abs(left) < 10 ** -asset.szDecimals, `${left} ${opts.symbol} is still open after closing.`);
      return `${describeOutcome(outcome)}, flat again`;
    });

    // Whatever happened above, do not walk away leaving a stop on the book.
    await step("clean up", async () => {
      const left = (await client.stopLosses()).filter((s) => s.symbol === opts.symbol);
      for (const stop of left) await client.cancelOrder(opts.symbol, stop.oid);
      const after = (await client.stopLosses()).filter((s) => s.symbol === opts.symbol);
      expect(after.length === 0, `${after.length} stop-loss order(s) still open: cancel them by hand.`);
      return left.length === 0 ? "nothing left behind" : `cancelled ${left.length} leftover stop(s)`;
    });
  }

  summarise(results, deps);
  return results;
}

function summarise(results: StepResult[], deps: LiveCheckDeps): void {
  const failed = results.filter((r) => !r.ok);
  deps.out(
    failed.length === 0
      ? `\nAll ${results.length} checks passed.\n`
      : `\n${failed.length} of ${results.length} checks failed: ${failed.map((r) => r.name).join(", ")}.\n`,
  );
}
