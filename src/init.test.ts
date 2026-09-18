import { resolve } from "node:path";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILDER_FEE_TENTHS_BPS,
  launchCommand,
  mergeConfig,
  parseInitArgs,
  REINS_BUILDER_ADDRESS,
  runInit,
  serverEntry,
  type InitDeps,
} from "./init.js";

const cwd = resolve("/work/project");
const node = { command: "node", args: ["/opt/reins/dist/bin/cli.js", "serve"] };

describe("parseInitArgs", () => {
  it("defaults to the landing page's paper setup", () => {
    const opts = parseInitArgs([]);
    expect(opts).toMatchObject({
      symbols: ["BTC", "ETH"],
      maxPositionUsd: 5_000,
      dailyLossUsd: 500,
      maxLeverage: 3,
      maxOrdersPerMinute: 12,
      balanceUsd: 10_000,
      network: "testnet",
      logFile: "./decisions.jsonl",
      configFile: "./.mcp.json",
      print: false,
      force: false,
    });
  });

  it("takes overrides and normalises symbols", () => {
    const opts = parseInitArgs([
      "--symbols", " sol, btc,SOL ,",
      "--max-position", "25_000",
      "--daily-loss", "1,500",
      "--network", "mainnet",
      "--print",
    ]);
    expect(opts.symbols).toEqual(["SOL", "BTC"]);
    expect(opts.maxPositionUsd).toBe(25_000);
    expect(opts.dailyLossUsd).toBe(1_500);
    expect(opts.network).toBe("mainnet");
    expect(opts.print).toBe(true);
  });

  it.each([
    [["--max-position", "lots"], /--max-position must be a positive number/],
    [["--daily-loss", "0"], /--daily-loss must be a positive number/],
    [["--max-leverage=-2"], /--max-leverage must be a positive number/],
    [["--balance", ""], /--balance must be a positive number/],
    [["--max-orders", "2.5"], /--max-orders must be a whole number/],
    [["--symbols", " , "], /empty allowlist/],
    [["--network", "devnet"], /--network must be/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseInitArgs(argv)).toThrow(message);
  });

  it("rejects unknown flags rather than ignoring them", () => {
    expect(() => parseInitArgs(["--mode", "live"])).toThrow();
    expect(() => parseInitArgs(["--private-key", "0xabc"])).toThrow();
  });
});

describe("the builder fee", () => {
  const address = "0x1111111111111111111111111111111111111111";

  it("is only ever empty or a correctly checksummed address", () => {
    // A mistyped character here would pay the fees to nobody. The mixed-case
    // checksum catches that; lowercase would not.
    if (REINS_BUILDER_ADDRESS !== "") {
      expect(getAddress(REINS_BUILDER_ADDRESS)).toBe(REINS_BUILDER_ADDRESS);
    }
  });

  it("defaults to 2 bp, in tenths as Hyperliquid wants it", () => {
    expect(parseInitArgs([]).builderFeeTenthsBps).toBe(20);
    expect(DEFAULT_BUILDER_FEE_TENTHS_BPS).toBe(20);
  });

  it("takes a fee in basis points, down to 0.1 bp", () => {
    expect(parseInitArgs(["--builder-fee", "2.5"]).builderFeeTenthsBps).toBe(25);
    expect(parseInitArgs(["--builder-fee", "1.1"]).builderFeeTenthsBps).toBe(11);
    expect(parseInitArgs(["--builder-fee", "10"]).builderFeeTenthsBps).toBe(100);
  });

  it.each([
    [["--builder-fee", "10.5"], /at most 10 bp/],
    [["--builder-fee", "1.25"], /steps of 0.1 bp/],
    [["--builder-fee", "0"], /positive number/],
    [["--builder-fee", "2", "--no-builder-fee"], /contradict/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseInitArgs(argv)).toThrow(message);
  });

  it("goes into the entry when there is an address to pay", () => {
    const entry = serverEntry(parseInitArgs([]), node, cwd, address);
    expect(entry.env).toMatchObject({
      REINS_BUILDER_ADDRESS: address,
      REINS_BUILDER_FEE_TENTHS_BPS: "20",
    });
  });

  it("is left out with --no-builder-fee, or while there is no address", () => {
    const optedOut = serverEntry(parseInitArgs(["--no-builder-fee"]), node, cwd, address);
    const noAddress = serverEntry(parseInitArgs([]), node, cwd, "");
    for (const entry of [optedOut, noAddress]) {
      expect(entry.env).not.toHaveProperty("REINS_BUILDER_ADDRESS");
      expect(entry.env).not.toHaveProperty("REINS_BUILDER_FEE_TENTHS_BPS");
    }
  });
});

describe("launchCommand", () => {
  it("points node at the script when installed", () => {
    expect(launchCommand("/opt/reins/dist/bin/cli.js", "linux")).toEqual(node);
  });

  it("goes back through npx when run from npx's cache", () => {
    const cached = "/home/u/.npm/_npx/1a2b/node_modules/reins/dist/bin/cli.js";
    expect(launchCommand(cached, "darwin")).toEqual({
      command: "npx",
      args: ["-y", "reins", "serve"],
    });
  });

  it("wraps npx in cmd on Windows", () => {
    const cached = "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\reins\\dist\\bin\\cli.js";
    expect(launchCommand(cached, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "reins", "serve"],
    });
  });
});

describe("serverEntry", () => {
  const entry = serverEntry(parseInitArgs([]), node, cwd);

  it("is paper mode and carries no key", () => {
    expect(entry.env["REINS_MODE"]).toBe("paper");
    expect(Object.keys(entry.env).some((k) => k.includes("KEY"))).toBe(false);
  });

  it("carries every limit serve.ts requires", () => {
    expect(entry.env).toMatchObject({
      REINS_SYMBOLS: "BTC,ETH",
      REINS_MAX_POSITION_USD: "5000",
      REINS_DAILY_LOSS_USD: "500",
      REINS_MAX_LEVERAGE: "3",
      REINS_MAX_ORDERS_PER_MIN: "12",
      REINS_PAPER_BALANCE: "10000",
    });
  });

  it("makes file paths absolute, since clients pick their own cwd", () => {
    expect(entry.env["REINS_LOG_FILE"]).toBe(resolve(cwd, "decisions.jsonl"));
    expect(entry.env["REINS_PAPER_FILE"]).toBe(resolve(cwd, "paper-run.json"));
  });
});

describe("mergeConfig", () => {
  const entry = serverEntry(parseInitArgs([]), node, cwd);

  it("creates a config from nothing", () => {
    expect(JSON.parse(mergeConfig(undefined, entry, false, ".mcp.json"))).toEqual({
      mcpServers: { reins: entry },
    });
  });

  it("keeps other servers and top-level keys", () => {
    const existing = JSON.stringify({ other: 1, mcpServers: { github: { command: "gh" } } });
    expect(JSON.parse(mergeConfig(existing, entry, false, ".mcp.json"))).toEqual({
      other: 1,
      mcpServers: { github: { command: "gh" }, reins: entry },
    });
  });

  it("will not replace an existing reins entry without --force", () => {
    const existing = JSON.stringify({ mcpServers: { reins: { command: "old" } } });
    expect(() => mergeConfig(existing, entry, false, ".mcp.json")).toThrow(/--force/);
    expect(JSON.parse(mergeConfig(existing, entry, true, ".mcp.json")).mcpServers.reins).toEqual(entry);
  });

  it("leaves unreadable configs alone", () => {
    expect(() => mergeConfig("{ nope", entry, false, ".mcp.json")).toThrow(/not valid JSON/);
    expect(() => mergeConfig("[]", entry, false, ".mcp.json")).toThrow(/JSON object/);
    expect(() => mergeConfig('{"mcpServers": 3}', entry, false, ".mcp.json")).toThrow(
      /"mcpServers" .* not an object/,
    );
  });
});

describe("runInit", () => {
  function fakeDeps(files: Record<string, string> = {}) {
    const output: string[] = [];
    const deps: InitDeps = {
      cwd,
      scriptPath: "/opt/reins/dist/bin/cli.js",
      platform: "linux",
      readFile: async (path) => files[path],
      writeFile: async (path, content) => {
        files[path] = content;
      },
      out: (text) => output.push(text),
    };
    return { deps, files, output: () => output.join("") };
  }

  it("writes .mcp.json and says what it set up", async () => {
    const { deps, files, output } = fakeDeps();
    await runInit([], deps);

    const written = JSON.parse(files[resolve(cwd, ".mcp.json")]!);
    expect(written.mcpServers.reins.env.REINS_MODE).toBe("paper");
    expect(output()).toContain("✓ Limits — max position $5,000 · daily loss $500 · BTC, ETH");
    expect(output()).toContain("decisions.jsonl");
    expect(output()).toContain("Created");
    expect(output()).toContain("9 tools on stdio");
  });

  it("refuses to clobber an existing reins entry and writes nothing", async () => {
    const path = resolve(cwd, ".mcp.json");
    const before = JSON.stringify({ mcpServers: { reins: { command: "mine" } } });
    const { deps, files } = fakeDeps({ [path]: before });
    await expect(runInit([], deps)).rejects.toThrow(/--force/);
    expect(files[path]).toBe(before);
  });

  it("says when a builder fee is on and how to remove it", async () => {
    const { deps, output } = fakeDeps();
    await runInit(["--builder-fee", "2"], { ...deps, builderAddress: "0x2222222222222222222222222222222222222222" });
    expect(output()).toContain("✓ Builder fee — 2 bp to Reins on live orders; paper results include it");
    expect(output()).toContain("--no-builder-fee");
  });

  it("says nothing about a fee when none is charged", async () => {
    const { deps, output } = fakeDeps();
    await runInit([], { ...deps, builderAddress: "" });
    expect(output()).not.toContain("Builder fee");
  });

  it("--print writes no file", async () => {
    const { deps, files, output } = fakeDeps();
    await runInit(["--print"], deps);
    expect(files).toEqual({});
    expect(JSON.parse(output()).mcpServers.reins.command).toBe("node");
  });
});
