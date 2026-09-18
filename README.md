# Leash

An execution layer for trading agents on Hyperliquid. Position limits, daily loss
caps and a kill switch enforced **outside the model**, not in the prompt.

Leash is not an exchange. It holds no liquidity, custodies no funds and matches no
orders — Hyperliquid does all three. Leash sits in front of it, checks every order
an agent wants to place against limits the agent cannot change, and routes what
survives. Revenue comes from Hyperliquid builder codes on the flow it routes.

> Name is a placeholder.

## Why this exists

Several open-source Hyperliquid MCP servers already exist. They are thin API
wrappers: you hand them a private key and hope the model behaves. The gap is
everything around that — the limits, the sandbox, the audit trail. That is what
this repo is.

## Status

Early, but real. 153 tests, no network calls in any of them.

| Module | What it does |
|---|---|
| `src/risk.ts` | The risk engine — position cap, leverage cap, daily loss halt, allowlist, rate limit |
| `src/client.ts` | Hyperliquid REST client — orders, cancels, book, fills, account state, builder code |
| `src/mcp-server.ts` | The agent-facing tools, each risk-checked and logged before anything is sent |
| `src/paper.ts` | Paper trading — live prices, simulated fills. See below |
| `src/paper-store.ts` | Persists a paper run across restarts |
| `src/trading-client.ts` | The interface live and paper both satisfy |
| `src/decision-log.ts` | Append-only record of every attempt and its stated reason |
| `src/decision-log-file.ts` | JSON Lines log on disk |
| `src/bin/serve.ts` | stdio entry point |
| `src/format.ts` | Price and size formatting to Hyperliquid's tick and lot rules |
| `src/signing.ts` | L1 action signing, verified against the Python SDK's vectors |
| `src/private-key-signer.ts` | A Signer backed by a private key |
| `src/signer.ts` | The Signer interface plus a stub. See "On signing" below |
| `src/mock-transport.ts` | In-memory API stand-in, so agents can be tested without a network |

All of it works end to end. Going live is now a matter of funding an account and
setting `LEASH_MODE=live` with a key.

### Going live

```bash
LEASH_MODE=live
LEASH_NETWORK=testnet          # mainnet spends real money
LEASH_PRIVATE_KEY=0x...        # omit to stay read-only
```

Defaults are deliberately safe: `LEASH_MODE` is `paper` and `LEASH_NETWORK` is
`testnet`, so trading real funds takes two explicit changes rather than one
forgotten variable. Live mode without a key stays read-only instead of failing
at the first order, and mainnet prints a loud banner on startup.

The private key is only read in live mode — paper never signs anything, so it is
never handed the means to.

## The decision log

Every attempted action is appended to a log with the reason the agent gave for
it — **including the ones the risk limits refused.** That is the point. "The
agent tried to open six times its position cap at 3am, and here is what it said
it was doing" is the most useful thing this system can tell you, and it only
exists if refusals are written down.

`place_order` and `close_position` take a **required** `reason`. An optional
field gets omitted; a required one gets answered.

Records are JSON Lines — one self-contained object per line, appended, never
rewritten. Appends stay cheap as the file grows, a truncated write damages one
line instead of the file, and you can query it with ordinary tools:

```bash
jq -r 'select(.risk.allowed == false) | [.time, .risk.code, .reason] | @tsv' decisions.jsonl
```

Each record holds the stated reason, the request, the account context at the
time, the risk verdict, and the outcome. Set `LEASH_LOG_FILE` to persist it;
without it the log lives in memory and dies with the process.

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

`LEASH_MODE=paper` (the default) runs the same tools, the same risk engine and
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

### What it does not model

Each of these flatters the result, so they are listed rather than buried:

- **Latency** — fills are priced off the book as it was when the tool was called
- **Market impact** — your order never moves the price or removes liquidity
- **Funding payments** on perps
- **Book movement between polls** — a wick that would have filled a resting
  order is missed unless a tool happens to be called while it is happening

**Treat a paper equity curve as an upper bound on live performance, not an
estimate of it.**

### Running a paper account

```json
{
  "env": {
    "LEASH_MODE": "paper",
    "LEASH_PAPER_BALANCE": "10000",
    "LEASH_PAPER_FILE": "./paper-run.json"
  }
}
```

Without `LEASH_PAPER_FILE` the account lives in memory and is lost on restart.
Set it for anything you intend to run for more than one session — writes go to a
temp file and are renamed into place, so a crash cannot leave a half-written run
behind.

## The MCP server

Seven tools. Every one that can move money passes the risk engine first, and
every attempt is written to the decision log.

| Tool | Notes |
|---|---|
| `get_limits` | Limits, headroom per symbol, remaining loss budget, halted state |
| `get_positions` | Signed notional per symbol, account value, today's realised PnL |
| `get_book` | Best bid/ask, spread, nearest levels |
| `place_order` | **Sized in USD**, not asset units — the same unit as the limits |
| `cancel_order` | By exchange order id |
| `close_position` | Reduce-only, crosses the spread, works even when halted |
| `get_recent_decisions` | The agent's own recent actions and reasons, after a restart |

A blocked order comes back as a tool **error** with the specific reason
(`BLOCKED (POSITION_TOO_LARGE): Would put BTC at $61,400, over the $25,000 cap`),
so the agent can correct itself rather than retry the same rejected order. There
is deliberately **no tool that changes the limits.**

Orders are never true market orders — `place_order` without a price becomes a
marketable limit that crosses the spread by a small buffer, so a thin book can't
fill an agent at an unbounded price.

### Running it

```bash
npm run build
```

Then point an MCP client at it:

```json
{
  "mcpServers": {
    "leash": {
      "command": "node",
      "args": ["/absolute/path/to/hyperliquid-agent/dist/bin/serve.js"],
      "env": {
        "LEASH_NETWORK": "testnet",
        "LEASH_SYMBOLS": "BTC,ETH",
        "LEASH_MAX_POSITION_USD": "5000",
        "LEASH_DAILY_LOSS_USD": "500",
        "LEASH_MAX_LEVERAGE": "3",
        "LEASH_MAX_ORDERS_PER_MIN": "12",
        "LEASH_BUILDER_ADDRESS": "0xYOUR_BUILDER_ADDRESS",
        "LEASH_BUILDER_FEE_TENTHS_BPS": "10",
        "LEASH_LOG_FILE": "./decisions.jsonl"
      }
    }
  }
}
```

`LEASH_SYMBOLS`, `LEASH_MAX_POSITION_USD` and `LEASH_DAILY_LOSS_USD` are
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
