import * as path from "node:path";
import { toPosixPath } from "@genvidtech/mcp-utils";
import { discoverAddons } from "./addonDiscovery.js";
import { readAddonMetadata, resolveAddonId } from "./addonReader.js";
import { readUsedAddons } from "./addonManifest.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * An addon's standing in the inventory, derived from its presence on disk
 * (a bundled `.c3addon`) and in `project.c3proj.usedAddons`:
 *
 * - `bundled` — declared in `usedAddons` **and** a package on disk.
 * - `editor-only` — in `usedAddons` with `bundled:false`; supplied by the C3
 *   editor's installed addons, no package required.
 * - `missing` — `usedAddons` `bundled:true` but no package on disk.
 * - `orphan` — a package on disk with no matching `usedAddons` entry.
 */
export type AddonStatus = "bundled" | "editor-only" | "missing" | "orphan";

export interface AddonInventoryRow {
  id: string;
  status: AddonStatus;
  /**
   * Manifest version when present, else the package `addon.json` version;
   * `undefined` when neither is known (e.g. an orphan whose archive can't be
   * read). Version *mismatches* between the two are `validate-addons`' job —
   * this listing shows the project's declared version, not both.
   */
  version?: string;
  /** POSIX-relative `.c3addon` path; present for on-disk rows (bundled/orphan). */
  packagePath?: string;
}

export interface AddonInventory {
  rows: AddonInventoryRow[]; // sorted by id
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a unified addon inventory for `projectRoot`, reconciling three sources
 * into one row per addon id (sorted by id):
 *
 * 1. bundled `.c3addon` packages on disk ({@link discoverAddons}, flat — the
 *    same set `read-addon`'s bare list shows; duplicate/nested-package
 *    detection stays `validate-addons`' job),
 * 2. `project.c3proj.usedAddons` entries ({@link readUsedAddons}),
 * 3. editor-only addons (a `usedAddons` entry with `bundled:false`).
 *
 * Ids are resolved via {@link resolveAddonId} (addon.json `id`, else the
 * package filename) so a package whose id diverges from its filename still
 * matches its manifest entry. Never throws — an unreadable package yields a
 * row with an undefined version rather than aborting the scan.
 */
export function listAddons(projectRoot: string): AddonInventory {
  const disk = discoverAddons(projectRoot);
  const usedById = readUsedAddons(projectRoot);
  const rows: AddonInventoryRow[] = [];
  const seen = new Set<string>();

  // ── Disk-driven rows (bundled | orphan) ──────────────────────────────────
  for (const addon of disk) {
    const id = resolveAddonId(addon);
    if (seen.has(id)) continue; // first package wins if two flat packages share an id
    seen.add(id);

    const pkgVersion = readAddonMetadata(addon)?.metadata.version;
    const packagePath = toPosixPath(path.relative(projectRoot, addon.archivePath));
    const used = usedById.get(id);

    if (used !== undefined) {
      const row: AddonInventoryRow = { id, status: "bundled", packagePath };
      const version = used.version ?? pkgVersion;
      if (version !== undefined) row.version = version;
      rows.push(row);
    } else {
      const row: AddonInventoryRow = { id, status: "orphan", packagePath };
      if (pkgVersion !== undefined) row.version = pkgVersion;
      rows.push(row);
    }
  }

  // ── Manifest-only rows (missing | editor-only) ───────────────────────────
  for (const [id, used] of usedById) {
    if (seen.has(id)) continue;
    seen.add(id);

    const status: AddonStatus = used.bundled === true ? "missing" : "editor-only";
    const row: AddonInventoryRow = { id, status };
    if (used.version !== undefined) row.version = used.version;
    rows.push(row);
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return { rows };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/**
 * Render an `AddonInventory` to plain text: a `<N> addon(s):` header then one
 * `  <id>  <status>  <version>  <detail>` line per row (version `—` when
 * unknown). Shared by the CLI and MCP surfaces so output stays byte-identical.
 * Owns the empty case (`No addons found.`) so neither call site special-cases it.
 */
export function formatAddonInventory(inv: AddonInventory): string {
  if (inv.rows.length === 0) return "No addons found.";

  const lines: string[] = [`${inv.rows.length} addon(s):`];
  for (const row of inv.rows) {
    const parts = [row.id, row.status, row.version ?? "—"];
    let detail = "";
    if (row.status === "bundled") detail = row.packagePath ?? "";
    else if (row.status === "orphan") detail = `${row.packagePath} (not in project.c3proj)`;
    else if (row.status === "missing") detail = "(declared bundled, no package on disk)";
    // editor-only: no detail column
    if (detail) parts.push(detail);
    lines.push("  " + parts.join("  "));
  }

  return lines.join("\n");
}
