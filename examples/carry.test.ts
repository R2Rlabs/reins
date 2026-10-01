/**
 * The carry model, where getting the arithmetic wrong would flatter the trade:
 * funding that is received hour by hour, four legs of fees rather than two,
 * and hours when funding turns and the position pays instead of being paid.
 */
import { describe, expect, it } from "vitest";
import { annualise, backtestCarry, type CarryOptions } from "./carry.ts";
import type { FundingPoint } from "../dist/index.js";

const HOUR = 3_600_000;

function funding(rates: number[]): FundingPoint[] {
  return rates.map((rate, i) => ({
    coin: "BTC",
    fundingRate: String(rate),
    premium: "0",
    time: i * HOUR,
  }));
}

const options: CarryOptions = {
  enterAbovePct: 10,
  exitBelowPct: 3,
  sizeUsd: 10_000,
  builderFeeIsYours: true,
  lookbackHours: 2,
};

describe("annualise", () => {
  it("turns an hourly rate into the percentage people quote", () => {
    // Hyperliquid's floor, 0.00125% an hour.
    expect(annualise(0.0000125)).toBeCloseTo(10.95, 2);
  });
});

describe("entering and leaving", () => {
  it("does not enter while funding is below the threshold", () => {
    // 0.0000025/h is about 2.2% annualised — under the 10% needed.
    const result = backtestCarry(funding(Array(50).fill(0.0000025)), options);
    expect(result.spells).toHaveLength(0);
    expect(result.netUsd).toBe(0);
  });

  it("enters once the trailing average is rich enough", () => {
    // 0.00005/h is about 43.8% annualised.
    const result = backtestCarry(funding(Array(50).fill(0.00005)), options);
    expect(result.spells).toHaveLength(1);
    expect(result.spells[0]!.annualisedPctAtEntry).toBeCloseTo(43.8, 1);
  });

  it("leaves when funding falls away, and counts the hours it held", () => {
    const rates = [...Array(20).fill(0.00005), ...Array(20).fill(0.0000001)];
    const result = backtestCarry(funding(rates), options);
    expect(result.spells).toHaveLength(1);
    const spell = result.spells[0]!;
    expect(spell.hours).toBeGreaterThan(10);
    expect(spell.hours).toBeLessThan(25);
  });
});

describe("the money", () => {
  it("collects funding every hour it is open", () => {
    const rate = 0.00005;
    const result = backtestCarry(funding(Array(30).fill(rate)), options);
    const spell = result.spells[0]!;
    // Still open at the end, so every hour after entry paid.
    expect(spell.fundingUsd).toBeCloseTo(rate * options.sizeUsd * spell.hours, 4);
  });

  it("charges four legs, not two", () => {
    const result = backtestCarry(funding(Array(30).fill(0.00005)), options);
    // Spot in, spot out, perp in, perp out, at the taker rate.
    expect(result.feesUsd).toBeCloseTo(options.sizeUsd * 0.00045 * 4, 6);
  });

  it("adds the builder fee on the perp legs when it is not your own", () => {
    const mine = backtestCarry(funding(Array(30).fill(0.00005)), options);
    const theirs = backtestCarry(funding(Array(30).fill(0.00005)), {
      ...options,
      builderFeeIsYours: false,
    });
    // 2 bp on the way in and out of the perp leg only.
    expect(theirs.feesUsd - mine.feesUsd).toBeCloseTo(options.sizeUsd * 0.0002 * 2, 6);
  });

  it("loses money when funding turns negative while it is held", () => {
    // Rich enough to enter, then funding flips hard against the short.
    const rates = [...Array(5).fill(0.00005), ...Array(10).fill(-0.00005)];
    const result = backtestCarry(funding(rates), { ...options, exitBelowPct: -100 });
    expect(result.hoursCosting).toBeGreaterThan(0);
    expect(result.fundingUsd).toBeLessThan(0);
    expect(result.netUsd).toBeLessThan(0);
  });

  it("nets fees out of the funding, so a short rich spell still loses", () => {
    // Two hours of good funding cannot pay for four legs of fees.
    const rates = [...Array(2).fill(0.00005), ...Array(4).fill(0.00005), ...Array(4).fill(0)];
    const result = backtestCarry(funding(rates), options);
    const spell = result.spells[0]!;
    expect(spell.fundingUsd).toBeLessThan(spell.feesUsd);
    expect(spell.netUsd).toBeLessThan(0);
  });
});
