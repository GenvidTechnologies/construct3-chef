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

export type ScaffoldConflictReason = "output-exists" | "layout-name" | "objectType-name" | "image-target";

export interface ScaffoldConflict {
  /** POSIX path relative to the project root. */
  relPath: string;
  reason: ScaffoldConflictReason;
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
export function findLayoutScaffoldConflicts(
  _rootDir: string,
  _layoutsDir: string,
  _outPath: string,
): ScaffoldConflict[] {
  // stub — implemented in the fix: commit (#254)
  return [];
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
  _rootDir: string,
  _objectTypesDir: string,
  _imagesDir: string,
  _sourceName: string,
  _targetName: string,
): ScaffoldConflict[] {
  // stub — implemented in the fix: commit (#254)
  return [];
}

/** Render the shared refusal message for `tool` listing every conflict. */
export function formatScaffoldRefusal(
  _tool: "scaffold-layout" | "scaffold-sprite",
  _conflicts: ScaffoldConflict[],
): string {
  // stub — implemented in the fix: commit (#254)
  return "";
}
