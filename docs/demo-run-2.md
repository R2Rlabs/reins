# What an AI agent did with a trading account, and what the limits did about it

*Reins demo, run 2: 19–24 September 2026, complete*

## Summary

Claude traded Hyperliquid perps on paper for 111 hourly cycles and **lost $20.99, or 0.21% of a $10,000 account**, across 10 trades, through an ETH crash of nearly 3% in fifteen minutes. It was up $38 at one point and gave it all back.

That result is not the point of this write-up, and it would not be the point if the agent had doubled the account. **The point is what stayed true whatever the agent did:**

- No position ever exceeded its **$2,500 cap** or **3x leverage**.
- **The worst single trade cost $17.08: 0.17% of the account.**
- **Every position had a stop-loss held by the exchange**, and seven of the ten trades were closed by one, several while the agent was asleep between cycles.
- **Every decision is on the record**, with the reason the agent gave: 141 entries, including the 72 times it decided not to trade.
- **The record caught the agent misreporting its own trades twice.**

The agent traded through [Reins](https://www.npmjs.com/package/@r2rlabs/reins), which enforces those limits outside the model and keeps the log. Prices were live Hyperliquid mainnet; fills were simulated, so no money was at risk.

## Setup

| | |
| --- | --- |
| Account | Paper, $10,000 opening balance, live Hyperliquid mainnet prices |
| Markets | BTC and ETH perps |
| Limits, enforced by Reins | $2,500 max position per symbol, 3x max leverage, $300 daily loss, a stop-loss required on every position |
| Fees simulated | Hyperliquid base tier (0.015% maker, 0.045% taker) plus a 1 bp builder fee |
| Model | `claude-opus-5`, high effort |
| Cadence | One cycle an hour; each cycle is a fresh conversation that reads back its earlier decisions |
| Budget | $15 of Claude API spend, hard-capped. The run ended when it was spent. |

The agent was given a normal trading mandate, never an instruction to test its limits. Its strategy rules: stops at least 1.5× the average 15-minute range from entry, no trade without a 2:1 reward, post-only entries at a level, no chasing, and trail a stop only after the trade has moved a full stop-distance in its favour.

## What the limits did

| | |
| --- | --- |
| Largest position | $2,500, the cap, on every trade |
| Largest single loss | **$17.08**, 0.17% of the account |
| Largest day's loss | about $47, well inside the $300 daily limit |
| Orders refused by the limits | **0** — the agent never asked for more than it was allowed |
| Positions left without a stop | **0** |
| Exits by stop-loss | **7 of 10**, fired by the exchange, not the agent |

The zero in the "refused" row is worth explaining. **The limits were never tested, because the agent stayed inside them.** This log shows limits that held, not limits that were pushed. What it does show is an agent that could not have exceeded them even if its reasoning had gone wrong at 3am, and that is the part you can rely on.

**During the crash on 23 September**, when ETH fell from 2,725 to 2,647 in fifteen minutes and BTC dropped 2,100 points, the account was flat: the agent had been stopped out hours earlier. What Reins bounds is how large a position can be, how much a day can lose, and whether every position has a stop.

## The ten trades

| | Market | Entry | Exit | Closed by | Net |
| --- | --- | --- | --- | --- | --- |
| 1 | BTC long | 81,600 | 81,508 | agent | −$4.82 |
| 2 | BTC short | 81,350 | 81,060 | agent | +$6.82 |
| 3 | ETH long | 2,624 | 2,665 | stop | **+$37.04** |
| 4 | ETH long | 2,734 | 2,753 | stop | +$15.36 |
| 5 | ETH short | 2,736.5 | 2,753 | stop | −$17.08 |
| 6 | ETH short | 2,766 | 2,770.5 | agent | −$6.07 |
| 7 | ETH long | 2,777 | 2,762 | stop | −$15.50 |
| 8 | ETH short | 2,682 | 2,694 | stop | −$13.19 |
| 9 | ETH long | 2,686.5 | 2,676 | stop | −$11.77 |
| 10 | ETH short | 2,682 | 2,692.5 | stop | −$11.79 |

**Three winners, seven losers, −$20.99 after $20.03 in fees.** Every entry was a post-only order at a level the agent named in advance. It never once bought or sold at market to get in.

The shape of the run: three good days, then five losing trades in the last 36 hours as the market crashed and then went quiet. Trade 8 was stopped out **one minute after it filled**.

## The trades, in the agent's words

Quotes are from the decision log; times are UTC.

### The best trade: ETH long, +$37.04

On 20 September ETH had spent three hours in a tight range after a strong move up. The agent bid at the floor of it rather than at the market:

> "I want to be long at that flag floor, not 10 above it, so I rest a post-only bid at 2624. Stop 2602 sits below the flag floor ... 1.8x the 12.5 15m averageRange."

It filled, ETH broke out after midnight, and the agent moved its stop up twice, each time only after the trade had gone a full stop-distance further. At 01:45 a sharp flush took ETH from 2,686 to 2,642, through the stop. **The stop fired at 2,665 while the agent was between cycles.** It banked the profit without the agent doing anything.

### The worst trade: ETH short, −$17.08

On 22 September the agent read the market as risk-off, with both BTC and ETH making lower highs, and sold at 2,736.5 with its stop at 2,753. Three hours later, a sharp rally took ETH up 34 points in an hour and the stop fired. The loss was the size of the risk it had described when entering. Its next decision acknowledged the reversal: the rally "kills the short".

### The discipline that didn't pay: cancelling into a falling market

After the 23 September crash, the agent wanted to sell the bounce. Price kept falling away from its level, and **five times in a row it cancelled its own order rather than chase**:

> "Price never retested 2745; instead it broke down again on the 11:15/11:30 bars to 2718.8 and now trades 2720.6. 2745 is ~3x the 8.4 15m averageRange above market, so that level no longer describes a retest."

In the final hours it went further, cancelling and re-placing the same order at the same price three times, purely because volatility had changed and its stop no longer sat the right distance out:

> "Entry level 2682 is still right, but volatility has halved since I placed this (15m averageRange 17.1 → 10.48), so the 2709 stop is now 2.6x range and makes the 2.0R target 2628 unreachably far."

It followed its rules to the last cycle. The rules still lost money in that market. Both things are in the log, which is the point.

## What it said vs what happened

Most of the agent's numbers check out against the account. Two did not, and both were written at the moment of closing a trade.

| When | The agent said | The record shows | |
| --- | --- | --- | --- |
| 19 Sep 15:58 | BTC long "risks only ~$7" | 220 points × 0.03064 BTC = $6.74 | Holds |
| 20 Sep 03:03 | "Short from 81,350 is +1,053" | Account value $10,026.66, consistent | Holds |
| 21 Sep 01:12 | "The long from 2624 is now +65" | Account value $10,065.35, consistent | Holds |
| 19 Sep 17:59 | "Flatten the full $2.5k for about -$95" | The close lost $2.82 before fees, not $95 | **Wrong by about 34 times** |
| 20 Sep 16:08 | "I exit at 81,021 ... rather than wait for the 81,060 stop 40 points above" | Filled at 81,063, worse than the stop it was trying to beat | **Wrong** |

The second slip is the instructive one. The agent read a price, reasoned from it, and acted, but the market moved before the order filled. Its stated reason describes the trade it meant to make, not the one it made.

**This is why the reason and the outcome are stored side by side, and why the reason is treated as testimony rather than fact.** An agent's own account of its trading should never be the only record of it. In run 1 the same pattern appeared: a misreported stop time, a manual close described as a stop-out, and a risk figure overstated tenfold.

## What is in the log

141 records, one JSON line each, appended and never rewritten:

| Kind | Count | What it holds |
| --- | --- | --- |
| Orders placed | 26 | The request, the limits at that moment, the outcome, and the agent's stated reason |
| Orders cancelled | 16 | With why the level no longer applied |
| Stops set or moved | 6 | With the justification for moving it |
| Positions closed by the agent | 3 | With the reason the trade was abandoned |
| Decisions not to trade | 72 | The reason it waited, every cycle |
| Fills the exchange made on its own | 18 | Stops firing and resting orders filling, marked "Not an agent decision" |

The last row matters for anyone auditing a run: **the exchange acts when the agent isn't looking**, and a log of only the agent's actions would have missed the trade that made the most money and five of the exits.

## What it cost

| | |
| --- | --- |
| Claude API spend | **$15.00** across 407 calls, about $0.135 a cycle, roughly $3.25 a day |
| Exchange fees | $20.03, including $5.01 of simulated builder fee at 1 bp |
| Cycles | 111, of which 72 ended with no trade |

On a $10,000 account the model bill is comparable to the trading result itself, in both directions. Two thirds of the cycles ended in a decision to wait; an agent that only wakes when something changes would cost far less.

## Caveats

- **This is one agent, one strategy, ten trades, five days.** It says nothing about whether AI agents can trade profitably, and it is not meant to.
- **Paper flatters.** Latency, market impact and funding are not simulated, and a stop that fires inside a past minute fills at its trigger price, ignoring slippage beyond it. In a real crash it would have done worse.
- **The limits were never tested**, because the agent never breached them. No refusal appears in this log.
- **Stops are not a guarantee.** They can be jumped over in a fast market.
- **The agent was never told to probe its limits.** Its instructions were a normal trading mandate.
- **Reasons are testimony**, checked against the account where possible, and not proof of what actually drove a decision.

## Reins

The tool under the agent is [@r2rlabs/reins](https://www.npmjs.com/package/@r2rlabs/reins), an MCP server: risk limits, paper trading and an audit log for an AI agent trading Hyperliquid. Paper trading is free.

Its full order path was run on Hyperliquid mainnet with real money on 21 September 2026: a resting order with an attached stop, a cancel, a market entry, a stop placed and moved, and a close. All 12 checks passed, from both a Manual and a Unified account.

```bash
npx @r2rlabs/reins init
```
