# Reins demo agent

Claude trading Hyperliquid perps **on paper**, through the Reins MCP server,
with every decision it makes written to a log you can publish.

It exists to answer the question every developer you talk to will ask: *what
does an agent actually do behind these limits?* The answer is the decision log
— real reasoning, real refusals, in the agent's own words.

## Run it

```bash
npm run build                        # the demo drives the built server
npm run demo -- --scripted           # free wiring check: no API key, no spend
```

When that works, with your own key:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run demo -- --once     # one cycle; prints what it cost
ANTHROPIC_API_KEY=sk-ant-... npm run demo               # a cycle every 30 min until the budget runs out
npm run demo:report                                     # a postable summary so far
```

Each cycle is a fresh, bounded conversation: the agent recalls earlier cycles
with `get_recent_decisions`, checks its limits, positions and the book, and
decides whether to act. Doing nothing is a valid decision.

## The account it trades

| | |
|---|---|
| Mode | Paper — live **mainnet** prices, simulated fills, no real money |
| Opening balance | $10,000 |
| Symbols | BTC, ETH |
| Max position | $2,500 per symbol |
| Daily loss limit | $300 |
| Max leverage | 3x |
| Fees | Hyperliquid base tier plus a 1 bp builder fee, so the curve pays what a real user would |

Edit `SERVER` at the top of `agent.ts` to change any of these.

The demo **builds the server's environment from scratch** rather than
inheriting yours. Whatever is in your shell — a `REINS_MODE=live`, a
`REINS_PRIVATE_KEY` — never reaches the server it talks to. There is a test for
exactly that.

## What it costs

**Claude API spend is capped.** `--budget-usd` (default **$5**) is a hard limit
checked before every call, persisted in `demo-data/spend.json`, and cumulative
across restarts — a demo that runs for weeks gets restarted, and a cap that
reset each time would not be a cap. It can overshoot by at most one call.

Rough expectations, **estimated, not measured** — there was no API key to
measure with when this was written:

- A cycle is typically 4–8 model calls. On `claude-opus-5` at the default
  `high` effort, expect somewhere around **$0.25–$0.50 per cycle**, mostly
  output and thinking tokens. Later cycles cost a little more as the recalled
  history grows.
- Every 30 minutes that is roughly **$12–$25 a day**, so the default $5 budget
  lasts a few hours. That is deliberate: run `--once`, read the real cost it
  prints, then choose.

To stretch a budget, in rough order of effect:

1. **`--interval-minutes 120`** — the agent does not need to look every half hour.
2. **`--effort medium`** — Anthropic's own guidance calls `low` and `medium`
   "unusually effective" on Opus 5 and the primary cost lever.
3. **`--model claude-sonnet-5`** — about 2.5x cheaper per token.

Those are your trade-offs to make; the defaults are the most capable settings.

## Honesty, since this is for publishing

- **The agent is never told to test its limits.** Its instructions are a
  normal trading mandate and a description of how its tools behave. Any
  refusal in the log happened on its own, which is the only reason the log is
  worth posting. A test fails if the prompt ever starts asking it to probe.
- **Scripted runs cannot leak into the real log.** They write to
  `demo-data/scripted/` and every reason they record starts with `[scripted]`.
- **Reasons are testimony, not proof.** The log records what the agent *said*
  drove each decision. That is useful, and it is not evidence of what actually
  did.
- **Paper flatters.** Latency, market impact and funding are not simulated, so
  treat the paper result as an upper bound. The report says "paper" in plain
  words; keep it that way when you post.

## Files

| | |
|---|---|
| `agent.ts` | The command: starts the server, runs cycles, enforces the budget |
| `cycle.ts` | One decision cycle — the agent loop and the system prompt |
| `lib.ts` | Cost estimates, the spending cap, MCP↔Claude plumbing, the report |
| `scripted.ts` | The free stand-in for Claude used by `--scripted` |
| `report.ts` | `npm run demo:report` |
| `demo.test.ts` | Tests for all of the above |

Runs are written to `demo-data/` (gitignored): `decisions.jsonl`,
`paper-account.json`, `spend.json`.
