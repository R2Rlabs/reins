# reins-client

Risk limits and an audit log around a Python trading bot on Hyperliquid.

Your bot decides what to trade. Reins decides what it is allowed to send: a cap
per position, leverage, a daily loss limit that halts trading, an allowlist, a
rate limit, a required stop-loss, and a cap on what one trade may lose. The
limits run in a separate process, so no prompt, bug or bad hour gets around
them, and every attempt — including the refusals — is written to an append-only
log.

```bash
pip install reins-client
```

Point it at a running Reins server:

```bash
npx @r2rlabs/reins init          # writes a paper-trading config
npx @r2rlabs/reins http          # prints the URL and token
```

## Using it

```python
from reins import Reins, Refused

reins = Reins.from_env()          # REINS_URL, REINS_HTTP_TOKEN

book = reins.book("BTC")
entry = book["bestBid"]
stop = round(entry * 0.99, 1)

try:
    order = reins.place_order(
        symbol="BTC",
        side="buy",
        size_usd=Reins.size_for_risk(entry, stop, risk_usd=25),
        price=entry,
        stop_loss=stop,
        reason="range low held on the hourly",
        tif="Alo",                # post-only: maker fees, no chasing
    )
except Refused as refusal:
    print(refusal.code, refusal.reason)
```

A refusal is not an error in your code — it is Reins doing its job. It arrives
as `Refused` with the code, so a bot can branch on it:

`POSITION_TOO_LARGE`, `LEVERAGE_TOO_HIGH`, `HALTED_DAILY_LOSS`,
`TRADE_RISK_TOO_LARGE`, `NO_STOP_LOSS`, `SYMBOL_NOT_ALLOWED`, `RATE_LIMITED`,
`INVALID_ORDER`.

### Sizing from the stop

`Reins.size_for_risk(entry, stop, risk_usd)` is the same arithmetic the risk
engine checks: size = risk ÷ (distance to the stop, as a fraction of entry).
Size this way and a wider stop gives you a smaller position instead of a bigger
loss — which is what keeps orders inside `TRADE_RISK_TOO_LARGE`.

### Everything else

```python
reins.health()                    # paper or live — check before you trade
reins.limits()                    # the limits in force, and what is left of them today
reins.positions()                 # equity, open positions, anything without a stop
reins.candles("ETH", interval="1h", count=50)
reins.set_stop_loss(symbol="BTC", trigger_price=82000, reason="under the low")
reins.cancel_order(symbol="BTC", order_id=2, reason="setup gone")
reins.close_position(symbol="BTC", reason="target hit")
reins.decisions(limit=20)         # the log: tried, refused, filled
```

`reason` is required on anything that changes a position. An order nobody
explained is the one you cannot account for afterwards.

## Paper first

A Reins server in paper mode uses live Hyperliquid prices with simulated fills,
the same limits and the same fees, and signs nothing. Point your bot at it and
you can watch a week of its decisions before any money is involved. Paper is
free; live trading pays a 2 basis point Hyperliquid builder fee, and there is no
subscription.

## Checked against the real thing

`tests/` has 17 unit tests against a stub server (no network), plus `e2e.py`,
which drives a real server:

```bash
python -m unittest discover -s tests            # unit
node dist/bin/cli.js http --port 8799           # in the Reins repo, paper mode
REINS_URL=http://127.0.0.1:8799 REINS_HTTP_TOKEN=... python tests/e2e.py
```

The end-to-end run places a real paper order with an attached stop, then
deliberately breaches three limits and checks each refusal comes back with the
right code and lands in the log.

No dependencies: the client is one stdlib-only file, so it can be vendored if
you would rather not add a package.

MIT licensed. Source: https://github.com/R2Rlabs/reins
