import { rmSync } from "node:fs";
import path from "node:path";

/** SID of `files/sample.gif` in the canonical fixture's `general` section. */
export const SAMPLE_GIF_SID = 542941095423235;

/**
 * Delete `files/sample.gif` from a fixture copy rooted at `root`, leaving its `general` manifest entry
 * (SID {@link SAMPLE_GIF_SID}) declared but absent from disk: the removal-only seed for #346.
 */
export function seedAbsentFile(root: string): void {
  rmSync(path.join(root, "files", "sample.gif"));
}
