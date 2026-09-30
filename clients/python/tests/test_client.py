"""What the client puts on the wire, and what it does with what comes back.

A stub server stands in for `reins http` so these run with no network and no
exchange. The end-to-end check against the real server is in README.md under
"Checked against the real thing".
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reins import BadRequest, Refused, Reins, ReinsError, ServerError, Unauthorized  # noqa: E402


class Stub(BaseHTTPRequestHandler):
    """Records the last request and replies with whatever the test queued."""

    seen: dict = {}
    reply: tuple[int, dict] = (200, {})

    def _respond(self) -> None:
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        Stub.seen = {
            "method": self.command,
            "path": parsed.path,
            "query": {k: v[0] for k, v in parse_qs(parsed.query).items()},
            "auth": self.headers.get("Authorization"),
            "content_type": self.headers.get("Content-Type"),
            "body": json.loads(raw) if raw else None,
        }
        status, body = Stub.reply
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _respond
    do_POST = _respond

    def log_message(self, *args) -> None:  # keep the test output clean
        pass


class ClientTest(unittest.TestCase):
    server: HTTPServer
    thread: threading.Thread

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), Stub)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.base = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def client(self, token: str = "tok") -> Reins:
        return Reins(self.base, token, timeout=5)

    def reply(self, status: int, body: dict) -> None:
        Stub.reply = (status, body)

    # --- requests -----------------------------------------------------------

    def test_get_sends_bearer_token(self):
        self.reply(200, {"limits": {}})
        self.client().limits()
        self.assertEqual(Stub.seen["method"], "GET")
        self.assertEqual(Stub.seen["path"], "/limits")
        self.assertEqual(Stub.seen["auth"], "Bearer tok")

    def test_health_needs_no_token(self):
        self.reply(200, {"ok": True, "mode": "paper"})
        Reins(self.base, "", timeout=5).health()
        self.assertIsNone(Stub.seen["auth"])

    def test_optional_query_parameters_are_left_out(self):
        self.reply(200, {})
        self.client().book("BTC")
        self.assertEqual(Stub.seen["query"], {"symbol": "BTC"})
        self.client().book("BTC", depth=5)
        self.assertEqual(Stub.seen["query"], {"symbol": "BTC", "depth": "5"})

    def test_candles_passes_interval_and_count(self):
        self.reply(200, {})
        self.client().candles("ETH", interval="1h", count=50)
        self.assertEqual(Stub.seen["query"], {"symbol": "ETH", "interval": "1h", "count": "50"})

    def test_order_uses_the_camel_case_the_server_expects(self):
        self.reply(200, {"orderId": 7})
        self.client().place_order(
            symbol="BTC",
            side="buy",
            size_usd=500,
            reason="range low held",
            price=60000,
            stop_loss=59400,
            tif="Alo",
        )
        self.assertEqual(Stub.seen["method"], "POST")
        self.assertEqual(Stub.seen["path"], "/orders")
        self.assertEqual(Stub.seen["content_type"], "application/json")
        self.assertEqual(
            Stub.seen["body"],
            {
                "symbol": "BTC",
                "side": "buy",
                "sizeUsd": 500,
                "reason": "range low held",
                "price": 60000,
                "stopLoss": 59400,
                "tif": "Alo",
            },
        )

    def test_order_omits_what_was_not_given(self):
        self.reply(200, {})
        self.client().place_order(symbol="BTC", side="sell", size_usd=100, reason="why")
        self.assertEqual(
            set(Stub.seen["body"]), {"symbol", "side", "sizeUsd", "reason"}
        )

    def test_reduce_only_false_is_still_sent(self):
        self.reply(200, {})
        self.client().place_order(
            symbol="BTC", side="sell", size_usd=100, reason="why", reduce_only=False
        )
        self.assertIs(Stub.seen["body"]["reduceOnly"], False)

    def test_stop_and_cancel_and_close(self):
        self.reply(200, {})
        self.client().set_stop_loss(symbol="BTC", trigger_price=59000, reason="under the low")
        self.assertEqual(
            Stub.seen["body"], {"symbol": "BTC", "triggerPrice": 59000, "reason": "under the low"}
        )
        self.client().cancel_order(symbol="BTC", order_id=42)
        self.assertEqual(Stub.seen["body"], {"symbol": "BTC", "orderId": 42})
        self.client().close_position(symbol="BTC", reason="done")
        self.assertEqual(Stub.seen["path"], "/close")

    # --- answers ------------------------------------------------------------

    def test_refusal_becomes_refused_with_its_code(self):
        self.reply(400, {"error": "BLOCKED (TRADE_RISK_TOO_LARGE): Stopping out would lose $120.00."})
        with self.assertRaises(Refused) as caught:
            self.client().place_order(symbol="BTC", side="buy", size_usd=9e9, reason="too big")
        self.assertEqual(caught.exception.code, "TRADE_RISK_TOO_LARGE")
        self.assertEqual(caught.exception.reason, "Stopping out would lose $120.00.")
        self.assertIsInstance(caught.exception, ReinsError)

    def test_a_plain_400_is_not_a_refusal(self):
        self.reply(400, {"error": '"symbol" is required.'})
        with self.assertRaises(BadRequest):
            self.client().close_position(symbol="", reason="x")

    def test_401_is_unauthorized(self):
        self.reply(401, {"error": "Send the token as: Authorization: Bearer <token>."})
        with self.assertRaises(Unauthorized):
            self.client().positions()

    def test_500_is_a_server_error(self):
        self.reply(500, {"error": "exchange unreachable"})
        with self.assertRaises(ServerError) as caught:
            self.client().positions()
        self.assertEqual(caught.exception.status, 500)

    def test_unreachable_server_says_so(self):
        with self.assertRaises(ReinsError) as caught:
            Reins("http://127.0.0.1:9", "tok", timeout=2).limits()
        self.assertIn("could not reach Reins", str(caught.exception))

    def test_non_json_body_is_not_an_exception(self):
        Stub.reply = (200, {})
        self.assertEqual(self.client().limits(), {})

    # --- sizing -------------------------------------------------------------

    def test_size_for_risk_matches_the_engine(self):
        # 1% away, $25 at risk -> $2,500 of notional.
        self.assertAlmostEqual(Reins.size_for_risk(100, 99, 25), 2500)
        # A wider stop means a smaller position, not a bigger loss.
        self.assertAlmostEqual(Reins.size_for_risk(100, 98, 25), 1250)
        # Direction does not matter.
        self.assertAlmostEqual(Reins.size_for_risk(100, 101, 25), 2500)

    def test_size_for_risk_rejects_nonsense(self):
        for args in [(0, 99, 25), (100, 0, 25), (100, 99, 0), (100, 100, 25)]:
            with self.assertRaises(ValueError):
                Reins.size_for_risk(*args)

    def test_from_env(self):
        import os

        os.environ["REINS_URL"] = "http://example.test:1234/"
        os.environ["REINS_HTTP_TOKEN"] = "abc"
        client = Reins.from_env()
        self.assertEqual(client.base_url, "http://example.test:1234")
        self.assertEqual(client.token, "abc")


if __name__ == "__main__":
    unittest.main()
