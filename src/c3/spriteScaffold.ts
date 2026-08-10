import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { mintUniqueSid } from "./sidUtils.js";
import { walkFiles } from "@genvidtech/mcp-utils";
import { isEditorLocalPathUnder } from "./editorLocal.js";

// SID generation lives in ./sidUtils.js — `mintUniqueSid(existingSids)` enforces the
// strict [1e14, 1e15) range with a 100-attempt collision cap. The historical local
// `generateUniqueSid` here had range [0, 1e15) (could return SID 0, documented as
// unsafe in the initiative) and an unbounded retry loop.

// ─── File utilities ───

/**
 * Recursively collect project-*source* `.json` file paths under `objectTypesDir`,
 * excluding every `EDITOR_LOCAL_EXCLUSIONS` dimension (a `uistate/`/`ts-defs/`
 * directory segment, a `*.uistate.json` basename, or an exact `tsconfig.json`
 * basename) via the shared segment-wise classifier `isEditorLocalPathUnder`.
 *
 * This private helper is deliberately named to avoid the name it used to
 * share with `generators.ts`'s barrel-exported, deliberately *unfiltered*
 * file-JSON collector (see `generators.ts:540`; ADR 0016 §3 declined changing
 * that one). That byte-identical name is the documented cause of #149's
 * original wrong premise ("a second private copy to dedup" — corrected at
 * triage); the rename below removes the collision. This helper is NOT the
 * same function as that barrel-exported one.
 *
 * Deliberately stays on mcp-utils' `walkFiles` rather than a c3source named
 * collector (e.g. `find_all_objectTypes_path`): callers' contract is a bare
 * directory and both callers are barrel-exported at 1.0.0, so they depend on
 * `walkFiles`' missing-dir → `[]` degrade — `find_all_objectTypes_path` has no
 * `existsSync` guard and would newly *throw*. See ADR
 * `docs/decisions/0019-two-walk-primitives-one-classification-rule.md`.
 *
 * The predicate alone (not a `descend` rule) does the whole job: `walkFiles`
 * passes the *full path* to the predicate, so `walkFiles` still *enters*
 * `uistate/`/`ts-defs/` but classification is complete regardless — ADR 0016's
 * "reachability is not classification" lesson cuts the *other* way for a
 * path-predicate walk like this one.
 */
function findSourceJsonFiles(dir: string): string[] {
  return walkFiles(dir, (p) => p.endsWith(".json") && !isEditorLocalPathUnder(dir, p));
}

// ─── SID collection from objectTypes ───

/** Recursively collect all imageSpriteId values from a parsed objectType JSON */
function collectImageSpriteIds(obj: unknown, ids: Set<number>): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectImageSpriteIds(item, ids);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "imageSpriteId" && typeof value === "number") {
      ids.add(value);
    } else {
      collectImageSpriteIds(value, ids);
    }
  }
}

/** Recursively collect all SID values from a parsed objectType JSON */
function collectObjectTypeSids(obj: unknown, sids: Set<number>): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectObjectTypeSids(item, sids);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "sid" && typeof value === "number") {
      sids.add(value);
    } else if (key !== "imageSpriteId") {
      collectObjectTypeSids(value, sids);
    }
  }
}

/**
 * Collect all existing SIDs from all objectType JSON files.
 * Returns a Set of all SIDs found.
 */
export function collectAllObjectTypeSids(objectTypesDir: string): Set<number> {
  const files = findSourceJsonFiles(objectTypesDir);
  const sids = new Set<number>();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    collectObjectTypeSids(parsed, sids);
  }
  return sids;
}

/**
 * Collect max imageSpriteId from all objectType JSON files.
 * Returns the maximum imageSpriteId found, or 0 if none exist.
 */
export function collectMaxImageSpriteId(objectTypesDir: string): number {
  const files = findSourceJsonFiles(objectTypesDir);
  const ids = new Set<number>();
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    collectImageSpriteIds(parsed, ids);
  }
  return ids.size > 0 ? Math.max(...ids) : 0;
}

// ─── Image discovery and renaming ───

/**
 * Discover all image files associated with a source objectType by naming convention.
 * Images follow the pattern: <sourcename-lowercase>-*.png (case-insensitive glob).
 * Returns an array of { sourcePath, targetPath } pairs.
 *
 * Deliberately left unfiltered for editor-local exclusion (its flat `readdirSync`
 * below has no `isEditorLocalPathUnder` check): `images/` is not C3 project
 * *source* — it's absent from `sourceWatcher.SOURCE_DIRS` and `SID_SOURCE_DIRS`,
 * and c3source models it separately via `C3Project.imagesDir`/`detectImageDrift`.
 * Every `EDITOR_LOCAL_EXCLUSIONS` dimension is also structurally unreachable
 * through the `startsWith(prefix + "-") && endsWith(".png")` filter below:
 * `.uistate.json` and `tsconfig.json` basenames both fail the `.png` suffix
 * check, and the `dirs` dimension would need recursion this flat walk doesn't
 * have. See ADR `docs/decisions/0019-two-walk-primitives-one-classification-rule.md`.
 *
 * Name-matched entries are additionally confirmed to be regular files via
 * `statSync(...).isFile()` (which follows symlinks) before being planned as a
 * copy source, because a directory or junction that happens to match the glob
 * (e.g. a directory literally named `storybookicon-anything.png`) would
 * otherwise reach `copyFileSync` and crash with a raw `EISDIR`. This is
 * deliberately NOT `entry.isFile()` off a `{ withFileTypes: true }` dirent —
 * that silently *drops* a symlink pointing at a real `.png`, which copies
 * fine today — and NOT `!entry.isDirectory()` (the form mcp-utils' `walkFiles`
 * uses) — that lets a junction pointing at a directory through, since a
 * junction dirent reports `isSymbolicLink(): true` with *both* `isDirectory()`
 * and `isFile()` false, so `!isDirectory()` admits it and `copyFileSync` still
 * hits `EISDIR`. Only a resolved `statSync` answers the question that actually
 * matters — "will `copyFileSync` succeed on this path?". The stat clause is
 * ordered last in the filter so it only runs against entries that already
 * matched the cheap name check.
 */
export function discoverAndPlanImageCopies(
  imagesDir: string,
  sourceName: string,
  targetName: string,
): Array<{ sourcePath: string; targetPath: string; sourceBasename: string; targetBasename: string }> {
  const sourcePrefix = sourceName.toLowerCase();
  const targetPrefix = targetName.toLowerCase();

  const matches = readdirSync(imagesDir).filter(
    (f) =>
      f.toLowerCase().startsWith(sourcePrefix + "-") &&
      f.toLowerCase().endsWith(".png") &&
      statSync(path.join(imagesDir, f), { throwIfNoEntry: false })?.isFile() === true,
  );
  return matches.map((basename) => {
    const suffix = basename.slice(sourcePrefix.length); // e.g., "-animation 1-000.png"
    const targetBasename = targetPrefix + suffix;
    return {
      sourcePath: path.join(imagesDir, basename),
      targetPath: path.join(imagesDir, targetBasename),
      sourceBasename: basename,
      targetBasename,
    };
  });
}

// ─── cloneSprite ───

/** Remap all imageSpriteId values in the deep-copied JSON, assigning sequential IDs from nextId. */
function remapImageSpriteIds(obj: unknown, nextId: number): number {
  if (obj === null || typeof obj !== "object") return nextId;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      nextId = remapImageSpriteIds(item, nextId);
    }
    return nextId;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "imageSpriteId" && typeof record[key] === "number") {
      record[key] = nextId++;
    } else {
      nextId = remapImageSpriteIds(record[key], nextId);
    }
  }
  return nextId;
}

/** Remap all SID values in the deep-copied JSON using the provided sidMap. */
function remapSids(obj: unknown, sidMap: Map<number, number>): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      remapSids(item, sidMap);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "sid" && typeof record[key] === "number") {
      record[key] = sidMap.get(record[key] as number) ?? record[key];
    } else if (key !== "imageSpriteId") {
      remapSids(record[key], sidMap);
    }
  }
}

/**
 * Clone a source objectType JSON, remapping all SIDs and imageSpriteIds for uniqueness.
 * Returns new objectType JSON (does not write to disk).
 */
export function cloneSprite(
  source: Record<string, unknown>,
  opts: {
    name: string;
    /** All SIDs that already exist across ALL objectTypes (to avoid collision) */
    existingSids: Set<number>;
    /** The next imageSpriteId to use (typically maxExistingImageSpriteId + 1) */
    nextImageSpriteId: number;
  },
): Record<string, unknown> {
  // 1. Deep-copy source JSON
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;

  // 2. Build SID remapping — collect source SIDs and generate new ones
  const sourceSids = new Set<number>();
  collectObjectTypeSids(source, sourceSids);

  const allExistingSids = new Set<number>(opts.existingSids);
  // Include source SIDs so we don't accidentally collide within the source set
  for (const sid of sourceSids) {
    allExistingSids.add(sid);
  }

  const sidMap = new Map<number, number>();
  for (const oldSid of sourceSids) {
    sidMap.set(oldSid, mintUniqueSid(allExistingSids));
  }

  // 3. Update name
  clone.name = opts.name;

  // 4. Apply SID remapping
  remapSids(clone, sidMap);

  // 5. Apply imageSpriteId remapping
  remapImageSpriteIds(clone, opts.nextImageSpriteId);

  return clone;
}
