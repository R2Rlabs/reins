import { parseArgs } from "node:util";
import { REINS_BUILDER_ADDRESS } from "./builder-fee.js";
import { decompressLz4Frame } from "./lz4.js";

/**
 * `reins stats` — how much trading has gone through a builder code, from the
 * files Hyperliquid itself publishes.
 *
 * Every fill that carried a builder's code lands in a daily file at
 * stats-data.hyperliquid.xyz, published after the UTC day closes. Reins sends
 * nothing home, so this is the whole of what anyone, us included, can see:
 * accounts, trades, volume and fees on live mainnet. Paper trading leaves no
 * trace here, by design.
 */

export const STATS_USAGE = `Usage: reins stats [options]

Trading through Reins' builder code, from Hyperliquid's published daily files.
A day's file appears after it closes (UTC), so today shows up tomorrow.

Options:
  --days <n>          Days to look back, up to 365           (default 30)
  --builder <addr>    Builder address to report on    (default Reins' own)
  --json              Print the figures as JSON
  -h, --help          Show this help
`;

export interface StatsOptions {
  days: number;
  builder: string;
  json: boolean;
  help: boolean;
}

export function parseStatsArgs(argv: string[]): StatsOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      days: { type: "string", default: "30" },
      builder: { type: "string", default: REINS_BUILDER_ADDRESS },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error(`--days must be a whole number from 1 to 365, got "${values.days}".`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(values.builder)) {
    throw new Error(`--builder must be a 0x address of 40 hex digits, got "${values.builder}".`);
  }
  // The published paths are case sensitive, and lowercase.
  return { days, builder: values.builder.toLowerCase(), json: values.json, help: values.help };
}

export interface BuilderFill {
  time: string;
  user: string;
  coin: string;
  px: number;
  sz: number;
  /** False for a fill that rested on the book: a maker fill. */
  crossed: boolean;
  /** A stop or take-profit that fired. */
  trigger: boolean;
  builderFee: number;
}

/** One day's file, parsed by its header so a reordered or wider file still reads. */
export function parseBuilderFills(csv: string): BuilderFill[] {
  const lines = csv.split("\n").map((line) => line.trim()).filter(Boolean);
  const header = lines[0]?.split(",") ?? [];
  const at = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`builder_fills file has no "${name}" column.`);
    return index;
  };
  const col = {
    time: at("time"),
    user: at("user"),
    coin: at("coin"),
    px: at("px"),
    sz: at("sz"),
    crossed: at("crossed"),
    trigger: at("is_trigger"),
    fee: at("builder_fee"),
  };
  return lines.slice(1).map((line) => {
    const v = line.split(",");
    return {
      time: v[col.time] ?? "",
      user: (v[col.user] ?? "").toLowerCase(),
      coin: v[col.coin] ?? "",
      px: Number(v[col.px]),
      sz: Number(v[col.sz]),
      crossed: v[col.crossed] === "true",
      trigger: v[col.trigger] === "true",
      builderFee: Number(v[col.fee]),
    };
  });
}

export interface DayStats {
  date: string;
  accounts: number;
  newAccounts: number;
  trades: number;
  volumeUsd: number;
  feesUsd: number;
}

export interface PlatformStats {
  builder: string;
  from: string;
  to: string;
  daysWithTrading: number;
  accounts: number;
  trades: number;
  volumeUsd: number;
  feesUsd: number;
  makerTrades: number;
  stopsFired: number;
  markets: { coin: string; volumeUsd: number }[];
  byDay: DayStats[];
  /**
   * Fees Hyperliquid has credited this builder in total, claimed or not.
   * Independent of the daily files, which can be a day or more late, so it is
   * the figure to trust when a day is missing. Absent if the lookup failed.
   */
  feesCreditedUsd?: number;
}

/** `days` oldest first; a day with no file is simply absent. */
export function summarizeFills(
  builder: string,
  range: { from: string; to: string },
  days: { date: string; fills: BuilderFill[] }[],
): PlatformStats {
  const seen = new Set<string>();
  const markets = new Map<string, number>();
  const stats: PlatformStats = {
    builder,
    ...range,
    daysWithTrading: 0,
    accounts: 0,
    trades: 0,
    volumeUsd: 0,
    feesUsd: 0,
    makerTrades: 0,
    stopsFired: 0,
    markets: [],
    byDay: [],
  };
  for (const { date, fills } of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (fills.length === 0) continue;
    const today = new Set<string>();
    let newAccounts = 0;
    let volumeUsd = 0;
    let feesUsd = 0;
    for (const fill of fills) {
      const notional = fill.px * fill.sz;
      volumeUsd += notional;
      feesUsd += fill.builderFee;
      today.add(fill.user);
      if (!seen.has(fill.user)) {
        seen.add(fill.user);
        newAccounts++;
      }
      markets.set(fill.coin, (markets.get(fill.coin) ?? 0) + notional);
      if (!fill.crossed) stats.makerTrades++;
      if (fill.trigger) stats.stopsFired++;
    }
    stats.byDay.push({ date, accounts: today.size, newAccounts, trades: fills.length, volumeUsd, feesUsd });
    stats.daysWithTrading++;
    stats.trades += fills.length;
    stats.volumeUsd += volumeUsd;
    stats.feesUsd += feesUsd;
  }
  stats.accounts = seen.size;
  stats.markets = [...markets.entries()]
    .map(([coin, volumeUsd]) => ({ coin, volumeUsd }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd);
  return stats;
}

export type FetchBytes = (url: string) => Promise<{ status: number; bytes: Uint8Array }>;

export function builderFillsUrl(builder: string, date: string): string {
  return `https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/${builder}/${date.replaceAll("-", "")}.csv.lz4`;
}

/**
 * One day's fills, or an empty list when there is no file. Hyperliquid
 * answers a day with no fills, and a day not yet published, with 403.
 */
export async function fetchDay(fetchBytes: FetchBytes, builder: string, date: string): Promise<BuilderFill[]> {
  const { status, bytes } = await fetchBytes(builderFillsUrl(builder, date));
  if (status === 403 || status === 404) return [];
  if (status !== 200) throw new Error(`Hyperliquid answered ${status} for ${date}.`);
  return parseBuilderFills(new TextDecoder().decode(decompressLz4Frame(bytes)));
}

/** UTC dates, oldest first, ending today. */
export function lastDays(count: number, now: number): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: count }, (_, i) => new Date(today - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export interface StatsDeps {
  fetchBytes: FetchBytes;
  /** Hyperliquid's running total of fees credited to the builder. */
  feesCredited?: (builder: string) => Promise<number>;
  now: () => number;
  out: (text: string) => void;
}

export async function runStats(argv: string[], deps: StatsDeps): Promise<PlatformStats | undefined> {
  const opts = parseStatsArgs(argv);
  if (opts.help) {
    deps.out(STATS_USAGE);
    return undefined;
  }
  const dates = lastDays(opts.days, deps.now());
  const days: { date: string; fills: BuilderFill[] }[] = [];
  // A few at a time: a year is 365 requests to a public file server.
  for (let i = 0; i < dates.length; i += 8) {
    const batch = dates.slice(i, i + 8);
    const fetched = await Promise.all(batch.map((date) => fetchDay(deps.fetchBytes, opts.builder, date)));
    batch.forEach((date, j) => days.push({ date, fills: fetched[j]! }));
  }
  const stats = summarizeFills(opts.builder, { from: dates[0]!, to: dates.at(-1)! }, days);
  if (deps.feesCredited) {
    // Never fatal: the daily files are the point of the command, and this is
    // a second opinion on top of them.
    try {
      stats.feesCreditedUsd = await deps.feesCredited(opts.builder);
    } catch {
      // Left absent, and the report simply does not show the total.
    }
  }
  deps.out(opts.json ? `${JSON.stringify(stats, null, 2)}\n` : formatStats(stats));
  return stats;
}

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 && n > 0 ? 4 : 2 })}`;
const pct = (part: number, whole: number) => (whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`);

export function formatStats(s: PlatformStats): string {
  const lines = [
    `Trading through builder ${s.builder} on Hyperliquid`,
    `${s.from} to ${s.to} (UTC); a day appears once it has closed`,
    "",
  ];
  if (s.feesCreditedUsd !== undefined) {
    lines.push(`Fees credited ${usd(s.feesCreditedUsd)} in total, all time — Hyperliquid's own running count`, "");
  }
  if (s.trades === 0) {
    lines.push(
      s.feesCreditedUsd
        ? "No daily file for those days yet. Hyperliquid publishes one after a day closes, sometimes a day or more late; the total above is what it has credited."
        : "No trades carried this builder code in that time.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `Accounts      ${s.accounts}`,
    `Trades        ${s.trades}, on ${s.daysWithTrading} day${s.daysWithTrading === 1 ? "" : "s"}`,
    `Volume        ${usd(s.volumeUsd)}`,
    `Fees earned   ${usd(s.feesUsd)}`,
    `Maker fills   ${s.makerTrades} (${pct(s.makerTrades, s.trades)})`,
    `Stops fired   ${s.stopsFired}`,
    `Markets       ${s.markets.slice(0, 5).map((m) => `${m.coin} ${pct(m.volumeUsd, s.volumeUsd)}`).join(", ")}`,
    "",
    "Date         Accounts  New  Trades        Volume          Fees",
  );
  for (const d of s.byDay) {
    lines.push(
      `${d.date}   ${String(d.accounts).padStart(8)}  ${String(d.newAccounts).padStart(3)}  ${String(d.trades).padStart(6)}  ` +
        `${usd(d.volumeUsd).padStart(12)}  ${usd(d.feesUsd).padStart(12)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
