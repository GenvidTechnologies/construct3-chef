import * as path from "node:path";
import { isEditorLocalPath } from "@genvidtech/c3source";

/**
 * Segment-wise editor-local path classification. The classification rule
 * itself is c3source's `isEditorLocalPath` (`dirs`/`fileSuffixes`/
 * `exactNames` — see ADR `docs/decisions/0016-shared-file-walk-adoption-triage.md`),
 * which only classifies a single bare basename; this module applies it to
 * every segment of a path, which is what catches both a `uistate/`
 * *directory* segment and a `Foo.uistate.json` *sibling file* segment.
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts` (repo is at
 * 1.0.0, and a barrel export is a permanent public-API commitment). See ADR
 * `docs/decisions/0018-editor-local-writes-are-not-source-changes.md`.
 */

/**
 * True if any segment of `relativePath` is editor-local per
 * `isEditorLocalPath` (a `uistate/`/`ts-defs/` directory segment, a
 * `*.uistate.json` basename, or an exact `tsconfig.json` basename).
 *
 * Splits on `/[\\/]/`, not `path.sep` — the path may carry either
 * separator regardless of host platform.
 *
 * A path outside the root it was relativized against (leading `..`
 * segments) is not classified editor-local by any dimension, so it fails
 * open rather than being explicitly rejected — that case should not occur.
 */
export function hasEditorLocalSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => isEditorLocalPath(segment));
}

/**
 * Convenience wrapper: relativizes `absPath` against `root`, then delegates
 * to {@link hasEditorLocalSegment}.
 */
export function isEditorLocalPathUnder(root: string, absPath: string): boolean {
  return hasEditorLocalSegment(path.relative(root, absPath));
}
