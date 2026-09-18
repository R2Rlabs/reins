/**
 * Turns a demo run into a summary you can post.
 *
 *   npm run demo:report
 *   npm run demo:report -- --data-dir demo-data/scripted
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { PaperState } from "../../src/paper.js";
import { formatReport, parseDecisionLog, summarize } from "./lib.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "data-dir": { type: "string", default: "demo-data" } } });
  const dataDir = resolve(REPO_ROOT, values["data-dir"]);

  const log = await readOptional(join(dataDir, "decisions.jsonl"));
  if (log === undefined) {
    console.log(`No decision log in ${dataDir} yet. Run the demo first: npm run demo`);
    return;
  }

  const paperRaw = await readOptional(join(dataDir, "paper-account.json"));
  const paper = paperRaw ? (JSON.parse(paperRaw) as PaperState) : undefined;
  const spendRaw = await readOptional(join(dataDir, "spend.json"));
  const spend = spendRaw ? (JSON.parse(spendRaw) as { spentUsd: number; calls: number }) : undefined;

  // The paper account does not store its opening balance, but every change to
  // it is a fill, so it can be recovered exactly by undoing them.
  const opening = paper
    ? paper.fills.reduce((balance, f) => balance - f.realizedPnlUsd + f.feeUsd, paper.balanceUsd)
    : 0;

  console.log(formatReport(summarize(parseDecisionLog(log)), paper, opening, spend));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
