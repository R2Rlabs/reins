/**
 * The recorder's job is to produce a file somebody can trust months later, so
 * these cover the ways it could quietly lie: losing the addresses that identify
 * a liquidation, throttling the book without saying so, and above all failing
 * to record that a reconnect left a hole in the data.
 */
import { describe, expect, it, vi } from "vitest";
import { Recorder, type SocketLike } from "./recorder.ts";

function fakeSocket(): SocketLike & { sent: string[] } {
  return {
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

function setup(bookEverySeconds = 5) {
  const written: Array<{ channel: string; line: string }> = [];
  const sockets: Array<ReturnType<typeof fakeSocket>> = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let clock = 1_000_000;

  const recorder = new Recorder({
    symbols: ["BTC", "ETH"],
    bookEverySeconds,
    connect: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    write: (channel, line) => written.push({ channel, line }),
    now: () => clock,
    backoff: [100, 500],
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
  });

  return {
    recorder,
    written,
    sockets,
    scheduled,
    advance: (ms: number) => (clock += ms),
    records: (channel: string) =>
      written.filter((w) => w.channel === channel).map((w) => JSON.parse(w.line)),
  };
}

describe("subscribing", () => {
  it("asks for all three channels on every symbol", () => {
    const t = setup();
    t.recorder.start();
    t.sockets[0]!.onopen!({});

    const subs = t.sockets[0]!.sent.map((s) => JSON.parse(s).subscription);
    expect(subs).toHaveLength(6);
    expect(subs.filter((s) => s.coin === "BTC").map((s) => s.type)).toEqual([
      "trades",
      "l2Book",
      "activeAssetCtx",
    ]);
  });
});

describe("trades", () => {
  it("keeps both addresses, which is what identifies a liquidation later", () => {
    const t = setup();
    t.recorder.start();
    t.recorder.handle(
      JSON.stringify({
        channel: "trades",
        data: [
          {
            coin: "BTC",
            side: "B",
            px: "84532.0",
            sz: "0.06869",
            time: 1790890314914,
            tid: 832995435204291,
            users: ["0xaaa", "0xbbb"],
          },
        ],
      }),
    );

    const [trade] = t.records("trades");
    expect(trade.users).toEqual(["0xaaa", "0xbbb"]);
    expect(trade.px).toBe("84532.0");
    // Our own clock as well as the exchange's, so delay can be measured.
    expect(trade.at).toBe(1_000_000);
    expect(trade.time).toBe(1790890314914);
  });

  it("writes one record per trade in a batched message", () => {
    const t = setup();
    t.recorder.handle(
      JSON.stringify({
        channel: "trades",
        data: [{ coin: "BTC", px: "1" }, { coin: "BTC", px: "2" }, { coin: "BTC", px: "3" }],
      }),
    );
    expect(t.records("trades")).toHaveLength(3);
    expect(t.recorder.stats.trades).toBe(3);
  });
});

describe("the book", () => {
  it("samples rather than storing every update, per coin", () => {
    const t = setup(5);
    const book = (coin: string) =>
      JSON.stringify({
        channel: "l2Book",
        data: { coin, levels: [[{ px: "1" }], [{ px: "2" }]] },
      });

    t.recorder.handle(book("BTC"));
    t.recorder.handle(book("BTC")); // same instant: dropped
    t.advance(2_000);
    t.recorder.handle(book("BTC")); // still inside the window: dropped
    t.advance(4_000);
    t.recorder.handle(book("BTC")); // 6s later: kept

    expect(t.records("book")).toHaveLength(2);
    expect(t.recorder.stats.droppedBooks).toBe(2);

    // A different coin has its own clock.
    t.recorder.handle(book("ETH"));
    expect(t.records("book").filter((b) => b.coin === "ETH")).toHaveLength(1);
  });

  it("keeps ten levels a side, not the whole book", () => {
    const t = setup();
    const levels = Array.from({ length: 50 }, (_, i) => ({ px: String(i), sz: "1" }));
    t.recorder.handle(
      JSON.stringify({ channel: "l2Book", data: { coin: "BTC", levels: [levels, levels] } }),
    );
    const [snapshot] = t.records("book");
    expect(snapshot.bids).toHaveLength(10);
    expect(snapshot.asks).toHaveLength(10);
  });
});

describe("gaps", () => {
  it("records how long the feed was down, so silence is not read as calm", () => {
    const t = setup();
    t.recorder.start();
    t.sockets[0]!.onopen!({});

    t.advance(1_000);
    t.sockets[0]!.onclose!({}); // dropped at 1,001,000
    expect(t.scheduled).toHaveLength(1);
    expect(t.scheduled[0]!.ms).toBe(100);

    t.advance(30_000);
    t.scheduled[0]!.fn(); // reconnect
    t.sockets[1]!.onopen!({});

    const gap = t.records("meta").find((r) => r.kind === "gap");
    expect(gap).toMatchObject({ missedMs: 30_000 });
    expect(t.recorder.stats.reconnects).toBe(1);
  });

  it("backs off further each time, then holds at the longest delay", () => {
    const t = setup();
    t.recorder.start();
    t.sockets[0]!.onopen!({});

    t.sockets[0]!.onclose!({});
    t.scheduled[0]!.fn();
    t.sockets[1]!.onclose!({});
    t.scheduled[1]!.fn();
    t.sockets[2]!.onclose!({});

    expect(t.scheduled.map((s) => s.ms)).toEqual([100, 500, 500]);
  });

  it("stops trying once it has been stopped", () => {
    const t = setup();
    t.recorder.start();
    t.sockets[0]!.onopen!({});
    t.recorder.stop();
    t.sockets[0]!.onclose!({});
    expect(t.scheduled).toHaveLength(0);
  });

  it("writes one gap for a reconnect, not one per failed attempt", () => {
    const t = setup();
    t.recorder.start();
    t.sockets[0]!.onopen!({});
    t.sockets[0]!.onclose!({});
    t.advance(5_000);
    t.scheduled[0]!.fn();
    t.sockets[1]!.onerror!({}); // failed again
    t.advance(5_000);
    t.scheduled[1]!.fn();
    t.sockets[2]!.onopen!({}); // finally back

    expect(t.records("meta").filter((r) => r.kind === "gap")).toHaveLength(1);
  });
});

describe("rubbish in", () => {
  it("ignores what it cannot parse rather than dying mid-run", () => {
    const t = setup();
    expect(() => t.recorder.handle("not json")).not.toThrow();
    expect(() => t.recorder.handle(JSON.stringify({ channel: "unknown" }))).not.toThrow();
    expect(t.written).toHaveLength(0);
  });
});
