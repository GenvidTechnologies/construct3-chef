import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Delete all files matching `extension` in `outDir` (recursive),
 * then prune empty directories bottom-up.
 *
 * No-op if `outDir` does not exist.
 */
export function cleanOwnedFiles(outDir: string, extension: string): void {
  if (!existsSync(outDir)) return;

  const entries = readdirSync(outDir, { recursive: true, encoding: "utf-8" });

  for (const entry of entries) {
    if (entry.endsWith(extension)) {
      rmSync(path.join(outDir, entry), { force: true });
    }
  }

  // Prune empty directories bottom-up
  const dirs = entries
    .map((e) => path.join(outDir, e))
    .filter((p) => existsSync(p) && statSync(p).isDirectory())
    .reverse();
  for (const d of dirs) {
    if (readdirSync(d).length === 0) rmSync(d, { recursive: true });
  }
}
