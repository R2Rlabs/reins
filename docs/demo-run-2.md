# Reins demo: an AI agent trading Hyperliquid on paper, run 2

*Interim report, 21 September 2026*

## Summary

In its first 46 hourly cycles, Claude traded Hyperliquid perps on paper and stood at **+$39.04 (+0.39%) after fees**, where run 1 lost $27.00. It made three round trips: two winners and one small loser. One ETH long, closed by its own trailed stop, earned almost all of the profit.

The agent traded through [Reins](https://www.npmjs.com/package/@r2rlabs/reins), an execution layer that enforces position, leverage and daily-loss limits outside the model and logs every decision with the reason the agent gave. Prices were live Hyperliquid mainnet; fills were simulated, so no money was at risk.

This is an interim report; the run is still going, and a final update will follow when its budget runs out. Two things to keep in mind throughout. Three trades is an anecdote, not a track record. And the agent's reasons are testimony: where this write-up quotes them, it also says what the account actually shows.

## Setup

Run 2 started on 19 September 2026 at 14:58 UTC and is still going. This covers everything up to 21 September 11:18 UTC.

| | |
| --- | --- |
| Account | Paper, $10,000 opening balance, live Hyperliquid mainnet prices |
| Markets | BTC and ETH perps |
| Limits, enforced by Reins | $2,500 max position per symbol, 3x max leverage, $300 daily loss, a stop-loss required on every position |
| Fees simulated | Hyperliquid base tier (0.015% maker, 0.045% taker) plus a 1 bp builder fee |
| Model | `claude-opus-5`, high effort |
| Cadence | One cycle an hour; each cycle is a fresh conversation that reads back its earlier decisions |
| Budget | $15 of Claude API spend, hard-capped |

The agent was given a normal trading mandate, never an instruction to test its limits. After run 1, its strategy rules were rewritten:

- **Stops from volatility**: at least 1.5 times the average 15-minute candle range away from entry.
- **2:1 or better**: no trade unless the target is at least twice as far as the stop.
- **Maker entries**: post-only limit orders at a level, not market orders.
- **No chasing**: if price has left the level, wait or move the order; never buy the move.
- **Trail only after progress**: move a stop only once the trade has gone at least one stop-distance further in its favour.
- **Cancel stale orders** once the level they were placed at no longer matters.

## Results

Run 2 made $39.04 on three round trips where run 1 lost $27.00 on five, and paid a third less in fees.

| | Run 1 | Run 2 |
| --- | --- | --- |
| Dates (UTC) | 18–19 Sep | 19–21 Sep, still running |
| Cycles | 37, every 30 min | 46, hourly |
| Round trips | 5 | 3 |
| Winners | 0 | 2 |
| Net result after fees | −$27.00 | **+$39.04 (+0.39%)** |
| Fees paid | $9.89 | $6.02 |
| Cycles that held | — | 33 of 46 |
| Orders refused by the limits | 0 | 0 |
| Claude API spend | $5.02 | $5.79 |

Run 2's three trades:

| Trade | Entry | Exit | Held | Net after fees |
| --- | --- | --- | --- | --- |
| BTC long | 81,600, resting bid filled 19 Sep 16:04 | 81,508, closed by the agent | 2 h | −$4.82 |
| BTC short | 81,350, resting offer filled 19 Sep 23:33 | 81,063, closed by the agent | 16.5 h | +$6.82 |
| ETH long | 2,624, resting bid filled 20 Sep 21:02 | 2,665, trailed stop fired 21 Sep 01:51 | 5 h | **+$37.04** |

Each position was $2,500, the cap. At 11:18 UTC on 21 September the account was flat, with a post-only ETH bid resting at 2,706 and its stop at 2,684.

## The trades, in the agent's words

Every entry was a resting order at a level the agent named in advance, and every position had a stop from the moment it filled. Quotes are from the decision log; times are UTC.

### BTC long: a breakout retest that failed (−$4.82)

At 15:58 on 19 September BTC had broken the day's 81,800 high. Rather than buy the spike, the agent bid below it:

> "I want the breakout retest rather than the spike: maker bid at 81,600 ... Stop 81,380 is below the 81,418 pre-breakout base and 1.7x the 15m averageRange."

The bid filled at 16:04. An hour later the trade was up 283 points, more than its 220-point stop distance, so the agent trailed the stop once, to 81,450. By 17:59 price had slipped back under the old high and broken the reaction low. The agent closed by hand at 81,508: "The breakout-retest thesis is dead."

### BTC short: right direction, most of the gain given back (+$6.82)

At 21:00 the agent saw the 81,341–81,351 floor break on four times the previous hour's volume. It again declined to chase and rested an offer at the broken level: "Rather than chase 150 below the break I rest a maker offer at 81,350, exactly the broken shelf."

Price came back up to it at 23:33 and filled the order. By 03:03 the short was up 1,053 points, about $32, and the agent trailed its stop to 81,060. BTC then went sideways between 80,170 and 80,650 for 13 hours. Each hour the agent declined to move the stop again, citing its own rule: "the trade has not advanced enough to justify moving the stop."

At 16:08 on 20 September BTC climbed back through the 81,000 shelf. The agent closed by hand at 81,063, for +$8.82 before fees.

### ETH long: the trade that made the run (+$37.04)

At 19:10 ETH had spent three hours in a tight flag after a strong move up. The agent bid at the floor of the flag:

> "I want to be long at that flag floor, not 10 above it, so I rest a post-only bid at 2624. Stop 2602 sits below the flag floor ... 1.8x the 12.5 15m averageRange."

The bid filled at 21:02. ETH broke out after midnight, and the agent trailed twice, each time only after the trade had moved a full stop-distance further:

- 00:12, stop to 2,630: "Long from 2624 is now +30.5 ... more than the 22-point original stop distance, so I trail once."
- 01:12, stop to 2,665: "price has advanced 35 points since I last trailed ... so a second trail is earned."

At 01:45 a sharp flush took ETH from 2,686 to 2,642, through the stop. It fired at 2,665 at 01:51, locking in +$39.06 before fees. The agent was not awake for it; the exchange-side stop did the work.

### Since then: waiting for a pullback

The agent has not traded since. It has moved its ETH bid up three times as the uptrend left each level behind, to 2,648, 2,685 and now 2,706. It cancelled each stale order with a reason, and it has not once bought at market.

## Did it follow its rules?

Mostly yes. There was one small breach, and one rule, followed to the letter, cost it most of a winning trade.

| Rule | What the log shows |
| --- | --- |
| Stops from volatility (≥ 1.5× the 15-minute range) | Kept: 1.7×, 1.5× and 1.8× on the three entries |
| 2:1 or better | **Broken once**: the BTC short was entered for "~1.9R", by the agent's own figure |
| Maker entries | Kept: all three entries were post-only resting orders |
| No chasing | Kept: 14 holds turned down an entry away from its level, and it never entered at market |
| Trail only after progress | Kept: each of the four stop moves was justified by a full stop-distance of progress |
| Cancel stale orders | Kept: five cancels, each with the level it had outlived |
| Stop on every position | Kept, and enforced by Reins regardless |

**Where the rules cost money.** The BTC short was worth about $32 at 03:03, and the agent trailed its stop to 81,060, locking in 290 points. Then BTC ranged for 13 hours without making another full stop-distance of progress. So the stop never moved again, and the short closed for $8.82 gross. In run 1 the opposite rule, trailing tightly, got stopped out within minutes. Neither extreme is obviously right; the log makes the trade-off visible.

**Holding was most of the job.** 33 of 46 cycles ended with no trade, each with a one-line reason: 14 turned down a worse entry, 18 sat in an open position and left the stop alone, and 1 found no setup worth taking. The limits never came into play: no order was refused, because the agent never asked for more than its $2,500 cap.

## What it said vs what happened

Most of the agent's numbers check out against the account, but two claims made at the moment of closing a trade did not. That is why Reins logs the reason and the outcome side by side, and treats the reason as testimony.

| When | The agent said | The record shows | |
| --- | --- | --- | --- |
| 19 Sep 15:58 | BTC long "risks only ~$7" | 220 points × 0.03064 BTC = $6.74 | Holds |
| 19 Sep 16:59 | "Long from 81,600 is +283" | Account value $10,007.91, consistent with +283 less the entry fee | Holds |
| 20 Sep 03:03 | "Short from 81,350 is +1,053" | Account value $10,026.66, consistent | Holds |
| 20 Sep 19:10 | ETH "dollar risk is about $21" | 22 points × 0.9527 ETH = $20.96 | Holds |
| 21 Sep 01:12 | "The long from 2624 is now +65" | Account value $10,065.35, consistent | Holds |
| 19 Sep 17:59 | "Flatten the full $2.5k for about -$95" | The close lost $2.82 before fees, not $95 | **Wrong by about 34 times** |
| 20 Sep 16:08 | "I exit at 81,021 ... rather than wait for the 81,060 stop 40 points above" | Filled at 81,063, worse than the stop it was trying to beat | **Wrong** |

The second slip is the more telling one. The agent read a price, reasoned from it, and acted, but the market had moved by the time the order filled. Its reason describes the trade it meant to make, not the one it made.

Run 1 showed the same pattern. The agent misreported the time a stop fired, described a close it made by hand as a stop-out, and once overstated its own risk by ten times. None of these was dangerous here, because the limits never depended on the agent's arithmetic. They are the reason an agent's own account of its trading should never be the only record.

## What the runs found in Reins

The two runs turned up eight bugs, all now fixed and covered by tests. One of them would have affected real money.

| Found in | Bug | Effect | Fix |
| --- | --- | --- | --- |
| Run 2 | `close_position` sized a close from the position's dollar value divided by the order's limit price | Closing a short left about 0.2% open (0.00006 of 0.03073 BTC) while reporting "closed". **This would have happened on a live account too.** | Closes the exact size held, and says so if anything is left |
| Run 2 | Fills the exchange made on its own were not logged | The ETH stop-out, the run's best trade, was missing from the decision log | Reins now appends each unseen fill as an `exchange_fill` record marked "Not an agent decision" |
| Run 2 | The report counted only orders that filled immediately | It said "2 filled"; the truth was 3 entries filled while resting, plus 2 stops | Counts resting fills and fired stops |
| Run 1 | Post-only orders that would rest were cancelled | Maker entries were impossible on paper | Rest as they do on Hyperliquid |
| Run 1 | Resting orders were checked only against the book at each poll | A bid that price traded through between polls never filled, and the agent later cancelled it | Checks one-minute candles between polls |
| Run 1 | An already-filled order could be cancelled | The agent was told a filled order was cancelled | Refused, as the exchange does |
| Run 1 | A reduce-only order could overfill | A resting close could flip a position | Capped at the size left |
| Run 1 | A cycle with no trade left no record | Most of the agent's decisions were invisible | Each hold is logged with its reason |

The fixes ship in [@r2rlabs/reins 0.1.1](https://www.npmjs.com/package/@r2rlabs/reins). When run 2's server was updated, it wrote the five missing fills into its own log, each exactly once.

Separately from the demo, Reins' full order path was run on Hyperliquid mainnet with real money on 21 September: a resting order with an attached stop, a cancel, a market entry, a stop placed and moved, and a close. All 12 checks passed, from both a Manual and a Unified account, and every fill paid the builder fee.

## What it cost

The Claude API bill was $5.79 for 46 cycles, about $0.13 a cycle or $3 a day, which is 15% of the $39.04 the account made.

| | Run 2 |
| --- | --- |
| Claude API spend | $5.79 across 164 model calls (estimated from token counts) |
| Per cycle | $0.13; one that trades costs up to $0.22, one that holds about $0.12 |
| Exchange fees | $6.02, including $1.50 of simulated builder fee at 1 bp |
| Fees as a share of gross profit | 13% (run 1: $9.89 of fees on top of trades that lost $17.11) |

On a $10,000 account the model bill is not small next to the trading. 18 of run 2's 46 cycles were spent watching an open position whose stop was already set; an agent that only wakes when something changes would cost much less. That is worth knowing before running any agent against real money.

## Caveats

Read the +0.39% as evidence that the agent behaved sensibly, not that it has an edge.

- **Three trades are not a sample.** One ETH trade made 95% of the profit; without it, run 2 was roughly flat.
- **Paper flatters.** Latency, market impact and funding are not simulated, and a stop that fires inside a past minute fills at its trigger price, ignoring any slippage beyond it. Treat the result as an upper bound.
- **The limits were never tested.** No order was refused, because the agent never asked for more than it was allowed. The log shows limits that held, not limits that were pushed.
- **The agent was never told to probe its limits.** Its instructions were a normal trading mandate, so any refusal would have been its own doing.
- **Reasons are testimony.** Every quote here is what the agent said drove a decision, checked against the account where possible, and not proof of what did.

Run 2 is still running, with about $9 of its $15 budget left, roughly three more days of hourly cycles. The full decision log, every order, refusal, hold and exchange fill with its stated reason, is the source for everything above.
