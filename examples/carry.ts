/**
 * Does funding carry survive the fees?
 *
 *   npm run build
 *   node examples/carry.ts                      # BTC, 180 days
 *   node examples/carry.ts --symbol ETH --days 90 --enter 15 --exit 5
 *
 * ## What carry is, and what it is not
 *
 * Hyperliquid charges funding every hour. When it is positive, longs pay
 * shorts. A **carry trade** holds the asset and shorts the perp against it:
 * the price move cancels between the two legs, and the funding is the return.
 * It is the one trade here that does not require guessing direction.
 *
 * Shorting the perp *without* the spot leg is not carry. It is a bet on the
 * price falling with a funding tailwind, and it is the mistake this file is
 * written to avoid making quietly.
 *
 * ## What this models, and what it ignores
 *
 * Modelled: hourly funding actually paid, both legs' entry and exit fees, and
 * the hours in which funding turned against the position.
 *
 * Ignored, and each one makes the real thing worse than this:
 *
 * - **Basis.** The two legs are assumed to offset exactly. In practice spot
 *   and perp drift apart, and the gap is a real PnL that can be either way.
 * - **Liquidation.** The short perp leg needs margin. A hard rally can
 *   liquidate it while the spot leg is fine, which is the usual way this trade
 *   goes wrong in a bull market.
 * - **Spot borrow or custody**, and any difference between spot and perp fee
 *   tiers. Spot is charged at the perp taker rate here.
 *
 * So treat a positive result as "worth testing on paper", never as a return.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  BASE_TAKER_FEE_RATE,
  HyperliquidClient,
  REINS_BUILDER,
  type FundingPoint,
} from "../dist/index.js";

export interface CarryOptions {
  /** Annualised percentage at which the trade is worth opening. */
  enterAbovePct: number;
  /** Annualised percentage at which it is closed. */
  exitBelowPct: number;
  /** Notional on each leg. */
  sizeUsd: number;
  /** Charged on entry and exit, on both legs. */
  takerFeeRate?: number;
  /** Your own bot pays the builder fee to your own wallet, so it nets out. */
  builderFeeIsYours?: boolean;
  /** How many hours of funding to average before deciding. */
  lookbackHours?: number;
}

export interface CarrySpell {
  openedAt: number;
  closedAt: number;
  hours: number;
  fundingUsd: number;
  feesUsd: number;
  netUsd: number;
  annualisedPctAtEntry: number;
}

export interface CarryResult {
  spells: CarrySpell[];
  fundingUsd: number;
  feesUsd: number;
  netUsd: number;
  hoursHeld: number;
  hoursPaying: number;
  hoursCosting: number;
  breakEvenHours: number;
}

const HOURS_PER_YEAR = 24 * 365;

/** An hourly rate as the annualised percentage a human would quote. */
export function annualise(hourlyRate: number): number {
  return hourlyRate * HOURS_PER_YEAR * 100;
}

/**
 * Replay funding, entering when the trailing average is rich enough to pay for
 * the round trip and leaving when it is not.
 *
 * Both legs are charged on entry and exit, which is four fees for one trade —
 * the number that decides whether carry works at a given size and holding
 * period.
 */
export function backtestCarry(funding: FundingPoint[], options: CarryOptions): CarryResult {
  const taker = options.takerFeeRate ?? BASE_TAKER_FEE_RATE;
  const builder = options.builderFeeIsYours ? 0 : REINS_BUILDER.feeTenthsBps / 100_000;
  // Spot in, spot out, perp in, perp out. The builder fee rides on the perp.
  const roundTripRate = taker * 4 + builder * 2;
  const lookback = options.lookbackHours ?? 8;

  const spells: CarrySpell[] = [];
  let open: { at: number; funding: number; entryPct: number } | null = null;
  let hoursPaying = 0;
  let hoursCosting = 0;

  for (let i = lookback; i < funding.length; i++) {
    const point = funding[i]!;
    const rate = Number(point.fundingRate);
    const recent =
      funding.slice(i - lookback, i).reduce((sum, p) => sum + Number(p.fundingRate), 0) / lookback;
    const recentPct = annualise(recent);

    if (open) {
      // Funding is received by the short leg each hour it stays positive.
      const income = rate * options.sizeUsd;
      open.funding += income;
      if (income >= 0) hoursPaying++;
      else hoursCosting++;

      if (recentPct < options.exitBelowPct) {
        const fees = options.sizeUsd * roundTripRate;
        spells.push({
          openedAt: open.at,
          closedAt: point.time,
          hours: Math.round((point.time - open.at) / 3_600_000),
          fundingUsd: open.funding,
          feesUsd: fees,
          netUsd: open.funding - fees,
          annualisedPctAtEntry: open.entryPct,
        });
        open = null;
      }
      continue;
    }

    if (recentPct > options.enterAbovePct) {
      open = { at: point.time, funding: 0, entryPct: recentPct };
    }
  }

  if (open && funding.length) {
    const last = funding.at(-1)!;
    const fees = options.sizeUsd * roundTripRate;
    spells.push({
      openedAt: open.at,
      closedAt: last.time,
      hours: Math.round((last.time - open.at) / 3_600_000),
      fundingUsd: open.funding,
      feesUsd: fees,
      netUsd: open.funding - fees,
      annualisedPctAtEntry: open.entryPct,
    });
  }

  const fundingUsd = spells.reduce((s, x) => s + x.fundingUsd, 0);
  const feesUsd = spells.reduce((s, x) => s + x.feesUsd, 0);
  return {
    spells,
    fundingUsd,
    feesUsd,
    netUsd: fundingUsd - feesUsd,
    hoursHeld: spells.reduce((s, x) => s + x.hours, 0),
    hoursPaying,
    hoursCosting,
    // At the average rate observed, how long the position must be held for the
    // funding to cover the four fees.
    breakEvenHours: 0,
  };
}

export function reportCarry(
  result: CarryResult,
  funding: FundingPoint[],
  options: CarryOptions,
  label: string,
): string {
  const rates = funding.map((p) => Number(p.fundingRate));
  const average = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length);
  const taker = options.takerFeeRate ?? BASE_TAKER_FEE_RATE;
  const builder = options.builderFeeIsYours ? 0 : REINS_BUILDER.feeTenthsBps / 100_000;
  const roundTripRate = taker * 4 + builder * 2;
  const breakEvenHours = average > 0 ? roundTripRate / average : Number.POSITIVE_INFINITY;
  const days = (funding.at(-1)!.time - funding[0]!.time) / 86_400_000;
  const returnPct = (result.netUsd / options.sizeUsd) * 100;

  if (result.spells.length === 0) {
    return `${label}\n  never entered: funding did not reach ${options.enterAbovePct}% annualised.`;
  }

  return [
    label,
    `  ${result.spells.length} spells, ${result.hoursHeld} hours held of ${(days * 24).toFixed(0)}` +
      ` (${((result.hoursHeld / (days * 24)) * 100).toFixed(0)}% of the time)`,
    `  funding paid out on ${result.hoursPaying} hours, cost money on ${result.hoursCosting}`,
    ``,
    `  funding      +$${result.fundingUsd.toFixed(2)}`,
    `  fees         -$${result.feesUsd.toFixed(2)}  (${(roundTripRate * 10_000).toFixed(1)} bp a round trip, four legs)`,
    `  net          ${result.netUsd >= 0 ? "+" : ""}$${result.netUsd.toFixed(2)} on $${options.sizeUsd.toLocaleString()} a side` +
      ` — ${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}% over ${days.toFixed(0)} days`,
    ``,
    `  Average funding was ${annualise(average).toFixed(1)}% annualised, so a position must be held` +
      ` ${breakEvenHours.toFixed(0)} hours just to cover the four fees.`,
  ].join("\n");
}

/**
 * The whole history, in the 500-hour windows the exchange will give.
 *
 * It returns at most 500 points and does not say it truncated, so asking for
 * six months silently answers with three weeks — which is exactly long enough
 * to draw a confident conclusion from the wrong sample.
 */
export async function fundingOver(
  client: HyperliquidClient,
  symbol: string,
  days: number,
): Promise<FundingPoint[]> {
  const start = Date.now() - days * 86_400_000;
  const all: FundingPoint[] = [];
  let cursor = start;
  for (let page = 0; page < 40; page++) {
    const batch = await client.fundingHistory(symbol, cursor);
    const fresh = batch.filter((p) => p.time > (all.at(-1)?.time ?? 0));
    if (fresh.length === 0) break;
    all.push(...fresh);
    const last = all.at(-1)!.time;
    if (last >= Date.now() - 3_600_000 || batch.length < 500) break;
    cursor = last + 1;
  }
  return all;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: "string", default: "BTC" },
      days: { type: "string", default: "180" },
      size: { type: "string", default: "2500" },
      enter: { type: "string", default: "10" },
      exit: { type: "string", default: "3" },
      mine: { type: "boolean", default: true },
    },
  });

  const client = new HyperliquidClient({ network: "mainnet" });
  const days = Number(values.days);
  const funding = await fundingOver(client, values.symbol!, days);
  if (funding.length === 0) {
    console.log(`No funding history for ${values.symbol}.`);
    return;
  }

  const rates = funding.map((p) => Number(p.fundingRate));
  const positive = rates.filter((r) => r > 0).length;
  console.log(
    `${funding.length} hours of ${values.symbol} funding, ` +
      `${new Date(funding[0]!.time).toISOString().slice(0, 10)} to ${new Date(funding.at(-1)!.time).toISOString().slice(0, 10)}`,
  );
  console.log(
    `positive ${((positive / rates.length) * 100).toFixed(0)}% of hours, ` +
      `average ${annualise(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1)}% annualised, ` +
      `highest ${annualise(Math.max(...rates)).toFixed(0)}%\n`,
  );

  const size = Number(values.size);
  for (const [enter, exit] of [
    [Number(values.enter), Number(values.exit)],
    [20, 5],
    [40, 10],
  ]) {
    const options: CarryOptions = {
      enterAbovePct: enter!,
      exitBelowPct: exit!,
      sizeUsd: size,
      builderFeeIsYours: values.mine,
    };
    console.log(
      reportCarry(backtestCarry(funding, options), funding, options, `enter over ${enter}%, leave under ${exit}%`),
      "\n",
    );
  }

  console.log(
    [
      "Carry here means long spot and short perp, so the price move cancels and the funding is",
      "the return. Not modelled, and all of them make the real thing worse: basis drift between",
      "the two legs, liquidation of the short leg in a rally, and spot fees that may be higher",
      "than the perp rate used here.",
    ].join("\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
