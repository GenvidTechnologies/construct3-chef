import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "@genvidtech/mcp-utils";
import { find_all_objectTypes_path, isSectionItemName } from "@genvidtech/c3source";
import { isEditorLocalPathUnder } from "./editorLocal.js";

/**
 * The seam between recipe application and the filesystem for C3 **source**
 * files. `diskIo` is today's behaviour (write immediately); `OverlayIo`
 * captures writes in memory so a whole apply can be validated before any
 * byte reaches disk.
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts` (repo is at
 * 1.0.0, and a barrel export is a permanent public-API commitment). Internal
 * plumbing, same pattern as `sourceJson.ts` / `editorLocal.ts`.
 */
export interface SourceIo {
  /** Overlay content if present, else the file on disk (utf-8). */
  readText(abs: string): string;
  /** True if the path is in the overlay or on disk. */
  exists(abs: string): boolean;
  writeText(abs: string, text: string, opts?: { mkdir?: boolean }): void;
  /**
   * Absolute-or-relative paths (same form as the `objectTypesDir` argument,
   * joined with `path.join`, exactly as c3source's `find_all_objectTypes_path`
   * returns them) of every objectType `.json`: disk listing union overlay.
   */
  listObjectTypeFiles(objectTypesDir: string): string[];
}

/** Today's behaviour: every write lands on disk immediately. */
export const diskIo: SourceIo = {
  readText: (abs) => readFileSync(abs, "utf-8"),
  exists: (abs) => existsSync(abs),
  writeText(abs, text, opts) {
    if (opts?.mkdir) mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  },
  listObjectTypeFiles: (dir) => find_all_objectTypes_path(dir),
};

export type JournalEntry =
  | { kind: "log"; args: unknown[] }
  | { kind: "write"; abs: string; text: string; mkdir: boolean };

/**
 * In-memory overlay over disk. Writes are captured (text fixed at call time)
 * and never touch disk; `mkdir` is recorded, never performed. Keys are
 * `path.resolve`d; matching is case-sensitive even on Windows (callers pass
 * paths built the same way, so no case folding is attempted).
 */
export class OverlayIo implements SourceIo {
  readonly #files = new Map<string, string>();
  readonly #journal: JournalEntry[] = [];

  get journal(): ReadonlyArray<JournalEntry> {
    return this.#journal;
  }

  readText(abs: string): string {
    const hit = this.#files.get(path.resolve(abs));
    return hit !== undefined ? hit : readFileSync(abs, "utf-8");
  }

  exists(abs: string): boolean {
    return this.#files.has(path.resolve(abs)) || existsSync(abs);
  }

  writeText(abs: string, text: string, opts?: { mkdir?: boolean }): void {
    this.#files.set(path.resolve(abs), text);
    this.#journal.push({ kind: "write", abs, text, mkdir: opts?.mkdir === true });
  }

  listObjectTypeFiles(objectTypesDir: string): string[] {
    const result = existsSync(objectTypesDir) ? [...find_all_objectTypes_path(objectTypesDir)] : [];
    const seen = new Set(result.map((p) => path.resolve(p)));
    const root = path.resolve(objectTypesDir);
    for (const key of this.#files.keys()) {
      if (!isSectionItemName(key) || seen.has(key)) continue;
      const rel = path.relative(root, key);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (isEditorLocalPathUnder(root, key)) continue;
      result.push(path.join(objectTypesDir, rel));
      seen.add(key);
    }
    return result;
  }

  /** A Logger that appends to the journal instead of printing. */
  logger(): Logger {
    return (...args: unknown[]) => {
      this.#journal.push({ kind: "log", args });
    };
  }
}
