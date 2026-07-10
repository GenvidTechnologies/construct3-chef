import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface UsedAddonEntry {
  type?: string;
  id?: string;
  name?: string;
  author?: string;
  version?: string;
  bundled?: boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read and parse `project.c3proj`'s `usedAddons` array into a `Map` keyed by
 * addon id. Never throws: a missing/unparseable manifest, or a `usedAddons`
 * that isn't an array, yields an empty map (callers still function; only
 * manifest-derived comparisons are skipped).
 *
 * Shared by `addonValidator` (orphan/missing/metadata reconciliation) and
 * `addonInventory` (the unified listing). Off-barrel — not public API.
 */
export function readUsedAddons(projectRoot: string): Map<string, UsedAddonEntry> {
  const usedById = new Map<string, UsedAddonEntry>();
  const manifestPath = path.join(projectRoot, "project.c3proj");

  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    return usedById;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return usedById;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return usedById;
  const usedAddons = (parsed as Record<string, unknown>).usedAddons;
  if (!Array.isArray(usedAddons)) return usedById;

  for (const raw of usedAddons) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string") continue;
    const used: UsedAddonEntry = { id: entry.id };
    if (typeof entry.type === "string") used.type = entry.type;
    if (typeof entry.name === "string") used.name = entry.name;
    if (typeof entry.author === "string") used.author = entry.author;
    if (typeof entry.version === "string") used.version = entry.version;
    if (typeof entry.bundled === "boolean") used.bundled = entry.bundled;
    usedById.set(entry.id, used);
  }

  return usedById;
}
