import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWithin, toPosixPath } from "@genvidtech/mcp-utils";
import { unzipSync } from "fflate";
import { discoverAddons, type DiscoveredAddon } from "./addonDiscovery.js";
import { mapAcesJsonToEntries } from "./aceRegistry.js";
import type { AceEntry } from "./c3Reference.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AddonMetadata {
  id?: string;
  version?: string;
  name?: string;
  author?: string;
  sdkVersion?: string;
  minConstructVersion?: string;
}

export interface AddonInfo {
  name: string;
  kind: "plugin" | "effect";
  source: "extracted" | "archive";
  metadata: AddonMetadata;
  aces: AceEntry[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read a single entry (by exact name) from an addon, preferring the extracted
 * directory and falling through to the `.c3addon` zip archive when the entry
 * is absent from the extracted dir (which may be incomplete). Returns the
 * decoded UTF-8 text plus which branch served the read, or `null` if the
 * entry could not be read from either source. Never throws.
 */
function readAddonEntryWithSource(
  addon: DiscoveredAddon,
  entryName: string,
): { text: string; source: "extracted" | "archive" } | null {
  // ── Extracted dir first ────────────────────────────────────────────────────
  if (addon.extractedDir !== null) {
    try {
      const p = resolveWithin(addon.extractedDir, entryName);
      if (p !== null && fs.existsSync(p)) {
        return { text: fs.readFileSync(p, "utf-8"), source: "extracted" };
      }
    } catch {
      // fall through to the zip
    }
  }

  // ── Zip fallback ────────────────────────────────────────────────────────────
  try {
    const buf = fs.readFileSync(addon.archivePath);
    const unzipped = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === entryName });
    const bytes = unzipped[entryName];
    if (bytes === undefined) return null;
    return { text: Buffer.from(bytes).toString("utf-8"), source: "archive" };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a single entry (by exact name, e.g. `"addon.json"` or `"aces.json"`)
 * from an addon: the extracted directory if present and it has the entry,
 * else the `.c3addon` zip archive. Returns `null` if the entry can't be read
 * from either source. Never throws.
 */
export function readAddonEntry(addon: DiscoveredAddon, entryName: string): string | null {
  const result = readAddonEntryWithSource(addon, entryName);
  return result === null ? null : result.text;
}

/**
 * Read and parse an addon's `addon.json`, mapping the C3-SDK kebab-case keys
 * to `AddonMetadata`. Returns `null` only when `addon.json` could not be read
 * at all (from either the extracted dir or the archive); returns
 * `{ metadata: {}, source }` on malformed JSON. Never throws.
 */
export function readAddonMetadata(
  addon: DiscoveredAddon,
): { metadata: AddonMetadata; source: "extracted" | "archive" } | null {
  const result = readAddonEntryWithSource(addon, "addon.json");
  if (result === null) return null;

  const { text, source } = result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { metadata: {}, source };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { metadata: {}, source };
  }

  const raw = parsed as Record<string, unknown>;
  const metadata: AddonMetadata = {};
  if (raw.id !== undefined) metadata.id = String(raw.id);
  if (raw.version !== undefined) metadata.version = String(raw.version);
  if (raw.name !== undefined) metadata.name = String(raw.name);
  if (raw.author !== undefined) metadata.author = String(raw.author);
  if (raw["sdk-version"] !== undefined) metadata.sdkVersion = String(raw["sdk-version"]);
  if (raw["min-construct-version"] !== undefined) metadata.minConstructVersion = String(raw["min-construct-version"]);

  return { metadata, source };
}

/**
 * Resolve an addon's id: `addon.json`'s `id` field when readable, else the
 * package's basename (archive filename without `.c3addon`). Never throws.
 * Shared by `addonValidator` and `addonInventory` so both key on the same id.
 */
export function resolveAddonId(addon: DiscoveredAddon): string {
  return readAddonMetadata(addon)?.metadata.id ?? addon.name;
}

/**
 * Read and parse an addon's `aces.json` into a flat `AceEntry[]` via the same
 * `mapAcesJsonToEntries` parser `buildAddonAceRegistry` uses. Any failure
 * (unreadable, malformed JSON, unexpected shape) yields `[]`. Never throws.
 */
export function readAddonAces(addon: DiscoveredAddon): AceEntry[] {
  const text = readAddonEntry(addon, "aces.json");
  if (text === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  try {
    return mapAcesJsonToEntries(parsed, addon.name);
  } catch {
    return [];
  }
}

/**
 * Enumerate every entry within an addon whose POSIX-relative name starts with
 * `prefix` (e.g. "lang/"), drawn from BOTH the extracted directory (recursive
 * walk) and the .c3addon zip archive, deduplicated. Mirrors readAddonEntry's
 * hybrid sourcing: an entry present in only one source is still returned, so a
 * lang/ dir that exists in the zip but not the (incomplete) extracted dir is
 * found. Returns sorted, unique entry names relative to the addon root. Never
 * throws; an unreadable/absent source contributes nothing.
 */
export function listAddonEntries(addon: DiscoveredAddon, prefix: string): string[] {
  const names = new Set<string>();

  // ── Extracted dir ────────────────────────────────────────────────────────
  if (addon.extractedDir !== null) {
    try {
      const entries = fs.readdirSync(addon.extractedDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parentDir = entry.parentPath ?? entry.path;
        const abs = path.join(parentDir, entry.name);
        const rel = toPosixPath(path.relative(addon.extractedDir, abs));
        if (rel.startsWith(prefix)) names.add(rel);
      }
    } catch {
      // contributes nothing
    }
  }

  // ── Zip archive ──────────────────────────────────────────────────────────
  try {
    const buf = fs.readFileSync(addon.archivePath);
    const unzipped = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith(prefix) });
    for (const name of Object.keys(unzipped)) {
      if (name.endsWith("/")) continue;
      if (name.startsWith(prefix)) names.add(name);
    }
  } catch {
    // contributes nothing
  }

  return [...names].sort();
}

/**
 * Discover and read a single addon by name, assembling its metadata + ACEs.
 * Returns `null` when no addon with that name is discovered under the
 * project's `addons/` directories. Never throws.
 */
export function readAddon(projectRoot: string, name: string): AddonInfo | null {
  const addon = discoverAddons(projectRoot).find((a) => a.name === name);
  if (addon === undefined) return null;

  const metadataResult = readAddonMetadata(addon);
  const aces = readAddonAces(addon);

  let source: "extracted" | "archive";
  if (metadataResult !== null) {
    source = metadataResult.source;
  } else {
    const acesResult = readAddonEntryWithSource(addon, "aces.json");
    source = acesResult !== null ? acesResult.source : addon.extractedDir !== null ? "extracted" : "archive";
  }

  return {
    name: addon.name,
    kind: addon.kind,
    source,
    metadata: metadataResult?.metadata ?? {},
    aces,
  };
}

// ── Formatters ────────────────────────────────────────────────────────────────

/**
 * Render an `AddonInfo` to plain text: a metadata header (only present
 * fields), then the ACE count and lines. Shared by the CLI and MCP surfaces
 * so output stays byte-identical.
 */
export function formatAddonInfo(info: AddonInfo): string {
  const { name, kind, source, metadata, aces } = info;

  const lines: string[] = [`${name} (${kind}, ${source})`];
  if (metadata.id !== undefined) lines.push(`id: ${metadata.id}`);
  if (metadata.version !== undefined) lines.push(`version: ${metadata.version}`);
  if (metadata.name !== undefined) lines.push(`name: ${metadata.name}`);
  if (metadata.author !== undefined) lines.push(`author: ${metadata.author}`);
  if (metadata.sdkVersion !== undefined) lines.push(`sdk-version: ${metadata.sdkVersion}`);
  if (metadata.minConstructVersion !== undefined) lines.push(`min-construct-version: ${metadata.minConstructVersion}`);

  lines.push("");
  lines.push(`${aces.length} ACE(s)`);

  for (const ace of aces) {
    const paramNames = ace.params.map((p) => p.name).join(", ");
    lines.push(`[${ace.source} ${ace.kind}] ${ace.objectClass}.${ace.id}(${paramNames})`);
  }

  return lines.join("\n");
}

/**
 * Render a discovered-addon list to plain text: one line per addon,
 * `<name>  (<kind>)  <extracted|archive only>`, sorted by name, or
 * `No addons found.` when empty. Owning the empty case here keeps the CLI and
 * MCP surfaces byte-identical (neither special-cases it at the call site).
 */
export function formatAddonList(addons: DiscoveredAddon[]): string {
  if (addons.length === 0) return "No addons found.";
  const sorted = [...addons].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map((a) => `${a.name}  (${a.kind})  ${a.extractedDir ? "extracted" : "archive only"}`).join("\n");
}
