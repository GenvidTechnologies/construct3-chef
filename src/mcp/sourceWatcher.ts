import * as fs from "node:fs";
import * as path from "node:path";
import {
  ObservedState,
  OptimisticWatcher,
  contentFingerprint,
  type ExpectedChanges,
  type WatcherFactory,
  type Logger,
} from "@genvidtech/mcp-utils";
import { isEditorLocalPathUnder } from "../c3/editorLocal.js";

/** Minimum ledger capacity (entries), whatever the watched tree's size. */
export const LEDGER_FLOOR = 10_000;
/** Ledger capacity as a multiple of the counted watched entries. */
export const LEDGER_HEADROOM = 4;

/**
 * Count the ledger entries a baseline walk of `watchTargets` records, mirroring
 * mcp-utils' `ObservedState.prime()`: a file target counts 1; a directory
 * target counts every file and every subdirectory at any depth (the root itself
 * does not count, and editor-local paths are included since prime does not
 * filter them). A symlinked directory counts 1 and is not descended. A missing
 * target counts 0. Fails open: an unreadable directory is skipped, since the
 * count only sizes a cap.
 */
export function countWatchedEntries(watchTargets: string[]): number {
  const walk = (dir: string): number => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let n = 0;
    for (const e of entries) {
      n++;
      if (e.isDirectory()) n += walk(path.join(dir, e.name));
    }
    return n;
  };
  let total = 0;
  for (const target of watchTargets) {
    let st: fs.Stats;
    try {
      st = fs.statSync(target);
    } catch {
      continue;
    }
    if (st.isFile()) total++;
    else if (st.isDirectory()) total += walk(target);
  }
  return total;
}

/** Ledger capacity for a watched tree of `counted` entries: never below {@link LEDGER_FLOOR}. */
export function ledgerCapacity(counted: number): number {
  return Math.max(LEDGER_FLOOR, LEDGER_HEADROOM * counted);
}

/**
 * Fingerprinter for the watcher's ledger that ignores editor-local files.
 *
 * Returns `"absent"` for a path where `isEditorLocalPathUnder(projectRoot, …)`
 * holds. `"absent"` is `contentFingerprint`'s ENOENT value, which the ledger
 * treats as "no live content": an editor-local file already in the ledger
 * therefore never reads as changed when edited or deleted, and never flips the
 * ledger lossy when evicted. A newly created one still reads as changed, because
 * the ledger judges a never-seen path before any fingerprint (#299). ADR 0018:
 * editor-local writes are not source changes.
 *
 * Any other path is hashed exactly as the default fingerprinter does, by
 * delegating to `contentFingerprint` unchanged.
 */
export function editorLocalAwareFingerprint(projectRoot: string): (filePath: string) => string {
  return (filePath) => (isEditorLocalPathUnder(projectRoot, filePath) ? "absent" : contentFingerprint(filePath));
}

/**
 * Classify a line the OptimisticWatcher passes to its logger as `(...args)`.
 * The baseline summary is info; an incomplete or failed baseline is a warning;
 * everything else is dropped (null). The args are joined with a space.
 */
export function routeWatcherLog(args: unknown[]): { level: "info" | "warning"; message: string } | null {
  const message = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : String(a))).join(" ");
  if (
    message.startsWith("OptimisticWatcher baseline incomplete") ||
    message.startsWith("OptimisticWatcher baseline failed")
  )
    return { level: "warning", message };
  if (message.startsWith("OptimisticWatcher baseline:")) return { level: "info", message };
  return null;
}

/** Source directories whose external edits invalidate extracted/ (mark it dirty). */
export const SOURCE_DIRS = ["eventSheets", "layouts", "objectTypes", "families", "scripts"] as const;

export interface SourceWatcherOptions {
  projectRoot: string;
  /** Shared ExpectedChanges registry; self-writes are registered via watcher.expect(). */
  expected: ExpectedChanges;
  /**
   * Invoked for an EXTERNAL change to a watched source directory (not
   * project.c3proj, and not an editor-local path — see ADR
   * `wiki/decisions/0018-editor-local-writes-are-not-source-changes.md`).
   * The watcher has already bumped txId; this is where the consumer marks
   * extracted/ dirty. NOT called for project.c3proj edits (bump txId only)
   * nor for editor-local edits (no bump, no call at all).
   */
  onSourceChange?: (filePath: string) => void;
  /** Injectable watcher factory (tests pass a stub). Defaults to fs.watch. */
  watcherFactory?: WatcherFactory;
  logger?: Logger;
}

/**
 * Default factory: fs.watch each target, firing the **native** absolute path
 * (`path.resolve`, NOT toPosixPath). This matches `OptimisticWatcher.expect()`,
 * which stores `path.resolve(filePath)` — keeping Layer-2 suppression working on
 * Windows, where the library's built-in toPosixPath factory would mismatch the
 * native-separator key. Handles both directories (recursive) and a single file
 * (project.c3proj), which fs.watch reports with the basename as `filename`.
 */
const fsWatchFactory: WatcherFactory = (target, onEvent) => {
  const isFile = fs.statSync(target).isFile();
  const watcher = fs.watch(target, { recursive: !isFile }, (_event, filename) => {
    if (isFile) {
      onEvent(path.resolve(target));
      return;
    }
    if (filename == null) return;
    onEvent(path.resolve(target, filename.toString()));
  });
  return { close: () => watcher.close() };
};

/**
 * Build an OptimisticWatcher over the project's source dirs + project.c3proj.
 *
 * - External source-dir change     → txId bump (by the watcher) + onSourceChange.
 * - External project.c3proj change → txId bump only (no onSourceChange).
 * - External editor-local path (any path segment matching c3source's
 *   `isEditorLocalPath` — a `uistate/`/`ts-defs/` dir, a `*.uistate.json`
 *   basename, or an exact `tsconfig.json` basename) → neither: dropped at the
 *   watcher factory before `OptimisticWatcher.handleEvent` ever sees it, so
 *   it bumps no txId and marks nothing dirty. See ADR
 *   `wiki/decisions/0018-editor-local-writes-are-not-source-changes.md`.
 * - Self-writes are masked by `expect()` (Layer 2), registered before each write;
 *   `suppress()` (Layer 1) only covers the async body, not later fs events. See
 *   `wiki/architecture/mcp-architecture.md` and ADR 0050.
 *
 * Only existing targets are watched (missing dirs are skipped, matching the old
 * setupWatchers behavior).
 */
export function createSourceWatcher(opts: SourceWatcherOptions): OptimisticWatcher {
  const c3projPath = path.resolve(opts.projectRoot, "project.c3proj");

  const watchDirs = SOURCE_DIRS.map((d) => path.join(opts.projectRoot, d)).filter((d) => fs.existsSync(d));
  if (fs.existsSync(c3projPath)) watchDirs.push(c3projPath);

  // Filter editor-local paths out BEFORE they reach OptimisticWatcher.handleEvent.
  // The ledger there decides whether an event is a change, and only a change
  // bumps txId and invokes onExternalChange — a filter placed inside
  // onExternalChange could suppress extractedDirty but not the bump.
  // Wraps the SELECTED factory (not just fsWatchFactory), so an injected test
  // stub is filtered too. See ADR 0018.
  const baseFactory = opts.watcherFactory ?? fsWatchFactory;
  const filteringFactory: WatcherFactory = (target, onEvent) =>
    baseFactory(target, (filename) => {
      if (!isEditorLocalPathUnder(opts.projectRoot, filename)) onEvent(filename);
    });

  return new OptimisticWatcher({
    watchDirs,
    expected: opts.expected,
    watcherFactory: filteringFactory,
    logger: opts.logger,
    // One ledger per call, i.e. per project context; sized from the watched tree.
    observed: new ObservedState({
      maxEntries: ledgerCapacity(countWatchedEntries(watchDirs)),
      fingerprint: editorLocalAwareFingerprint(opts.projectRoot),
    }),
    onExternalChange: (filePath) => {
      // project.c3proj bumps txId but does NOT mark extracted/ dirty.
      if (path.resolve(filePath) !== c3projPath) {
        opts.onSourceChange?.(filePath);
      }
    },
  });
}
