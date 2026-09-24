"""
A bot plugged into Reins, in any language that can make an HTTP request.

Start Reins first, in paper mode, and copy the token it prints:

    npx @r2rlabs/reins http --port 8787

Then:

    REINS_TOKEN=... python examples/bot.py

Nothing here talks to Hyperliquid. Reins does that, after checking the order
against limits this script cannot change, and writing down the reason given
for it. Swap paper for live and the script does not change.
"""

import json
import os
import urllib.request

BASE = os.environ.get("REINS_URL", "http://127.0.0.1:8787")
TOKEN = os.environ["REINS_TOKEN"]


def call(method: str, path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{BASE}{path}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as refused:
        # A refusal is an answer, not a crash: it says which limit stopped the
        # order and why, in the same words the decision log keeps.
        return json.load(refused)


limits = call("GET", "/limits")["limits"]
print("trading under:", limits)

book = call("GET", "/book?symbol=ETH")
price = book["bestAsk"]

# Size from the stop, not the other way round: how far the stop sits decides
# what the trade can cost, and Reins refuses anything over its limit.
stop = round(price * 0.99, 2)
risk_usd = min(limits.get("maxTradeRiskUsd", 25), 25)
size_usd = min(risk_usd / (price - stop) * price, limits["maxPositionUsd"])

answer = call(
    "POST",
    "/orders",
    {
        "symbol": "ETH",
        "side": "buy",
        "sizeUsd": round(size_usd, 2),
        "stopLoss": stop,
        "reason": f"Example bot: buying ETH at {price} with a 1% stop at {stop}.",
    },
)
print("order:", answer)

print("positions:", call("GET", "/positions"))
print("last decisions:", [d["tool"] for d in call("GET", "/decisions?limit=5")["decisions"]])
