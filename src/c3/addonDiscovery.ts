import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWithin } from "@genvidtech/mcp-utils";

export const ADDON_DIRS = ["addons/plugin", "addons/effect", "addons/behavior"] as const;

export interface DiscoveredAddon {
  name: string; // addon name (archive basename without .c3addon)
  kind: "plugin" | "effect" | "behavior";
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
    const kind: "plugin" | "effect" | "behavior" =
      addonDir === "addons/plugin" ? "plugin" : addonDir === "addons/effect" ? "effect" : "behavior";
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

/**
 * Best-effort read of `<dir>/addon.json`'s `type` field to classify a
 * path-mode addon source tree. Returns "effect" or "behavior" only when the
 * field is exactly that value; anything else (missing file, malformed JSON,
 * absent or other `type` value) defaults to "plugin". Never throws.
 */
function readAddonKind(dir: string): "plugin" | "effect" | "behavior" {
  try {
    const raw = fs.readFileSync(path.join(dir, "addon.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const type = (parsed as { type?: unknown }).type;
      if (type === "effect") return "effect";
      if (type === "behavior") return "behavior";
    }
  } catch {
    // fall through to the "plugin" default
  }
  return "plugin";
}

/**
 * Resolve an `--addon` argument to a DiscoveredAddon in one of two modes:
 *
 * 1. id-mode: an addon discovered under addons/plugin|effect whose `name`
 *    matches `addonArg` exactly — delegates to {@link discoverAddons}.
 * 2. path-mode: a project-root-contained directory holding an addon source
 *    tree (addon.json + aces.json + optionally lang/ + plugin.js) with no
 *    `.c3addon` archive. Builds a synthetic DiscoveredAddon with
 *    `archivePath: ""` (signals "no real .c3addon package" — downstream
 *    package-integrity checks should skip when `archivePath === ""`).
 *
 * Returns `null` when neither mode resolves, or when the path-mode argument
 * escapes `projectRoot`. Never throws.
 */
export function resolveAddonTarget(projectRoot: string, addonArg: string): DiscoveredAddon | null {
  const byId = discoverAddons(projectRoot).find((a) => a.name === addonArg);
  if (byId !== undefined) return byId;

  try {
    const resolved = resolveWithin(projectRoot, addonArg);
    if (resolved === null) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;

    return {
      name: path.basename(resolved),
      kind: readAddonKind(resolved),
      archivePath: "",
      extractedDir: resolved,
    };
  } catch {
    return null;
  }
}
