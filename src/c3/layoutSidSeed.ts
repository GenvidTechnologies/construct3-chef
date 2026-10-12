/**
 * Layout SID seeding for `applyParsed` (#253). Off-barrel.
 *
 * `applyParsed` unions the on-disk SIDs of every layout a recipe touches into the used-SID set. It must derive the
 * layout paths WITHOUT `normalizeRecipePaths`, which throws on (or collapses) bad keys before `validateRecipe`
 * reports them: an invalid key is skipped here, and the recipe op surfaces the real error later.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { collectLayoutSids } from "./layoutScaffold.js";
import { normalizeLayoutKey } from "./recipeInterpreter.js";
import { keyIssue } from "./recipeKeys.js";

/**
 * Deduped, canonical project-relative layout paths to seed SIDs from: each `layouts` key that {@link keyIssue}
 * accepts, mapped through `normalizeLayoutKey` (a bare `Gameplay/Main Layout` becomes
 * `layouts/Gameplay/Main Layout.json`). Rejected keys (`..`, absolute, empty) are skipped.
 */
export function layoutSeedPaths(layouts: Record<string, unknown> | undefined): string[] {
  const seen = new Set<string>();
  for (const key of Object.keys(layouts ?? {})) {
    if (keyIssue(key, "layouts")) continue;
    seen.add(normalizeLayoutKey(key));
  }
  return [...seen];
}

/**
 * Union into `used` the SIDs on disk in every layout the recipe touches. Same behaviour as the former inline loop
 * in `applyParsed` (missing or unparseable files are skipped) but over {@link layoutSeedPaths}. `readText` is
 * injectable so a test can assert which paths are read; it returns `undefined` for a missing file.
 */
export function seedLayoutSids(
  rootDir: string,
  layouts: Record<string, unknown> | undefined,
  used: Set<number>,
  readText: (fullPath: string) => string | undefined = (p) => (existsSync(p) ? readFileSync(p, "utf-8") : undefined),
): void {
  for (const layoutPath of layoutSeedPaths(layouts)) {
    try {
      const text = readText(path.join(rootDir, layoutPath));
      if (text === undefined) continue;
      for (const sid of collectLayoutSids(JSON.parse(text) as Record<string, unknown>)) used.add(sid);
    } catch {
      // Unparseable layout — skip the defensive seed; the recipe op will surface a real error.
    }
  }
}
