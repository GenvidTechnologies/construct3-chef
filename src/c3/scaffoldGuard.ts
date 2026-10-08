/**
 * Pre-write refusal shared by both scaffold surfaces (`scaffold-layout` and
 * `scaffold-sprite`, CLI and MCP), so their refusal output is byte-identical.
 * It finds anything the scaffold would overwrite or collide with, before any
 * write happens. Same precedent as `checkCreateTargets` (#249) and ADR
 * `wiki/decisions/0043`; see issue #254.
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts` (a barrel
 * export is a permanent public-API commitment).
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { find_all_layouts_path, find_all_objectTypes_path } from "@genvidtech/c3source";
import { discoverAndPlanImageCopies } from "./spriteScaffold.js";

export type ScaffoldConflictReason = "output-exists" | "layout-name" | "objectType-name" | "image-target";

export interface ScaffoldConflict {
  /** POSIX path relative to the project root. */
  relPath: string;
  reason: ScaffoldConflictReason;
}

interface Found {
  abs: string;
  reason: ScaffoldConflictReason;
}

const REASON_TEXT: Record<ScaffoldConflictReason, string> = {
  "output-exists": "the output file already exists",
  "layout-name": "a layout with this file name already exists",
  "objectType-name": "an objectType with this name already exists",
  "image-target": "an image this scaffold would copy already exists",
};

const REASON_RANK: Record<ScaffoldConflictReason, number> = {
  "output-exists": 0,
  "layout-name": 1,
  "objectType-name": 1,
  "image-target": 2,
};

/** Dedupe by resolved path (first/highest-priority reason wins), then order by reason rank and relPath. */
function finish(rootDir: string, found: Found[]): ScaffoldConflict[] {
  const seen = new Set<string>();
  const out: ScaffoldConflict[] = [];
  for (const { abs, reason } of found) {
    const key = path.resolve(abs).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ relPath: path.relative(rootDir, abs).split(path.sep).join("/"), reason });
  }
  return out.sort(
    (a, b) =>
      REASON_RANK[a.reason] - REASON_RANK[b.reason] || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0),
  );
}

/**
 * Conflicts for a layout scaffold writing to `outPath`.
 *
 * - `output-exists` if `outPath` already exists.
 * - `layout-name` for any c3source `find_all_layouts_path(layoutsDir)` entry
 *   with the same basename as `outPath`.
 *
 * Results are deduped and ordered deterministically; `relPath` is a POSIX
 * path relative to `rootDir`.
 */
export function findLayoutScaffoldConflicts(rootDir: string, layoutsDir: string, outPath: string): ScaffoldConflict[] {
  const found: Found[] = [];
  if (existsSync(outPath)) found.push({ abs: outPath, reason: "output-exists" });
  if (existsSync(layoutsDir)) {
    const base = path.basename(outPath);
    for (const p of find_all_layouts_path(layoutsDir)) {
      if (path.basename(p) === base) found.push({ abs: p, reason: "layout-name" });
    }
  }
  return finish(rootDir, found);
}

/**
 * Conflicts for a sprite scaffold cloning `sourceName` to `targetName`.
 *
 * - `output-exists` if `objectTypes/<targetName>.json` exists.
 * - `objectType-name` for any `find_all_objectTypes_path` entry whose
 *   basename is `<targetName>.json` (case-sensitive).
 * - `image-target` for each existing target of `discoverAndPlanImageCopies`,
 *   when `imagesDir` exists.
 *
 * Results are deduped and ordered deterministically; `relPath` is a POSIX
 * path relative to `rootDir`.
 */
export function findSpriteScaffoldConflicts(
  rootDir: string,
  objectTypesDir: string,
  imagesDir: string,
  sourceName: string,
  targetName: string,
): ScaffoldConflict[] {
  const found: Found[] = [];
  const flat = path.join(objectTypesDir, `${targetName}.json`);
  if (existsSync(flat)) found.push({ abs: flat, reason: "output-exists" });
  if (existsSync(objectTypesDir)) {
    for (const p of find_all_objectTypes_path(objectTypesDir)) {
      if (path.basename(p) === `${targetName}.json`) found.push({ abs: p, reason: "objectType-name" });
    }
  }
  if (existsSync(imagesDir)) {
    for (const { targetPath } of discoverAndPlanImageCopies(imagesDir, sourceName, targetName)) {
      if (existsSync(targetPath)) found.push({ abs: targetPath, reason: "image-target" });
    }
  }
  return finish(rootDir, found);
}

/** Render the shared refusal message for `tool` listing every conflict. */
export function formatScaffoldRefusal(
  tool: "scaffold-layout" | "scaffold-sprite",
  conflicts: ScaffoldConflict[],
): string {
  const lines = conflicts.map((c) => `  - ${c.relPath} (${REASON_TEXT[c.reason]})`).join("\n");
  return (
    `${tool} refused: ${conflicts.length} conflicting path(s) already exist on disk, and ${tool} never overwrites existing project files. Nothing was written.\n` +
    lines +
    `\nChoose a different ${tool === "scaffold-layout" ? "output file name" : "name"}.`
  );
}
