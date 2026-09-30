# One agent, two servers: someone else's data, Reins' limits

Most Hyperliquid MCP servers are read-only, and deliberately so — they hold no
keys, so the worst a mistake costs is a wrong number. Reins is the other half:
it holds the ability to trade, and refuses anything that breaks a limit.

Put them side by side and an agent gets both, with neither server trusting the
other. Their tools answer *what is happening*. Ours decide *what may be sent*,
and write down every attempt.

This example pairs Reins with
[alekskram/hyperliquid-agent-gateway](https://github.com/alekskram/hyperliquid-agent-gateway),
a read-only gateway on PyPI. Any data server works the same way.

## Run it

```bash
npm run build
pip install hyperliquid-agent-gateway
node examples/paired-mcp/paired.mjs
```

No model and no API key: the script drives both servers directly, so it costs
nothing and shows exactly what an agent would see. Reins runs in paper mode, so
nothing is signed and no capital is at risk. `GATEWAY_PYTHON` can point at the
interpreter that has the gateway installed.

## What it prints

```
gateway  12 tools
reins    9 tools

quote    BTC 84294 / 84295, spread 0.12 bp
market   mark 84278, funding 0.13 bp/h, OI $3.02bn, max 40x

plan     buy $2000 at 83872.5, stop 83033.8 — risks about $20
order    resting #1, stop attached at 83033.8
refused  BLOCKED (TRADE_RISK_TOO_LARGE): Stopping out would lose $500, over the
         $50 allowed on one trade. Move the stop closer or send a smaller order.

log      3 records, 1 refused
  16:13:52  cancel_order  allowed                      end of the example
  16:13:51  place_order   REFUSED TRADE_RISK_TOO_LARGE deliberately more risk…
  16:13:47  place_order   allowed                      bid 84294 from the gateway…

Their server never saw a key. Ours never guessed a price.
```

Three things worth noticing in that output.

**The size came from their price and our limit.** The order is built to pass:
size = risk ÷ distance to the stop, which is the same arithmetic Reins checks.
A wider stop gives a smaller position rather than a bigger loss.

**The refusal is a sentence, not an error code.** The second order asked for the
same trade with the stop 10% away — $500 at risk against a $50 per-trade cap. It
never reached the exchange, and the agent was told what to change.

**Both orders are in the log, with the reason each was sent.** Including the one
that was refused. That is the record you read afterwards to find out what your
agent was actually trying to do.

## Wiring it into Claude Desktop, Claude Code or Cursor

`mcp.json` here is the same pairing as a config file. Both servers are stdio, so
they start on demand and stop with the client:

```json
{
  "mcpServers": {
    "hyperliquid-gateway": {
      "command": "hyperliquid-agent-gateway"
    },
    "reins": {
      "command": "npx",
      "args": ["-y", "@r2rlabs/reins", "serve"],
      "env": {
        "REINS_MODE": "paper",
        "REINS_NETWORK": "mainnet",
        "REINS_SYMBOLS": "BTC,ETH",
        "REINS_MAX_POSITION_USD": "5000",
        "REINS_DAILY_LOSS_USD": "500",
        "REINS_MAX_TRADE_RISK_USD": "50",
        "REINS_REQUIRE_STOP_LOSS": "true"
      }
    }
  }
}
```

Ask the model for a funding-carry screen and it uses the gateway. Ask it to act
on one and it goes through Reins, inside those limits, with a stop on every
position.

Live trading needs `REINS_MODE=live`, an account address and an API wallet key
that can trade but not withdraw — and Reins refuses to start live until the
account has approved its 2 basis point builder fee. Paper needs none of that.

## Why the split is the point

A data server with no keys cannot lose your money, and should not be asked to
hold them. An execution server should do one thing and refuse clearly. Keeping
them apart means you can swap either half, and the limits do not depend on the
data server behaving — Reins checks every order against the account it can see,
whatever told the model to send it.
