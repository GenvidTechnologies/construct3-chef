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
 * Whether the overlay matches paths with letter case ignored. It must agree
 * with the filesystem it stands in front of: on Windows and macOS (default
 * NTFS/APFS) `Foo.json` and `foo.json` name one file, so an overlay that told
 * them apart would let a recipe CREATE `foo` after `Foo` and overwrite it on
 * replay, where the on-disk apply SKIPped. A case-sensitive volume on those
 * platforms over-folds, which only turns that second CREATE into a SKIP.
 */
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

/**
 * In-memory overlay over disk. Writes are captured (text fixed at call time)
 * and never touch disk; `mkdir` is recorded, never performed. Paths are
 * `path.resolve`d and, where the filesystem is case-insensitive, matched with
 * case folded ({@link FOLD_CASE}); each entry keeps the spelling it was
 * written with.
 */
export class OverlayIo implements SourceIo {
  readonly #files = new Map<string, { abs: string; text: string }>();
  readonly #journal: JournalEntry[] = [];

  get journal(): ReadonlyArray<JournalEntry> {
    return this.#journal;
  }

  static #key(abs: string): string {
    const resolved = path.resolve(abs);
    return FOLD_CASE ? resolved.toLowerCase() : resolved;
  }

  readText(abs: string): string {
    const hit = this.#files.get(OverlayIo.#key(abs));
    return hit !== undefined ? hit.text : readFileSync(abs, "utf-8");
  }

  exists(abs: string): boolean {
    return this.#files.has(OverlayIo.#key(abs)) || existsSync(abs);
  }

  writeText(abs: string, text: string, opts?: { mkdir?: boolean }): void {
    const key = OverlayIo.#key(abs);
    // A later write to the same file keeps the first spelling, as the disk would.
    this.#files.set(key, { abs: this.#files.get(key)?.abs ?? path.resolve(abs), text });
    this.#journal.push({ kind: "write", abs, text, mkdir: opts?.mkdir === true });
  }

  listObjectTypeFiles(objectTypesDir: string): string[] {
    const result = existsSync(objectTypesDir) ? [...find_all_objectTypes_path(objectTypesDir)] : [];
    const seen = new Set(result.map((p) => OverlayIo.#key(p)));
    const root = path.resolve(objectTypesDir);
    for (const [key, { abs }] of this.#files) {
      if (!isSectionItemName(abs) || seen.has(key)) continue;
      const rel = path.relative(root, abs);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (isEditorLocalPathUnder(root, abs)) continue;
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
