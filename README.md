# Reins

**Let an AI agent trade without giving it the power to lose everything.**

```bash
npx @r2rlabs/reins init      # adds a paper-trading Reins server to .mcp.json
```

See it at work: [an AI agent trading Hyperliquid on paper, run 2](https://gist.github.com/R2Rlabs/246a5009684787a586ddee1d2615eb14).

### What Reins is

- **Limits the agent can't argue with.** Every order passes checks that live
  outside the model: position size, leverage, daily loss, which markets it may
  trade, and a stop-loss on every position. No prompt, clever reasoning or
  mistake gets around them.
- **A record you can check.** Every decision is logged with the reason the agent
  gave — including the orders it was refused, the times it chose to wait, and
  what the exchange did without it. You can compare what the agent *said* with
  what actually *happened*.
- **Somewhere to rehearse.** Paper trading on live Hyperliquid prices with
  realistic fills and fees, using the same tools and limits as live trading.
- **Non-custodial.** Your money stays in your own Hyperliquid account. Reins
  trades through an API wallet, which can place orders but cannot withdraw.
- **Paid for openly.** A small builder fee (2 bp) on live orders, shown up front.

### What Reins is not

- **Not a trading bot or a strategy.** Reins doesn't decide what to trade and
  won't make an agent profitable. The demo agent is a test drive, not the product.
- **Not an exchange, broker or custodian.** It holds no funds and matches no
  orders; Hyperliquid does that.
- **Not a promise against losses.** Limits cap how much can go wrong. They don't
  make bad trades good, and stops can slip in fast markets.
- **Not financial advice.**
- **Not something you have to take on trust.** Not the agent's word, and not
  ours: every action is on the record.

### Principles

1. Limits live outside the model.
2. The record outranks the reasoning.
3. Paper before real money.
4. Your keys, your funds.

## Why this exists

Several open-source Hyperliquid MCP servers already exist. They are thin API
wrappers: you hand them a private key and hope the model behaves. The gap is
everything around that — the limits, the sandbox, the audit trail. That is what
this repo is.

## Status

Early, but real. 371 tests, no network calls in any of them.

| Module | What it does |
|---|---|
| `src/risk.ts` | The risk engine — position cap, leverage cap, daily loss halt, allowlist, rate limit |
| `src/client.ts` | Hyperliquid REST client — orders, cancels, book, candles, fills, account state, builder code |
| `src/mcp-server.ts` | The agent-facing tools, each risk-checked and logged before anything is sent |
| `src/paper.ts` | Paper trading — live prices, simulated fills. See below |
| `src/paper-store.ts` | Persists a paper run across restarts |
| `src/trading-client.ts` | The interface live and paper both satisfy |
| `src/decision-log.ts` | Append-only record of every attempt and its stated reason |
| `src/decision-log-file.ts` | JSON Lines log on disk |
| `src/bin/cli.ts` | The `reins` command: `serve` (default), `init`, `approve-builder`, `live-check` and `stats` |
| `src/bin/serve.ts` | stdio entry point |
| `src/init.ts` | `reins init` — writes a paper-mode server entry into `.mcp.json` |
| `src/builder-fee.ts` | Reins' builder fee, and the approval live trading needs before it starts |
| `src/approve-builder.ts` | `reins approve-builder` — the user approves the builder fee in their own wallet |
| `src/live-check.ts` | `reins live-check` — proves the live exchange accepts what Reins sends |
| `src/platform-stats.ts` | `reins stats` — accounts, trades, volume and fees through Reins' builder code |
| `src/lz4.ts` | Reads Hyperliquid's LZ4-compressed data files, without a dependency |
| `src/builder-approval.ts` | The ApproveBuilderFee action: EIP-712 typed data, signature checks |
| `src/format.ts` | Price and size formatting to Hyperliquid's tick and lot rules |
| `src/signing.ts` | L1 action signing, verified against the Python SDK's vectors |
| `src/private-key-signer.ts` | A Signer backed by a private key |
| `src/signer.ts` | The Signer interface plus a stub. See "On signing" below |
| `src/mock-transport.ts` | In-memory API stand-in, so agents can be tested without a network |
| `examples/demo-agent/` | Claude trading on paper through Reins, producing a publishable decision log |

All of it works end to end. Going live is now a matter of funding an account and
setting `REINS_MODE=live` with a key.

### Going live

```bash
REINS_MODE=live
REINS_NETWORK=testnet          # mainnet spends real money
REINS_ACCOUNT_ADDRESS=0x...    # your Hyperliquid account
REINS_PRIVATE_KEY=0x...        # an API wallet's key, not your account's; omit to stay read-only
```

On mainnet, approve Reins' 2 bp builder fee once, from the account's own
wallet, before the first live session: `npx @r2rlabs/reins approve-builder`.
Until the account has, live mode refuses to start and says so.

**Use an API wallet, not your account's own key.** Hyperliquid lets an account
approve API wallets that can trade for it but cannot withdraw from it — create
one on Hyperliquid's API page, signing the approval with your main wallet. Put
its key in `REINS_PRIVATE_KEY` and your account's address in
`REINS_ACCOUNT_ADDRESS`: orders are signed by the API wallet, while positions,
fills and stops are read from the account, because under the API wallet's own
address the account looks empty. The startup banner names both. Hyperliquid
prunes API wallets that expire or are replaced; make a fresh one rather than
reusing an old address.

Every account mode works. Hyperliquid starts new accounts in **Unified**,
where the USDC sits in the spot balance and the perps account reads $0; Reins
asks the account which mode it is in and, for Unified and Portfolio margin,
takes equity from the USDC balance plus the positions' unrealized PnL. Manual
accounts are read from perps as before. (A *builder* address is different: it
must be in Manual — `standard` — to earn fees.)

Defaults are deliberately safe: `REINS_MODE` is `paper` and `REINS_NETWORK` is
`testnet`, so trading real funds takes two explicit changes rather than one
forgotten variable. Live mode without a key stays read-only instead of failing
at the first order, and mainnet prints a loud banner on startup.

The private key is only read in live mode — paper never signs anything, so it is
never handed the means to.

## See it run

```bash
npm run build
npm run demo -- --scripted      # free: no API key, live prices, paper fills
```

With an Anthropic API key, `npm run demo` runs Claude as the agent under a hard
spending cap. See [`examples/demo-agent`](examples/demo-agent/) for cost, limits and how
to publish the result honestly.

## The decision log

Every attempted action is appended to a log with the reason the agent gave for
it — **including the ones the risk limits refused.** That is the point. "The
agent tried to open six times its position cap at 3am, and here is what it said
it was doing" is the most useful thing this system can tell you, and it only
exists if refusals are written down.

`place_order`, `close_position` and `set_stop_loss` take a **required** `reason`. An optional
field gets omitted; a required one gets answered.

Records are JSON Lines — one self-contained object per line, appended, never
rewritten. Appends stay cheap as the file grows, a truncated write damages one
line instead of the file, and you can query it with ordinary tools:

```bash
jq -r 'select(.risk.allowed == false) | [.time, .risk.code, .reason] | @tsv' decisions.jsonl
```

Each record holds the stated reason, the request, the account context at the
time, the risk verdict, and the outcome. Set `REINS_LOG_FILE` to persist it;
without it the log lives in memory and dies with the process.

The exchange also acts on its own: a stop-loss fires, a resting order fills
hours after it was placed. Before every tool call Reins compares the account's
fills with the log and appends each one it has not seen as an `exchange_fill`
record, whose reason starts "Not an agent decision:" and says whether it was a
stop, a resting order, or a fill Reins did not place. Without them the trade
that mattered most, the stop that closed it, would be missing from the record.
The agent reads them back through `get_recent_decisions` like anything else.

### Two things to be clear about

**`reason` is testimony, not ground truth.** It is the model's own account of
why it acted, captured because reasoning that is not asked for cannot be
recovered later. A model can rationalise after the fact, and a confident
explanation is not evidence that the explanation is what actually drove the
decision. It is extremely useful for debugging and audit. It is not proof.

**A failed log write never fails a filled order.** If the log cannot be written,
the tool still reports success and attaches a warning. An agent told its order
failed will place it again — so a lost log line would become a doubled
position, which is far worse than the missing line. The risk engine is the
safety mechanism; the log is observability.

## Paper trading

`REINS_MODE=paper` (the default) runs the same tools, the same risk engine and
the same agent against **real prices with simulated fills**. Nothing is signed
and nothing reaches the exchange.

Paper and live are swapped behind one interface, so an agent cannot tell which
one it is talking to — which is the point. A strategy that works on paper runs
unchanged on live.

### What the simulation models

- **Real book depth.** A large order walks levels and pays real slippage
  instead of filling entirely at the touch.
- **Partial fills** when the book is too thin inside the limit price.
- **Taker and maker fees** at Hyperliquid's base tier (0.045% / 0.015%), plus
  any builder fee, so the equity curve is net of what trading actually costs.
- **Resting orders that only fill when the market trades strictly *through*
  them**, never merely to them. At your own price you are behind a queue this
  simulation cannot see; assuming a fill there is the most common way a paper
  equity curve lies.
- **Fills between polls.** Each call checks resting orders against the
  one-minute candles printed since they were placed, not just the book at that
  moment, and fills them at the minute the market first went through. Cancelling
  an order that already filled is refused, as the exchange would. Before this,
  the demo agent's breakout bid went unfilled under a dip that lasted two
  minutes, and it then cancelled an order Hyperliquid would already have filled.

### What it does not model

The first five flatter the result; the last two can miss a fill either way.
All of them are listed rather than buried:

- **Latency** — fills are priced off the book as it was when the tool was called
- **Market impact** — your order never moves the price or removes liquidity
- **Funding payments** on perps
- **Slippage past a stop inside a minute already gone** — a stop found
  triggered in a past candle fills at its trigger, or at the candle's open if
  the market gapped through it. One triggered right now walks the real book.
- **Mark price** — Hyperliquid triggers stops on the mark price; paper uses
  traded prices, which can differ briefly
- **The minute an order was placed in** — candles are only counted from the
  first minute that opened after it, so a dip in that same minute is missed
- **Orders resting longer than about three days** — only the latest 5000
  one-minute candles are available, so older stretches go unchecked

**Treat a paper equity curve as an upper bound on live performance, not an
estimate of it.**

### Running a paper account

```json
{
  "env": {
    "REINS_MODE": "paper",
    "REINS_PAPER_BALANCE": "10000",
    "REINS_PAPER_FILE": "./paper-run.json"
  }
}
```

Without `REINS_PAPER_FILE` the account lives in memory and is lost on restart.
Set it for anything you intend to run for more than one session — writes go to a
temp file and are renamed into place, so a crash cannot leave a half-written run
behind.

## The MCP server

Nine tools. Every one that can move money passes the risk engine first, and
every attempt is written to the decision log.

| Tool | Notes |
|---|---|
| `get_limits` | Limits, headroom per symbol, remaining loss budget, halted state |
| `get_positions` | Signed notional per symbol, account value, today's realised PnL, stop-losses, and which positions have none |
| `get_book` | Best bid/ask, spread, nearest levels |
| `get_candles` | Price history in 1m to 1d candles, the average range of one candle, and whether the newest is still forming |
| `place_order` | **Sized in USD**, not asset units — the same unit as the limits. Optional `stopLoss` on orders that fill now |
| `set_stop_loss` | Puts a stop under the whole of a position, or moves one; held by the exchange |
| `cancel_order` | By exchange order id, stops included |
| `close_position` | Reduce-only, crosses the spread, works even when halted |
| `get_recent_decisions` | The agent's own recent actions and reasons, after a restart |

A blocked order comes back as a tool **error** with the specific reason
(`BLOCKED (POSITION_TOO_LARGE): Would put BTC at $61,400, over the $25,000 cap`),
so the agent can correct itself rather than retry the same rejected order. There
is deliberately **no tool that changes the limits.**

Orders are never true market orders — `place_order` without a price becomes a
marketable limit that crosses the spread by a small buffer, so a thin book can't
fill an agent at an unbounded price.

### Stop-losses

An agent that says "I'll get out below 2,630" is only as good as its next
wake-up. A stop-loss turns that into an order **the exchange holds and
executes** while the agent is asleep: a reduce-only stop-market trigger that
closes the whole position at market once the price reaches it.

- `set_stop_loss` sizes the stop to the entire current position and replaces
  any stop already on that symbol — the new one goes on before the old one
  comes off, so the position is never bare in between. It refuses a trigger on
  the wrong side of the market, which would fire at once.
- `place_order` with `stopLoss` protects the entry in the same call. An order
  that fills now gets a stop under the whole position straight after; if that
  stop fails, the fill still stands and the agent is told plainly that the
  position is unprotected. A **resting** order carries its stop with it, and
  the exchange places it for each part as it fills — so an entry that waits on
  the book at the cheaper maker fee is never bare once it fills.
- `close_position` takes the stop off with the position.
- **`REINS_REQUIRE_STOP_LOSS=true`** makes it a limit rather than a habit: the
  risk engine refuses any order that adds risk without its own `stopLoss`, and
  anything that adds risk while a position lacks a stop covering all of it
  (`NO_STOP_LOSS`). Reducing risk is never blocked.

On the wire a standalone stop is the trigger order Hyperliquid's Python SDK
signs in its `tpsl` test vector, and `signing.test.ts` reproduces that vector
byte for byte on both networks. A resting order and its stop go out together in
the `normalTpsl` grouping, as the SDK's `basic_tpsl` example sends them. The
stop's worst fill price sits 5% past the trigger — the SDK's own default
slippage — because a stop that refuses to fill protects nothing. Paper mode
fires stops from the same one-minute candles as resting orders, in the order the
market reached them; a stop attached to a fill found in a past candle watches
that same minute too, since which came first cannot be told from a candle.
Both kinds, and moving a stop, were accepted by mainnet from a funded account
in `live-check --trade` on 2026-09-21.

### Running it

```bash
npx @r2rlabs/reins init         # from a clone: npm run build && node dist/bin/cli.js init
```

`init` adds a **paper-mode** `reins` server to `./.mcp.json` (keeping any other
servers there) with the limits below: $5,000 max position, $500 daily loss,
BTC and ETH, and absolute paths for the decision log and paper account. Change
any of them with flags (`--symbols SOL,BTC --max-position 2500`), write
elsewhere with `--file`, or `--print` the entry instead. It never writes live
mode or a key, and refuses to replace an existing `reins` entry without
`--force`. `reins init --help` lists everything.

Reins charges a builder fee of **2 bp on live mainnet orders**, paid to
`REINS_BUILDER_ADDRESS` in `src/builder-fee.ts`. `init` says so when it runs,
and paper results include the fee so they match what live would cost. Before
live trading starts, the account approves the fee once from its own wallet
(`npx @r2rlabs/reins approve-builder`); until it has, the server refuses to
start in live mode and says how to approve. Testnet orders carry no fee.

### Checking it against the real exchange

Unit tests prove Reins signs what Hyperliquid's own SDK signs. They cannot
prove Hyperliquid accepts it. `reins live-check` does, on a real account:

```bash
REINS_ACCOUNT_ADDRESS=0x… npx @r2rlabs/reins live-check             # reads only, free
REINS_ACCOUNT_ADDRESS=0x… REINS_PRIVATE_KEY=0x… \
  npx @r2rlabs/reins live-check --trade --size-usd 12               # a few cents in fees
```

The reads check the account, the market, open orders and whether the account
has approved Reins' builder fee. With `--trade` it then walks the whole order
path with the smallest position the venue allows: a post-only order with a stop
attached, a cancel, a market entry, a stop placed and moved, the position
closed, and a sweep for anything left open. It stops at the first answer that
is not what Reins expects and prints what came back instead, so a failure names
the step rather than leaving you to guess. The test size is capped at $100, and
the resting order sits 3% away so it cannot fill while the check runs. With the
position open it also re-reads the account value, which catches equity read
wrongly for the account's mode. All 12 steps have passed on mainnet, from a
Manual account and from a Unified one.

### Usage

```bash
npx @r2rlabs/reins stats              # the last 30 days
npx @r2rlabs/reins stats --days 365 --json
```

Hyperliquid publishes every fill that carried a builder code in a daily file,
once the UTC day has closed. `stats` reads those files for Reins' builder
address and reports accounts (and new ones by day), trades, volume, fees
earned, maker fills, stops fired and the busiest markets. It also prints the
fees Hyperliquid has credited the builder in total, which comes from the API
rather than the files and is never late: a day's file can arrive a day or more
after the day closes. Reins itself sends nothing home, so this is live mainnet
trading only: paper runs leave no trace.

### Approving the fee

```bash
npx @r2rlabs/reins approve-builder              # from a clone: node dist/bin/cli.js approve-builder
npx @r2rlabs/reins approve-builder --check 0x…  # what a wallet has approved
```

The approval must be signed by the user's **main wallet**, so Reins never asks
for that key. `approve-builder` serves a page on `127.0.0.1` behind a random
path, the user's browser wallet (MetaMask or similar) signs the EIP-712
approval there, and only the signature comes back. Reins checks that it names
Reins' builder, the requested rate and network, a fresh nonce, and that it
recovers to the wallet that says it signed — then sends it to Hyperliquid and
reads the approval back with `maxBuilderFee`. Signing costs no gas.
`--max-fee` approves a higher ceiling than the default 2 bp; `--network
testnet` approves on testnet.

The signing was checked against Hyperliquid itself: a throwaway key's
approval, sent to testnet, was refused only for having no deposit, with the
error naming exactly the throwaway address — so the signature recovered
correctly, including when signed at Arbitrum's chain id as a browser wallet
would.

Or point an MCP client at it by hand:

```json
{
  "mcpServers": {
    "reins": {
      "command": "node",
      "args": ["/absolute/path/to/hyperliquid-agent/dist/bin/serve.js"],
      "env": {
        "REINS_NETWORK": "testnet",
        "REINS_SYMBOLS": "BTC,ETH",
        "REINS_MAX_POSITION_USD": "5000",
        "REINS_DAILY_LOSS_USD": "500",
        "REINS_MAX_LEVERAGE": "3",
        "REINS_MAX_ORDERS_PER_MIN": "12",
        "REINS_LOG_FILE": "./decisions.jsonl"
      }
    }
  }
}
```

`REINS_SYMBOLS`, `REINS_MAX_POSITION_USD` and `REINS_DAILY_LOSS_USD` are
required — there is no default for "how much of your money may this thing lose".

Until a signer is wired the server runs **read-only**: reads work, trading throws.
It says so on stderr at startup.

## On signing

L1 actions are msgpack-hashed into a "phantom agent" and signed EIP-712.
Hyperliquid's docs warn against implementing this by hand, and the warning is
well earned: **msgpack preserves map key order, so key order is part of the
hash.** Reorder two fields in an action and the signature silently becomes
invalid, with nothing in the rejection pointing at ordering as the cause.

`src/signing.ts` implements the scheme as a set of pure functions holding no key
material, which is what makes it checkable. `src/signing.test.ts` verifies it
against the **published test vectors from the Python SDK's own
`signing_test.py`** — same key, same action, same nonce, and byte-identical
`r`, `s` and `v` on both mainnet and testnet. That is a stronger guarantee than
"one order went through once."

The things that are easy to get wrong, all covered by tests:

- msgpack key order is part of the hash — there is a test that reordering two
  keys changes it
- the nonce is 8 big-endian bytes appended to the packed action
- a vault address adds a `0x01` marker plus 20 bytes; no vault adds `0x00`
- `source` is `"a"` on mainnet, `"b"` on testnet — the wrong one signs
  perfectly and the other network refuses it
- the EIP-712 domain is fixed at chainId **1337** with a zero verifying
  contract, regardless of what you are trading on

`r` and `s` are emitted as minimal hex with leading zeroes stripped, matching
the Python SDK exactly. This was confirmed end to end: a signed order sent to
testnet came back rejected on a **price-band rule**, which is order validation
and therefore only runs after authentication has already passed.

`PrivateKeySigner` never stores the key on the instance and overrides `toJSON`,
so signing authority cannot leak into a log line or a decision record.

## Usage

```ts
import { HyperliquidClient, RiskEngine } from "./src/index.js";

const client = new HyperliquidClient({
  network: "testnet",
  signer,
  builder: { address: "0xYOUR_BUILDER_ADDRESS", feeTenthsBps: 10 }, // 1 bp
});

const engine = new RiskEngine({
  maxPositionUsd: 25_000,
  maxLeverage: 5,
  dailyLossLimitUsd: 2_500,
  symbolAllowlist: ["BTC", "ETH"],
  maxOrdersPerMinute: 12,
});

const snapshot = await client.positionSnapshot();
const state = { ...snapshot, realizedPnlTodayUsd: todaysPnl };

const decision = engine.check({ symbol: "BTC", side: "buy", sizeUsd: 18_400 }, state);
if (!decision.allowed) throw new Error(decision.reason);

const outcome = await client.placeOrder({
  symbol: "BTC",
  side: "buy",
  size: 0.18,
  price: 102_000,
});
engine.recordOrder();
```

Construct it without a `signer` and the client is read-only: market data works,
`placeOrder` throws.

## Development

```bash
npm install
npm test
```

## Design

Product screens live in [`design/`](design/) and render as a canvas at the
Artifact linked in the project notes.

## Builder code facts, verified against Hyperliquid's docs

| | |
|---|---|
| Fee cap, perps | 0.1% of fill value |
| Fee cap, spot | 1% of fill value |
| Fee units | Tenths of a basis point — `f: 10` is 1 bp |
| Builder requirement | ≥100 USDC perps account value, `standard` account abstraction |
| User approval | `ApproveBuilderFee`, signed by the user's **main wallet**, not an API wallet |
| Approvals per user | 10 active at a time |
| Scope | Both sides of perps; sell side only on spot |
| Payout | Claimed through the normal referral reward process |

## Safety notes

- The agent gets a `get_limits` tool so it can see its constraints. It gets no
  tool that can change them.
- Reduce-only orders survive a halt. Closing risk is always permitted; opening it
  is not.
- Without a private key the server runs read-only — market data works, nothing
  can trade.
