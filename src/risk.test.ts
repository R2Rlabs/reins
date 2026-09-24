import { describe, expect, it } from "vitest";
import { RiskEngine, type AccountState, type RiskLimits } from "./risk.js";

const limits: RiskLimits = {
  maxPositionUsd: 25_000,
  maxLeverage: 5,
  dailyLossLimitUsd: 2_500,
  symbolAllowlist: ["BTC", "ETH"],
  maxOrdersPerMinute: 12,
};

const flat: AccountState = {
  positionsUsd: {},
  realizedPnlTodayUsd: 0,
  accountValueUsd: 20_000,
};

function engineAt(t: { ms: number }) {
  return new RiskEngine(limits, () => t.ms);
}

describe("allowed orders", () => {
  it("lets a normal order through", () => {
    const engine = new RiskEngine(limits);
    expect(engine.check({ symbol: "BTC", side: "buy", sizeUsd: 10_000 }, flat)).toEqual({
      allowed: true,
    });
  });

  it("allows adding up to exactly the position cap", () => {
    const engine = new RiskEngine(limits);
    const state = { ...flat, positionsUsd: { BTC: 20_000 } };
    expect(
      engine.check({ symbol: "BTC", side: "buy", sizeUsd: 5_000 }, state).allowed,
    ).toBe(true);
  });
});

describe("position cap", () => {
  it("blocks an order that would exceed it", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 61_400 }, flat);
    expect(decision).toMatchObject({ allowed: false, code: "POSITION_TOO_LARGE" });
  });

  it("counts the existing position, not just the new order", () => {
    const engine = new RiskEngine(limits);
    const state = { ...flat, positionsUsd: { BTC: 24_000 } };
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 2_000 }, state);
    expect(decision).toMatchObject({ allowed: false, code: "POSITION_TOO_LARGE" });
  });

  it("caps shorts by absolute size too", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check({ symbol: "BTC", side: "sell", sizeUsd: 30_000 }, flat);
    expect(decision).toMatchObject({ allowed: false, code: "POSITION_TOO_LARGE" });
  });

  it("lets a sell that flips a long into a small short through", () => {
    const engine = new RiskEngine(limits);
    const state = { ...flat, positionsUsd: { BTC: 10_000 } };
    expect(
      engine.check({ symbol: "BTC", side: "sell", sizeUsd: 15_000 }, state).allowed,
    ).toBe(true);
  });
});

describe("symbol allowlist", () => {
  it("blocks a symbol that is not listed", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check({ symbol: "DOGE", side: "buy", sizeUsd: 100 }, flat);
    expect(decision).toMatchObject({ allowed: false, code: "SYMBOL_NOT_ALLOWED" });
  });

  it("blocks unlisted symbols even when reduce-only", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check(
      { symbol: "DOGE", side: "sell", sizeUsd: 100, reduceOnly: true },
      flat,
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("daily loss halt", () => {
  const blown: AccountState = {
    ...flat,
    positionsUsd: { BTC: 8_000 },
    realizedPnlTodayUsd: -2_500,
  };

  it("halts at exactly the limit, not one dollar past it", () => {
    const engine = new RiskEngine(limits);
    expect(engine.isHalted(blown)).toBe(true);
  });

  it("blocks new risk once halted", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 1_000 }, blown);
    expect(decision).toMatchObject({ allowed: false, code: "HALTED_DAILY_LOSS" });
  });

  it("still lets the agent close out", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check(
      { symbol: "BTC", side: "sell", sizeUsd: 8_000, reduceOnly: true },
      blown,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("leverage cap", () => {
  it("blocks an order that pushes account leverage over the cap", () => {
    const engine = new RiskEngine(limits);
    const state: AccountState = {
      positionsUsd: { ETH: 20_000 },
      realizedPnlTodayUsd: 0,
      accountValueUsd: 8_000,
    };
    // 20k ETH + 25k BTC = 45k gross on an 8k account, or 5.6x.
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 25_000 }, state);
    expect(decision).toMatchObject({ allowed: false, code: "LEVERAGE_TOO_HIGH" });
  });

  it("allows the same order when the account is large enough to carry it", () => {
    const engine = new RiskEngine(limits);
    const state: AccountState = {
      positionsUsd: { ETH: 20_000 },
      realizedPnlTodayUsd: 0,
      accountValueUsd: 10_000,
    };
    // Same 45k gross, but 4.5x against 10k — under the cap, so it stands.
    expect(
      engine.check({ symbol: "BTC", side: "buy", sizeUsd: 25_000 }, state).allowed,
    ).toBe(true);
  });

  it("refuses to open risk on a zeroed account", () => {
    const engine = new RiskEngine(limits);
    const state: AccountState = { ...flat, accountValueUsd: 0 };
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 100 }, state);
    expect(decision).toMatchObject({ allowed: false, code: "LEVERAGE_TOO_HIGH" });
  });
});

describe("rate limit", () => {
  it("blocks the order after the cap is reached", () => {
    const clock = { ms: 1_000_000 };
    const engine = engineAt(clock);
    for (let i = 0; i < 12; i++) engine.recordOrder();
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 100 }, flat);
    expect(decision).toMatchObject({ allowed: false, code: "RATE_LIMITED" });
  });

  it("forgets orders older than the rolling window", () => {
    const clock = { ms: 1_000_000 };
    const engine = engineAt(clock);
    for (let i = 0; i < 12; i++) engine.recordOrder();
    clock.ms += 60_001;
    expect(engine.check({ symbol: "BTC", side: "buy", sizeUsd: 100 }, flat).allowed).toBe(
      true,
    );
  });
});

describe("malformed input", () => {
  it.each([0, -5, NaN, Infinity])("rejects a size of %s", (sizeUsd) => {
    const engine = new RiskEngine(limits);
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd }, flat);
    expect(decision).toMatchObject({ allowed: false, code: "INVALID_ORDER" });
  });
});

describe("refusal messages", () => {
  it("shows money with at most two decimals, whatever the machine's locale", () => {
    const engine = new RiskEngine(limits);
    const state = { ...flat, positionsUsd: { BTC: 499.3071 } };
    const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 50_000 }, state);
    expect(decision).toEqual({
      allowed: false,
      code: "POSITION_TOO_LARGE",
      reason: "Would put BTC at $50,499.31, over the $25,000 cap.",
    });
  });

  it("writes a realised loss as a negative dollar amount", () => {
    const engine = new RiskEngine(limits);
    const decision = engine.check(
      { symbol: "BTC", side: "buy", sizeUsd: 100 },
      { ...flat, realizedPnlTodayUsd: -2_600 },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("(realised -$2,600)");
  });
});

describe("maxTradeRiskUsd", () => {
  const capped = new RiskEngine({ ...limits, maxTradeRiskUsd: 100 });
  const order = (sizeUsd: number, riskUsd: number) => ({
    symbol: "BTC" as const,
    side: "buy" as const,
    sizeUsd,
    hasStopLoss: true,
    riskUsd,
  });

  it("allows a wide stop on a small order, and a tight stop on a large one", () => {
    // $2,000 with the stop 5% away, and $20,000 with it 0.5% away: both $100.
    expect(capped.check(order(2_000, 100), flat)).toEqual({ allowed: true });
    expect(capped.check(order(20_000, 100), flat)).toEqual({ allowed: true });
  });

  it("refuses a position whose stop would cost more than the limit", () => {
    const decision = capped.check(order(10_000, 500), flat);
    expect(decision).toMatchObject({ allowed: false, code: "TRADE_RISK_TOO_LARGE" });
    expect(decision).toMatchObject({ reason: expect.stringContaining("lose $500, over the $100 allowed") });
    expect(decision).toMatchObject({ reason: expect.stringContaining("Move the stop closer or send a smaller order") });
  });

  it("is not in the way of closing a position", () => {
    const long = { ...flat, positionsUsd: { BTC: 10_000 } };
    expect(
      capped.check({ symbol: "BTC", side: "sell", sizeUsd: 10_000, reduceOnly: true, riskUsd: 900 }, long),
    ).toEqual({ allowed: true });
  });

  it("does nothing unless the limit is set", () => {
    expect(new RiskEngine(limits).check(order(10_000, 5_000), flat)).toEqual({ allowed: true });
  });

  it("lets an order through when the risk is not known", () => {
    // No stop, no figure to check: the stop-loss rule is what covers that case.
    expect(capped.check({ symbol: "BTC", side: "buy", sizeUsd: 10_000 }, flat)).toEqual({ allowed: true });
  });
});

describe("requireStopLoss", () => {
  const guarded = new RiskEngine({ ...limits, requireStopLoss: true });
  const long = { ...flat, positionsUsd: { BTC: 5_000 } };

  it("refuses new risk while another position has no stop", () => {
    const decision = guarded.check(
      { symbol: "ETH", side: "buy", sizeUsd: 1_000, hasStopLoss: true },
      { ...long, unprotectedSymbols: ["BTC"] },
    );
    expect(decision).toMatchObject({ allowed: false, code: "NO_STOP_LOSS" });
    expect(decision.allowed === false && decision.reason).toMatch(/BTC has no stop-loss/);
  });

  it("lets an order that brings its own stop cover its own symbol", () => {
    expect(
      guarded.check(
        { symbol: "BTC", side: "buy", sizeUsd: 1_000, hasStopLoss: true },
        { ...long, unprotectedSymbols: ["BTC"] },
      ),
    ).toEqual({ allowed: true });
  });

  it("wants a stop on every order that adds risk, resting or not", () => {
    const decision = guarded.check({ symbol: "ETH", side: "buy", sizeUsd: 1_000 }, flat);
    expect(decision).toMatchObject({ allowed: false, code: "NO_STOP_LOSS" });
    expect(decision.allowed === false && decision.reason).toMatch(/must carry a stopLoss/);
    expect(
      guarded.check({ symbol: "ETH", side: "buy", sizeUsd: 1_000, hasStopLoss: true }, flat),
    ).toEqual({ allowed: true });
  });

  it("never stands in the way of reducing risk", () => {
    const unprotected = { ...long, unprotectedSymbols: ["BTC"] };
    expect(
      guarded.check({ symbol: "BTC", side: "sell", sizeUsd: 5_000, reduceOnly: true }, unprotected),
    ).toEqual({ allowed: true });
    // Not flagged reduce-only, but it only shrinks the position.
    expect(
      guarded.check({ symbol: "BTC", side: "sell", sizeUsd: 2_000 }, unprotected),
    ).toEqual({ allowed: true });
  });

  it("counts flipping a position through zero as new risk", () => {
    expect(
      guarded.check({ symbol: "BTC", side: "sell", sizeUsd: 7_000 }, long),
    ).toMatchObject({ allowed: false, code: "NO_STOP_LOSS" });
  });

  it("is off unless configured", () => {
    expect(
      new RiskEngine(limits).check({ symbol: "ETH", side: "buy", sizeUsd: 1_000 }, {
        ...long,
        unprotectedSymbols: ["BTC"],
      }),
    ).toEqual({ allowed: true });
  });
});
