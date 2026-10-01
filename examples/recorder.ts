/**
 * Record Hyperliquid's live feeds to disk, because nobody publishes the history
 * we would need to study liquidation cascades.
 *
 *   node examples/recorder.ts --symbols BTC,ETH
 *   node examples/recorder.ts --symbols BTC --dir data/market --book-every 10
 *
 * Hyperliquid's public archive only carries builder fills. There is no trade
 * tape, no book history and no liquidation feed to download, so the only way to
 * own that data is to start keeping it. This writes newline-delimited JSON, one
 * file per channel per UTC day:
 *
 *   trades-20261001.jsonl   every print: price, size, side, and both addresses
 *   book-20261001.jsonl     top of book, sampled rather than streamed
 *   ctx-20261001.jsonl      mark, oracle, funding and open interest
 *
 * The addresses matter: a liquidation is a trade where one side is an account
 * being closed out, and keeping `users` is what makes it possible to label
 * cascades later rather than guessing from price alone.
 *
 * ## Gaps are recorded, not hidden
 *
 * A reconnect means missing data, and a file that does not say so will be
 * analysed as though the market went quiet. Every disconnect writes a `gap`
 * record with how long it lasted, so anything reading these files can tell the
 * difference between a calm market and a dropped socket.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const WS_URL = "wss://api.hyperliquid.xyz/ws";

/** Only what the recorder needs, so a test can hand it a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RecorderOptions {
  symbols: string[];
  /** Seconds between stored book snapshots. The feed is faster than useful. */
  bookEverySeconds: number;
  /** Seconds between stored context records. Funding and OI move slowly. */
  ctxEverySeconds?: number;
  connect: () => SocketLike;
  write: (channel: "trades" | "book" | "ctx" | "meta", line: string) => void;
  now?: () => number;
  /** Reconnect delays in ms, the last repeating. */
  backoff?: number[];
  schedule?: (fn: () => void, ms: number) => void;
}

export interface RecorderStats {
  trades: number;
  books: number;
  ctx: number;
  reconnects: number;
  droppedBooks: number;
  droppedCtx: number;
}

/**
 * Subscribes, writes, and reconnects. Holds no files of its own: `write` is
 * injected so the same class can be driven by a test with no disk at all.
 */
export class Recorder {
  readonly stats: RecorderStats = { trades: 0, books: 0, ctx: 0, reconnects: 0, droppedBooks: 0, droppedCtx: 0 };
  private socket: SocketLike | null = null;
  private lastBookAt = new Map<string, number>();
  private lastCtxAt = new Map<string, number>();
  private disconnectedAt: number | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly backoff: number[];
  private readonly schedule: (fn: () => void, ms: number) => void;

  // Declared rather than a parameter property: Node runs this file directly,
  // and its type stripping does not support the shorthand.
  private readonly options: RecorderOptions;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.backoff = options.backoff ?? [1_000, 2_000, 5_000, 15_000, 30_000];
    this.schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms).unref?.());
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    const socket = this.options.connect();
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      if (this.disconnectedAt !== null) {
        // What was missed, in the data itself.
        this.options.write(
          "meta",
          JSON.stringify({
            kind: "gap",
            from: this.disconnectedAt,
            to: this.now(),
            missedMs: this.now() - this.disconnectedAt,
          }),
        );
        this.disconnectedAt = null;
      }
      for (const coin of this.options.symbols) {
        for (const type of ["trades", "l2Book", "activeAssetCtx"]) {
          socket.send(JSON.stringify({ method: "subscribe", subscription: { type, coin } }));
        }
      }
      this.options.write(
        "meta",
        JSON.stringify({ kind: "subscribed", at: this.now(), symbols: this.options.symbols }),
      );
    };

    socket.onmessage = (event) => this.handle(event.data);

    const dropped = () => {
      if (this.disconnectedAt === null) this.disconnectedAt = this.now();
      if (this.stopped) return;
      this.stats.reconnects++;
      const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)]!;
      this.attempt++;
      this.schedule(() => this.open(), delay);
    };
    socket.onclose = dropped;
    socket.onerror = dropped;
  }

  /** Exposed for tests: the routing, without a socket. */
  handle(raw: unknown): void {
    let message: { channel?: string; data?: unknown };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }
    const at = this.now();

    if (message.channel === "trades" && Array.isArray(message.data)) {
      for (const trade of message.data) {
        this.stats.trades++;
        this.options.write("trades", JSON.stringify({ at, ...(trade as object) }));
      }
      return;
    }

    if (message.channel === "l2Book" && message.data) {
      const book = message.data as { coin?: string; levels?: unknown[][] };
      const coin = book.coin ?? "?";
      const last = this.lastBookAt.get(coin) ?? 0;
      // The book updates far faster than it is worth storing; one snapshot every
      // few seconds is enough to see depth vanish during a cascade.
      if (at - last < this.options.bookEverySeconds * 1_000) {
        this.stats.droppedBooks++;
        return;
      }
      this.lastBookAt.set(coin, at);
      this.stats.books++;
      const [bids = [], asks = []] = book.levels ?? [];
      this.options.write(
        "book",
        JSON.stringify({ at, coin, bids: bids.slice(0, 10), asks: asks.slice(0, 10) }),
      );
      return;
    }

    if (message.channel === "activeAssetCtx" && message.data) {
      // Mark moves every second; funding and open interest do not. Storing a
      // second of it all day is 50MB of a number that changed in the third
      // decimal place.
      const ctx = message.data as { coin?: string };
      const coin = ctx.coin ?? "?";
      const every = (this.options.ctxEverySeconds ?? 10) * 1_000;
      if (at - (this.lastCtxAt.get(coin) ?? 0) < every) {
        this.stats.droppedCtx++;
        return;
      }
      this.lastCtxAt.set(coin, at);
      this.stats.ctx++;
      this.options.write("ctx", JSON.stringify({ at, ...(message.data as object) }));
    }
  }
}

/** One file per channel per UTC day, opened on demand and reopened at midnight. */
export function dailyWriter(dir: string, now: () => number = Date.now) {
  const open = new Map<string, { day: string; stream: WriteStream }>();
  mkdirSync(dir, { recursive: true });
  return {
    write(channel: string, line: string): void {
      const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, "");
      const current = open.get(channel);
      if (!current || current.day !== day) {
        current?.stream.end();
        const stream = createWriteStream(join(dir, `${channel}-${day}.jsonl`), { flags: "a" });
        open.set(channel, { day, stream });
        stream.write(line + "\n");
        return;
      }
      current.stream.write(line + "\n");
    },
    close(): void {
      for (const { stream } of open.values()) stream.end();
      open.clear();
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbols: { type: "string", default: "BTC,ETH" },
      dir: { type: "string", default: "data/market" },
      "book-every": { type: "string", default: "5" },
      "ctx-every": { type: "string", default: "10" },
    },
  });

  const symbols = values.symbols!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const writer = dailyWriter(values.dir!);
  const recorder = new Recorder({
    symbols,
    bookEverySeconds: Number(values["book-every"]),
    ctxEverySeconds: Number(values["ctx-every"]),
    connect: () => new WebSocket(WS_URL) as unknown as SocketLike,
    write: (channel, line) => writer.write(channel, line),
  });

  console.error(
    `recording ${symbols.join(", ")} into ${values.dir}/ — trades, book every ${values["book-every"]}s, context.\n` +
      `Nothing publishes this history, so the only copy is the one you keep. Ctrl-C to stop.`,
  );
  recorder.start();

  const started = Date.now();
  const tick = setInterval(() => {
    const mins = ((Date.now() - started) / 60_000).toFixed(0);
    const s = recorder.stats;
    console.error(
      `${new Date().toISOString().slice(11, 19)}  ${mins}m  ` +
        `${s.trades} trades, ${s.books} books, ${s.ctx} ctx, ${s.reconnects} reconnects`,
    );
  }, 60_000);
  tick.unref?.();

  const shutdown = () => {
    clearInterval(tick);
    recorder.stop();
    writer.close();
    const s = recorder.stats;
    console.error(`\nstopped: ${s.trades} trades, ${s.books} books, ${s.ctx} ctx, ${s.reconnects} reconnects`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
