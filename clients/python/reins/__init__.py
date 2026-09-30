"""Reins from Python: risk limits and an audit log around a trading agent.

Most Hyperliquid bots are Python, and Reins speaks MCP or HTTP. This wraps the
HTTP side so a bot does not hand-roll requests:

    from reins import Reins, Refused

    reins = Reins.from_env()                  # REINS_URL, REINS_HTTP_TOKEN
    book = reins.book("BTC")
    entry = book["bids"][0]["price"]
    stop = entry * 0.99

    try:
        order = reins.place_order(
            symbol="BTC",
            side="buy",
            size_usd=Reins.size_for_risk(entry, stop, risk_usd=25),
            price=entry,
            stop_loss=stop,
            reason="range low held on the hourly",
        )
    except Refused as refusal:
        print(refusal.code, refusal.reason)   # e.g. TRADE_RISK_TOO_LARGE

A refusal is not a failure of the call: it is Reins doing its job, and it is
raised as `Refused` with the code so a bot can branch on it. Everything the
agent does, including what was refused, lands in the decision log.

No dependencies: stdlib only, so this can be vendored as a single file.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Literal

__all__ = [
    "Reins",
    "ReinsError",
    "Refused",
    "BadRequest",
    "Unauthorized",
    "ServerError",
    "__version__",
]

__version__ = "0.1.0"

Side = Literal["buy", "sell"]
TimeInForce = Literal["Gtc", "Ioc", "Alo"]
Interval = Literal["1m", "5m", "15m", "1h", "4h", "1d"]

# Refusals arrive as "BLOCKED (CODE): reason".
_BLOCKED = re.compile(r"^BLOCKED \(([A-Z_]+)\): (.*)$", re.S)


class ReinsError(Exception):
    """Anything that stopped a call from succeeding."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


class Refused(ReinsError):
    """A risk limit said no. The order never reached the exchange.

    `code` is one of POSITION_TOO_LARGE, LEVERAGE_TOO_HIGH, HALTED_DAILY_LOSS,
    TRADE_RISK_TOO_LARGE, NO_STOP_LOSS, SYMBOL_NOT_ALLOWED, RATE_LIMITED or
    INVALID_ORDER, and `reason` is the sentence explaining it.
    """

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(f"{code}: {reason}", status=400)
        self.code = code
        self.reason = reason


class BadRequest(ReinsError):
    """The request itself was wrong — a missing field, an unknown market."""


class Unauthorized(ReinsError):
    """No token, or the wrong one."""


class ServerError(ReinsError):
    """Reins or the exchange failed. Nothing can be assumed about the order."""


class Reins:
    """A client for one `reins http` server.

    The server serialises requests, so two orders cannot race the same limit;
    this class holds no state of its own beyond the address and token.
    """

    def __init__(self, base_url: str, token: str = "", *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    @classmethod
    def from_env(cls, **kwargs: Any) -> "Reins":
        """Read the address and token from the environment.

        REINS_URL (default http://127.0.0.1:8787) and REINS_HTTP_TOKEN, which
        is what `reins http` prints when it starts.
        """
        return cls(
            os.environ.get("REINS_URL", "http://127.0.0.1:8787"),
            os.environ.get("REINS_HTTP_TOKEN", ""),
            **kwargs,
        )

    # --- what the agent may know -------------------------------------------

    def health(self) -> dict[str, Any]:
        """Whether this server is paper or live, before anything is sent."""
        return self._get("/health", authenticated=False)

    def limits(self) -> dict[str, Any]:
        """The limits in force, so a bot can size inside them rather than guess."""
        return self._get("/limits")

    def positions(self) -> dict[str, Any]:
        """Open positions, equity, and the day's realised loss so far."""
        return self._get("/positions")

    def book(self, symbol: str, *, depth: int | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"symbol": symbol}
        if depth is not None:
            params["depth"] = depth
        return self._get("/book", params)

    def candles(
        self, symbol: str, *, interval: Interval | None = None, count: int | None = None
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"symbol": symbol}
        if interval is not None:
            params["interval"] = interval
        if count is not None:
            params["count"] = count
        return self._get("/candles", params)

    def decisions(self, *, limit: int | None = None) -> dict[str, Any]:
        """The log: what was tried, what was refused, what the exchange did."""
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return self._get("/decisions", params)

    # --- what the agent may do ---------------------------------------------

    def place_order(
        self,
        *,
        symbol: str,
        side: Side,
        size_usd: float,
        reason: str,
        price: float | None = None,
        stop_loss: float | None = None,
        reduce_only: bool | None = None,
        tif: TimeInForce | None = None,
    ) -> dict[str, Any]:
        """Send an order, or raise `Refused` if a limit stops it.

        `reason` is required, as it is for the agent: an order nobody explained
        is the one you cannot account for afterwards. Pass `stop_loss` unless
        the server was started without requiring one — it is attached to the
        order, so a resting entry carries its stop from the moment it fills.
        """
        payload: dict[str, Any] = {
            "symbol": symbol,
            "side": side,
            "sizeUsd": size_usd,
            "reason": reason,
        }
        if price is not None:
            payload["price"] = price
        if stop_loss is not None:
            payload["stopLoss"] = stop_loss
        if reduce_only is not None:
            payload["reduceOnly"] = reduce_only
        if tif is not None:
            payload["tif"] = tif
        return self._post("/orders", payload)

    def set_stop_loss(self, *, symbol: str, trigger_price: float, reason: str) -> dict[str, Any]:
        """Put a stop on an open position, or move the one that is there."""
        return self._post(
            "/stops", {"symbol": symbol, "triggerPrice": trigger_price, "reason": reason}
        )

    def cancel_order(
        self, *, symbol: str, order_id: int, reason: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"symbol": symbol, "orderId": order_id}
        if reason is not None:
            payload["reason"] = reason
        return self._post("/cancel", payload)

    def close_position(self, *, symbol: str, reason: str) -> dict[str, Any]:
        """Close the whole position at market, whatever its exact size is."""
        return self._post("/close", {"symbol": symbol, "reason": reason})

    # --- sizing -------------------------------------------------------------

    @staticmethod
    def size_for_risk(entry: float, stop: float, risk_usd: float) -> float:
        """The position size whose stop-out costs about `risk_usd`.

        Reins refuses an order whose stop-out would cost more than the per-trade
        limit (TRADE_RISK_TOO_LARGE), and this is the arithmetic it checks:
        size = risk / (distance to the stop, as a fraction of entry). Sizing
        this way is what makes a wider stop mean a smaller position rather than
        a bigger loss.
        """
        if entry <= 0:
            raise ValueError("entry must be positive")
        if stop <= 0:
            raise ValueError("stop must be positive")
        if risk_usd <= 0:
            raise ValueError("risk_usd must be positive")
        distance = abs(entry - stop) / entry
        if distance == 0:
            raise ValueError("stop must differ from entry")
        return risk_usd / distance

    # --- plumbing -----------------------------------------------------------

    def _get(
        self, path: str, params: dict[str, Any] | None = None, *, authenticated: bool = True
    ) -> dict[str, Any]:
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return self._send(url, None, authenticated)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._send(self.base_url + path, json.dumps(payload).encode(), True)

    def _send(self, url: str, data: bytes | None, authenticated: bool) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if authenticated and self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        request = urllib.request.Request(
            url, data=data, headers=headers, method="POST" if data is not None else "GET"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return self._decode(response.read())
        except urllib.error.HTTPError as error:
            raise self._error(error.code, error.read()) from None
        except urllib.error.URLError as error:
            raise ReinsError(f"could not reach Reins at {self.base_url}: {error.reason}") from None

    @staticmethod
    def _decode(raw: bytes) -> dict[str, Any]:
        text = raw.decode("utf-8", "replace")
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return {"result": text}
        return parsed if isinstance(parsed, dict) else {"result": parsed}

    @classmethod
    def _error(cls, status: int, raw: bytes) -> ReinsError:
        message = str(cls._decode(raw).get("error") or raw.decode("utf-8", "replace") or "")
        if status == 401:
            return Unauthorized(message or "no token", status=401)
        if status == 400:
            blocked = _BLOCKED.match(message)
            if blocked:
                return Refused(blocked.group(1), blocked.group(2).strip())
            return BadRequest(message, status=400)
        return ServerError(message or f"HTTP {status}", status=status)
