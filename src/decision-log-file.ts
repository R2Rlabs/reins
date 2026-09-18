import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DecisionLog, DecisionRecord } from "./decision-log.js";

/**
 * A JSON Lines decision log.
 *
 * One self-contained JSON object per line, appended and never rewritten. That
 * buys three things a single JSON array would not: appends stay cheap as the
 * file grows, a truncated write damages one line rather than the whole file,
 * and the result is queryable with ordinary tools — every refusal and the
 * reason the agent gave for it:
 *
 *     jq -r 'select(.risk.allowed == false) | [.time, .risk.code, .reason] | @tsv' \
 *       decisions.jsonl
 *
 * Kept out of `decision-log.ts` so the core types stay free of Node built-ins.
 */
export class FileDecisionLog implements DecisionLog {
  private readonly path: string;
  private ensured = false;
  /** Appends run one at a time so two concurrent writes cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  append(record: DecisionRecord): Promise<void> {
    const write = async () => {
      if (!this.ensured) {
        await mkdir(dirname(this.path), { recursive: true });
        this.ensured = true;
      }
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    };
    const result = this.queue.then(write, write);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async read(limit: number): Promise<DecisionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const out: DecisionRecord[] = [];
    // Walk backwards so reading the tail of a long log stays cheap, and skip
    // any line that will not parse rather than failing the whole read — a
    // half-written final line should not hide the history behind it.
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as DecisionRecord);
      } catch {
        continue;
      }
    }
    return out;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
