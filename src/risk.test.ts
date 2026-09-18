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
