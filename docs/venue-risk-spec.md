# Five Hyperliquid-specific limits: what each would take

Spec written 2026-09-30 in response to a handoff proposing that Reins stop
competing on generic agent guardrails (position size, leverage, daily loss,
allowlist, rate limit, stop-loss — now table stakes in every agent wallet) and
build venue-specific perp risk instead, which a generalist spread over thousands
of tokens on eighty chains structurally cannot.

The reasoning holds. What follows is each limit measured against the interfaces
that exist today, because one premise in the handoff is wrong and it changes the
order of work.

## The correction

> `PositionSnapshot` / `ClearinghouseState` already carry liquidation price.

They do not. `AssetPosition.position` in `src/types.ts` parses `coin`, `szi`,
`entryPx`, `positionValue`, `unrealizedPnl` and `marginUsed`. There is no
`liquidationPx`, and `PositionSnapshot` carries only `positionsUsd` and
`accountValueUsd` — which is also all `AccountState` gives the engine.

Hyperliquid returns `liquidationPx` per position, so the field is one line of
parsing away, but it has to be carried through four types before `RiskEngine`
can see it. None of the five limits is a change to `src/risk.ts` alone.

## 1. Liquidation distance — build this one first

Refuse an order that leaves, or would leave, the liquidation price within X% of
mark.

- **Why it ranks first:** it is how leveraged accounts actually die. A position
  can sit inside every existing limit — under the size cap, under max leverage,
  stop attached — and still be one wick from liquidation, because those limits
  measure notional and the exchange measures margin.
- **Data:** `liquidationPx` on each position, plus mark. Both available; neither
  parsed.
- **Honest scope:** refusing on the *current* position's distance is
  straightforward. Projecting the distance *after* the proposed order is not —
  it needs maintenance-margin maths per asset (Hyperliquid uses half the initial
  margin at max leverage) and differs under cross and isolated. Ship the guard
  first, project later, and say which one it does.
- **New code:** `LIQUIDATION_TOO_CLOSE`.
- **Also worth it regardless:** surface liquidation distance in `get_positions`,
  so an agent can see the number even where nothing is refused.

## 2. Funding-aware cap

Refuse adding to a position paying more than Y% funding.

- **Data:** funding rates from asset contexts — a new call on
  `MarketDataSource`, which today offers books, candles and meta only.
- **Judgement:** real, but slower-acting than the others. Funding bleeds an
  account over days; liquidation ends it in seconds. It is also the limit most
  likely to annoy: a carry trade pays funding on purpose.
- **New code:** `FUNDING_TOO_EXPENSIVE`.

## 3. ADL risk

Hyperliquid auto-deleverages profitable positions when the insurance fund cannot
absorb a loss, so a winning position can be closed without being wrong.

- **Data:** ADL exposure is not directly published. It would have to be inferred
  from position PnL ranking and open interest, which makes any threshold a
  heuristic rather than a rule.
- **Judgement:** genuinely venue-specific and nobody else models it — but a
  refusal an operator cannot reproduce is worse than no refusal. Better as a
  warning surfaced in `get_positions` than as a block, at least until the
  inference is tested against real ADL events.
- **New code:** none at first; a field, not a refusal.

## 4. Cross vs isolated margin

Limits mean different things under each mode and the engine currently conflates
them: `accountValueUsd` is the whole account under cross, while an isolated
position can only lose its own margin.

- **Data:** margin mode per position (`leverage.type` in the raw state) plus the
  account mode `positionSnapshot` already asks for.
- **Judgement:** this is a correctness fix more than a new limit, and it makes
  (1) correct. Cheapest real improvement after liquidation distance.
- **New code:** none; it changes what the existing codes mean.

## 5. Correlated / aggregate exposure

Bound total risk across correlated perps rather than per market.

- **Data:** `projectedTotalExposureUsd` already sums exposure; correlation does
  not exist anywhere in the codebase and would have to be computed from candles
  or hard-coded by hand.
- **Judgement:** the weakest of the five. "BTC and ETH move together" is already
  served by a total-exposure cap, which exists. A correlation estimate from an
  hour of candles is a number that will be wrong exactly when it matters.
- **New code:** `CORRELATED_EXPOSURE_TOO_HIGH`, if built.

## Order of work

1. Parse `liquidationPx` and margin mode; carry both through `PositionSnapshot`
   and `AccountState`; surface them in `get_positions`. Nothing refuses yet.
2. Liquidation distance as a refusal on current state (`LIQUIDATION_TOO_CLOSE`).
3. Cross vs isolated correctness.
4. Projected liquidation after the order.
5. Funding cap.

ADL as a warning field, correlation last or never.

## Shape every one of these must keep

Each needs its `RiskCode` variant and a reason string in the existing shape — a
sentence naming the number that failed and what to change — so the decision log,
the HTTP 400s, the Python client's `Refused.code` and Reins Cloud's copy keep
working with no changes.

## Done already

`REINS_BUILDER`, `REINS_BUILDER_ADDRESS`, `DEFAULT_BUILDER_FEE_TENTHS_BPS` and
`feeApprovalProblem` are now exported from the package index, so reins-cloud can
import the fee instead of duplicating it. Verified from the built package. Drift
between the fee charged and the fee the account approved stops live trading, so
one source for it is worth having regardless of the rest of this.
