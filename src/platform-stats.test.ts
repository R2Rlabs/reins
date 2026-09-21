import { describe, expect, it } from "vitest";
import { decompressLz4Frame } from "./lz4.js";
import {
  builderFillsUrl,
  formatStats,
  lastDays,
  parseBuilderFills,
  parseStatsArgs,
  runStats,
  summarizeFills,
  type FetchBytes,
} from "./platform-stats.js";

/** An LZ4 frame around the given blocks: independent blocks, 64 KB max, no checksums. */
function frame(...blocks: { raw?: boolean; data: number[] }[]): Uint8Array {
  const bytes = [0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82];
  for (const block of blocks) {
    const size = block.data.length | (block.raw ? 0x80000000 : 0);
    bytes.push(size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, (size >>> 24) & 0xff, ...block.data);
  }
  bytes.push(0, 0, 0, 0);
  return new Uint8Array(bytes);
}
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("decompressLz4Frame", () => {
  it("reads a stored block as it is", () => {
    expect(text(decompressLz4Frame(frame({ raw: true, data: ascii("time,user\n") })))).toBe("time,user\n");
  });

  it("expands a match that overlaps what it copies", () => {
    // 3 literals "abc", then 9 bytes copied from 3 back.
    expect(text(decompressLz4Frame(frame({ data: [0x35, ...ascii("abc"), 3, 0] })))).toBe("abcabcabcabc");
  });

  it("reads the extra length bytes of long literals and long matches", () => {
    // 15 + 5 = 20 literals, then a 15 + 11 + 4 = 30 byte match one back.
    const block = [0xff, 5, ...ascii("x".repeat(20)), 1, 0, 11];
    expect(text(decompressLz4Frame(frame({ data: block })))).toBe("x".repeat(50));
  });

  it("joins blocks and ends a block on literals", () => {
    const out = decompressLz4Frame(frame({ data: [0x35, ...ascii("abc"), 3, 0, 0x20, ...ascii("!\n")] }, { raw: true, data: ascii("end") }));
    expect(text(out)).toBe("abcabcabcabc!\nend");
  });

  it("refuses what is not an LZ4 frame, or is cut short", () => {
    expect(() => decompressLz4Frame(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow(/Not an LZ4 frame/);
    const cut = frame({ raw: true, data: ascii("abcdef") }).slice(0, 12);
    expect(() => decompressLz4Frame(cut)).toThrow(/runs past the end/);
  });
});

// The columns of a real builder_fills file, 2026-09-08.
const HEADER = "time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee";
const row = (user: string, coin: string, px: number, sz: number, fee: number, opts: { maker?: boolean; stop?: boolean } = {}) =>
  `2026-09-21T09:11:40Z,${user},${coin},Bid,${px},${sz},${!opts.maker},Na,Ioc,${Boolean(opts.stop)},0xcc,0,0,${fee}`;
const A = "0xAAAA000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";

describe("parseBuilderFills", () => {
  it("reads the columns it needs by name", () => {
    const [fill] = parseBuilderFills(`${HEADER}\n${row(A, "BTC", 84114, 0.00014, 0.002355, { maker: true, stop: true })}\n`);
    expect(fill).toEqual({
      time: "2026-09-21T09:11:40Z",
      user: A.toLowerCase(),
      coin: "BTC",
      px: 84114,
      sz: 0.00014,
      crossed: false,
      trigger: true,
      builderFee: 0.002355,
    });
  });

  it("says which column is missing rather than reading nonsense", () => {
    expect(() => parseBuilderFills("time,user,coin\n")).toThrow(/no "px" column/);
  });
});

describe("summarizeFills", () => {
  const range = { from: "2026-09-19", to: "2026-09-21" };
  const day = (date: string, rows: string[]) => ({ date, fills: parseBuilderFills([HEADER, ...rows].join("\n")) });

  it("counts accounts once, and new ones on the day they first trade", () => {
    const stats = summarizeFills("0xb", range, [
      day("2026-09-21", [row(A, "BTC", 100, 1, 0.02), row(B, "ETH", 50, 2, 0.02, { maker: true })]),
      day("2026-09-19", [row(A, "BTC", 100, 2, 0.04, { stop: true })]),
      day("2026-09-20", []),
    ]);
    expect(stats).toMatchObject({ accounts: 2, trades: 3, daysWithTrading: 2, volumeUsd: 400, makerTrades: 1, stopsFired: 1 });
    expect(stats.feesUsd).toBeCloseTo(0.08, 9);
    expect(stats.byDay.map((d) => [d.date, d.accounts, d.newAccounts])).toEqual([
      ["2026-09-19", 1, 1],
      ["2026-09-21", 2, 1],
    ]);
    expect(stats.markets).toEqual([
      { coin: "BTC", volumeUsd: 300 },
      { coin: "ETH", volumeUsd: 100 },
    ]);
  });

  it("says plainly when nothing traded", () => {
    const stats = summarizeFills("0xb", range, []);
    expect(formatStats(stats)).toContain("No trades carried this builder code");
  });
});

describe("runStats", () => {
  const NOW = Date.UTC(2026, 8, 21, 12);

  it("reads each day's file, treating Hyperliquid's 403 as a day without one", async () => {
    const asked: string[] = [];
    const csv = [HEADER, row(A, "BTC", 84114, 0.00014, 0.002355), row(A, "BTC", 84113, 0.00014, 0.002355)].join("\n");
    const fetchBytes: FetchBytes = async (url) => {
      asked.push(url);
      return url.endsWith("20260920.csv.lz4")
        ? { status: 200, bytes: frame({ raw: true, data: ascii(csv) }) }
        : { status: 403, bytes: new Uint8Array() };
    };
    let out = "";
    const stats = await runStats(["--days", "3"], { fetchBytes, now: () => NOW, out: (t) => (out += t) });

    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe(builderFillsUrl("0x658dc3a1fc753262c83c7345032e6db7aa8fa997", "2026-09-19"));
    expect(stats).toMatchObject({ accounts: 1, trades: 2, daysWithTrading: 1 });
    expect(out).toContain("Fees earned   $0.0047");
    expect(out).toMatch(/2026-09-20\s+1\s+1\s+2/);
  });

  it("stops on an answer that is neither a file nor a missing day", async () => {
    const fetchBytes: FetchBytes = async () => ({ status: 500, bytes: new Uint8Array() });
    await expect(runStats(["--days", "1"], { fetchBytes, now: () => NOW, out: () => {} })).rejects.toThrow(/answered 500/);
  });
});

describe("options", () => {
  it("looks back 30 days at Reins' own builder, lowercased as the paths need", () => {
    expect(parseStatsArgs([])).toMatchObject({ days: 30, builder: "0x658dc3a1fc753262c83c7345032e6db7aa8fa997", json: false });
  });

  it("refuses a nonsense range or address", () => {
    expect(() => parseStatsArgs(["--days", "0"])).toThrow(/1 to 365/);
    expect(() => parseStatsArgs(["--days", "400"])).toThrow(/1 to 365/);
    expect(() => parseStatsArgs(["--builder", "0x123"])).toThrow(/40 hex digits/);
  });

  it("counts UTC days back from today, oldest first", () => {
    expect(lastDays(3, Date.UTC(2026, 8, 1, 23, 59))).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
  });
});
