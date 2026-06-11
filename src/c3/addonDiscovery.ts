import * as fs from "node:fs";
import * as path from "node:path";

export const ADDON_DIRS = ["addons/plugin", "addons/effect"] as const;

export interface DiscoveredAddon {
  name: string; // addon name (archive basename without .c3addon)
  kind: "plugin" | "effect";
  archivePath: string; // absolute path to the .c3addon file
  extractedDir: string | null; // absolute path to extracted folder if it exists & is a dir, else null
}

/**
 * Walk both ADDON_DIRS under projectRoot; for each existing dir, enumerate
 * *.c3addon files and build a DiscoveredAddon per archive. Returns unsorted
 * (caller sorts if needed).
 */
export function discoverAddons(projectRoot: string): DiscoveredAddon[] {
  const results: DiscoveredAddon[] = [];
  for (const addonDir of ADDON_DIRS) {
    const kind: "plugin" | "effect" = addonDir === "addons/plugin" ? "plugin" : "effect";
    const fullDir = path.join(projectRoot, addonDir);
    if (!fs.existsSync(fullDir)) continue;
    for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
      if (entry.name.endsWith(".c3addon") && entry.isFile()) {
        const name = entry.name.replace(/\.c3addon$/, "");
        const archivePath = path.join(fullDir, entry.name);
        const candidateDir = path.join(fullDir, name);
        const extractedDir =
          fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory() ? candidateDir : null;
        results.push({ name, kind, archivePath, extractedDir });
      }
    }
  }
  return results;
}

/**
 * Return the first path.join(projectRoot, addonDir, name) across both
 * ADDON_DIRS that exists and is a directory, or null if none found.
 * Does NOT require a matching .c3addon archive — only the directory.
 */
export function findAddonExtractedDir(projectRoot: string, name: string): string | null {
  for (const addonDir of ADDON_DIRS) {
    const candidate = path.join(projectRoot, addonDir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}
