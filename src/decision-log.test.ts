import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HyperliquidClient } from "./client.js";
import {
  createIdFactory,
  MemoryDecisionLog,
  riskOf,
  type DecisionLog,
  type DecisionRecord,
} from "./decision-log.js";
import { FileDecisionLog } from "./decision-log-file.js";
import { MockTransport } from "./mock-transport.js";
import {
  closePosition,
  getRecentDecisions,
  placeOrder,
  type McpServerDeps,
  type ToolResult,
} from "./mcp-server.js";
import { RiskEngine, type RiskLimits } from "./risk.js";
import { StubSigner } from "./signer.js";
import type { L2Book } from "./types.js";

const LIMITS: RiskLimits = {
  maxPositionUsd: 25_000,
  maxLeverage: 5,
  dailyLossLimitUsd: 2_500,
  symbolAllowlist: ["BTC", "ETH"],
  maxOrdersPerMinute: 12,
};

const META = {
  universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }],
};

const STATE = {
  assetPositions: [
    {
      position: {
        coin: "BTC",
        szi: "0.125",
        entryPx: "100000",
        positionValue: "12500",
        unrealizedPnl: "0",
        marginUsed: "2500",
      },
    },
  ],
  marginSummary: {
    accountValue: "13109.48",
    totalMarginUsed: "2500",
    totalNtlPos: "12500",
    totalRawUsd: "13000",
  },
  withdrawable: "10000",
};

const BOOK: L2Book = {
  coin: "BTC",
  time: 1,
  levels: [
    [{ px: "100000", sz: "5", n: 10 }],
    [{ px: "100010", sz: "4", n: 7 }],
  ],
};

function setup(log?: DecisionLog) {
  const transport = new MockTransport()
    .reply("info:meta", META)
    .reply("info:clearinghouseState", STATE)
    .reply("info:userAbstraction", "disabled")
    .reply("info:userFills", [])
    .reply("info:l2Book", BOOK)
    .reply("exchange:order", {
      status: "ok",
      response: { type: "order", data: { statuses: [{ resting: { oid: 5150 } }] } },
    });

  const client = new HyperliquidClient({
    fetch: transport.fetch,
    signer: new StubSigner(),
  });
  const deps: McpServerDeps = {
    client,
    engine: new RiskEngine(LIMITS),
    ...(log ? { log } : {}),
  };
  return { deps, transport };
}

function text(result: ToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("no text content");
  return first.text;
}

/** A log that always fails, standing in for a full disk or a bad path. */
class BrokenLog implements DecisionLog {
  async append(): Promise<void> {
    throw new Error("disk full");
  }
  async read(): Promise<DecisionRecord[]> {
    return [];
  }
}

describe("MemoryDecisionLog", () => {
  it("returns the most recent records first", async () => {
    const log = new MemoryDecisionLog();
    for (const id of ["a", "b", "c"]) {
      await log.append({
        id,
        time: "2026-09-17T00:00:00.000Z",
        tool: "place_order",
        reason: "r",
        request: {},
      });
    }
    expect((await log.read(2)).map((r) => r.id)).toEqual(["c", "b"]);
  });
});

describe("riskOf", () => {
  it("flattens an allowed decision", () => {
    expect(riskOf({ allowed: true })).toEqual({ allowed: true });
  });

  it("keeps the code and detail of a block", () => {
    expect(
      riskOf({ allowed: false, code: "POSITION_TOO_LARGE", reason: "too big" }),
    ).toEqual({ allowed: false, code: "POSITION_TOO_LARGE", detail: "too big" });
  });
});

describe("createIdFactory", () => {
  it("produces unique, sortable ids even inside one millisecond", () => {
    const ids = createIdFactory(() => 1_700_000_000_000);
    const generated = [ids(), ids(), ids()];
    expect(new Set(generated).size).toBe(3);
    expect([...generated].sort()).toEqual(generated);
  });
});

describe("FileDecisionLog", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reins-log-"));
    path = join(dir, "nested", "decisions.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function record(id: string): DecisionRecord {
    return {
      id,
      time: "2026-09-17T00:00:00.000Z",
      tool: "place_order",
      reason: `reason ${id}`,
      request: { symbol: "BTC" },
    };
  }

  it("returns nothing when the file does not exist yet", async () => {
    expect(await new FileDecisionLog(path).read(10)).toEqual([]);
  });

  it("creates the directory and writes one JSON object per line", async () => {
    const log = new FileDecisionLog(path);
    await log.append(record("a"));
    await log.append(record("b"));

    const raw = await readFile(path, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("a");
  });

  it("reads back most recent first", async () => {
    const log = new FileDecisionLog(path);
    await log.append(record("a"));
    await log.append(record("b"));
    await log.append(record("c"));

    expect((await log.read(2)).map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("skips a truncated final line instead of losing the history behind it", async () => {
    const log = new FileDecisionLog(path);
    await log.append(record("a"));
    await writeFile(path, `${await readFile(path, "utf8")}{"id":"trunc`, "utf8");

    const records = await log.read(10);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("a");
  });

  it("does not interleave concurrent appends", async () => {
    const log = new FileDecisionLog(path);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => log.append(record(String(i)))),
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(20);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("recording orders", () => {
  it("stores the reason, context, risk verdict and outcome", async () => {
    const log = new MemoryDecisionLog();
    const { deps } = setup(log);
    await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 5_000,
      price: 100_000,
      reason: "Funding negative six hours running; sizing at a fifth of the cap.",
    });

    expect(log.records).toHaveLength(1);
    const entry = log.records[0]!;
    expect(entry.tool).toBe("place_order");
    expect(entry.reason).toContain("Funding negative");
    expect(entry.risk).toEqual({ allowed: true });
    expect(entry.outcome).toMatchObject({ kind: "resting", oid: 5150 });
    expect(entry.context?.positionsUsd).toEqual({ BTC: 12_500 });
    expect(entry.request).toMatchObject({ symbol: "BTC", sizeUsd: 5_000 });
  });

  it("records orders the risk engine refused", async () => {
    const log = new MemoryDecisionLog();
    const { deps } = setup(log);
    await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 90_000,
      price: 100_000,
      reason: "Strong breakout, going large.",
    });

    expect(log.records).toHaveLength(1);
    const entry = log.records[0]!;
    expect(entry.risk).toMatchObject({ allowed: false, code: "POSITION_TOO_LARGE" });
    expect(entry.reason).toBe("Strong breakout, going large.");
    expect(entry.outcome).toBeUndefined();
  });

  it("records a close with its reason", async () => {
    const log = new MemoryDecisionLog();
    const { deps } = setup(log);
    await closePosition(deps, { symbol: "BTC", reason: "Thesis invalidated." });

    expect(log.records[0]).toMatchObject({
      tool: "close_position",
      reason: "Thesis invalidated.",
    });
  });

  it("records an exchange failure against the attempt", async () => {
    const log = new MemoryDecisionLog();
    const { deps, transport } = setup(log);
    // Only the exchange is down. Account and book reads still work, so the
    // decision is fully formed before the send fails — which is the case the
    // record is meant to capture.
    transport.failRoute("exchange:order", 503, "upstream down");

    await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 1_000,
      price: 100_000,
      reason: "r",
    });

    expect(log.records).toHaveLength(1);
    expect(log.records[0]!.error).toContain("503");
  });
});

describe("when the log itself fails", () => {
  it("does NOT report a placed order as failed", async () => {
    // The dangerous case: an agent told its order failed will place it again,
    // so a lost log line must never become a doubled position.
    const { deps, transport } = setup(new BrokenLog());
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 5_000,
      price: 100_000,
      reason: "r",
    });

    expect(result.isError).toBeUndefined();
    expect(transport.callsTo("exchange:order")).toHaveLength(1);
  });

  it("surfaces the failure as a warning on the result", async () => {
    const { deps } = setup(new BrokenLog());
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 5_000,
      price: 100_000,
      reason: "r",
    });

    expect(text(result)).toContain("disk full");
  });

  it("still reports a blocked order as blocked", async () => {
    const { deps } = setup(new BrokenLog());
    const result = await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 90_000,
      price: 100_000,
      reason: "r",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("BLOCKED");
    expect(text(result)).toContain("disk full");
  });
});

describe("get_recent_decisions", () => {
  it("returns recent records, most recent first", async () => {
    const log = new MemoryDecisionLog();
    const { deps } = setup(log);
    await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 1_000,
      price: 100_000,
      reason: "first",
    });
    await placeOrder(deps, {
      symbol: "BTC",
      side: "buy",
      sizeUsd: 90_000,
      price: 100_000,
      reason: "second, refused",
    });

    const body = JSON.parse(text(await getRecentDecisions(deps, {}))) as {
      decisions: DecisionRecord[];
    };
    expect(body.decisions.map((d) => d.reason)).toEqual(["second, refused", "first"]);
  });

  it("says so plainly when no log is configured", async () => {
    const { deps } = setup();
    const body = JSON.parse(text(await getRecentDecisions(deps, {}))) as {
      decisions: unknown[];
      detail: string;
    };
    expect(body.decisions).toEqual([]);
    expect(body.detail).toContain("No decision log");
  });
});
