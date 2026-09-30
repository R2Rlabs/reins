"""Drives a real `reins http` server through the client, end to end.

Not part of the unit suite: it needs a server and the exchange's prices.

    node dist/bin/cli.js http --port 8799     # paper mode
    REINS_URL=http://127.0.0.1:8799 REINS_HTTP_TOKEN=... python tests/e2e.py
"""

from __future__ import annotations



import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reins import Refused, Reins  # noqa: E402


def main() -> int:
    reins = Reins.from_env()

    health = reins.health()
    print(f"health        {health['mode']} on {health.get('network')}, {len(health['routes'])} routes")
    if health["mode"] != "paper":
        print("refusing to run against a live server")
        return 1

    limits = reins.limits()
    print(f"limits        {limits}")

    positions = reins.positions()
    print(
        f"positions     equity ${positions['accountValueUsd']:,}, "
        f"{len(positions['positionsUsd'])} open, "
        f"{len(positions['unprotected'])} without a stop"
    )

    book = reins.book("BTC", depth=3)
    best_bid = book["bestBid"]
    print(f"book          BTC {best_bid} / {book['bestAsk']}, spread {book['spread']}")

    candles = reins.candles("BTC", interval="1h", count=5)
    print(f"candles       {len(candles.get('candles', []))} hourly")

    # An order sized so its stop-out costs about $20, inside the $50 per-trade cap.
    entry = round(best_bid * 0.995, 1)
    stop = round(entry * 0.99, 1)
    size = Reins.size_for_risk(entry, stop, risk_usd=20)
    order = reins.place_order(
        symbol="BTC",
        side="buy",
        size_usd=size,
        price=entry,
        stop_loss=stop,
        reason="end-to-end check of the Python client",
        tif="Alo",
    )
    print(f"order         ${size:,.0f} at {entry}, stop {stop} -> {order}")

    # The same order with a stop far enough away to breach the per-trade cap.
    try:
        reins.place_order(
            symbol="BTC",
            side="buy",
            size_usd=5000,
            price=entry,
            stop_loss=round(entry * 0.90, 1),
            reason="deliberately too much risk",
        )
        print("refusal       NOT REFUSED — the per-trade cap did not hold")
        return 1
    except Refused as refusal:
        print(f"refusal       {refusal.code}: {refusal.reason}")

    # A market Reins was not told to allow.
    try:
        reins.place_order(symbol="SOL", side="buy", size_usd=100, reason="not on the allowlist")
        print("allowlist     NOT REFUSED")
        return 1
    except Refused as refusal:
        print(f"allowlist     {refusal.code}")

    # No stop, on a server that requires one.
    try:
        reins.place_order(symbol="ETH", side="buy", size_usd=100, reason="no stop attached")
        print("stop rule     NOT REFUSED")
        return 1
    except Refused as refusal:
        print(f"stop rule     {refusal.code}")

    # A resting order reports its exchange id as "oid".
    order_id = order.get("oid")
    if order_id:
        cancelled = reins.cancel_order(
            symbol="BTC", order_id=order_id, reason="end of the check"
        )
        print(f"cancel        {cancelled}")

    log = reins.decisions(limit=10)
    records = log.get("decisions") or []
    refused = [r for r in records if r.get("risk", {}).get("allowed") is False]
    codes = ", ".join(sorted({r["risk"]["code"] for r in refused}))
    print(f"decision log  {len(records)} records, {len(refused)} refused ({codes})")

    print("\nOK — every route answered and every limit held.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
