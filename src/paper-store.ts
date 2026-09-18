import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PaperState, PaperStore } from "./paper.js";

/**
 * A paper account that survives restarts.
 *
 * Kept out of `paper.ts` so the simulator itself stays free of Node built-ins
 * and can run anywhere. Writes go to a temporary file and are renamed into
 * place, so a crash mid-write cannot leave a half-written run behind — two
 * weeks of paper history is worth the extra syscall.
 */
export class FilePaperStore implements PaperStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<PaperState | undefined> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as PaperState;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new Error(
        `Could not read the paper account at ${this.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async save(state: PaperState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.path);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
