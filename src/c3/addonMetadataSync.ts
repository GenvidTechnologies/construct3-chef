import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROJECT_MANIFEST_FILE,
  readProjectManifestTolerant,
  serializeProjectManifest,
  type C3ProjectManifest,
} from "@genvidtech/c3source";
import { toPosixPath } from "@genvidtech/mcp-utils";
import { discoverAddons, type DiscoveredAddon } from "./addonDiscovery.js";
import { readAddonMetadata, resolveAddonId } from "./addonReader.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SyncDirection = "manifest-from-package" | "package-from-manifest";
export type AddonSyncStatus = "would-change" | "in-sync" | "blocked" | "no-manifest-entry";

export interface AddonFieldChange {
  field: "version" | "author";
  from: string; // current manifest value
  to: string; // package value
}

export interface AddonSyncRow {
  addonId: string;
  package: string; // POSIX-relative to projectRoot
  status: AddonSyncStatus;
  changes: AddonFieldChange[]; // populated on would-change only
  reason?: string; // populated on blocked only
}

export interface AddonSyncResult {
  direction: SyncDirection;
  rows: AddonSyncRow[]; // package-driven, sorted by addonId
  dryRun: boolean;
  wrote: boolean;
  manifestIssues: string[]; // tolerated shape-rule ids from the tolerant read — reported, never fatal
  reformatWarning?: string;
}

/**
 * The internal read+classify result, richer than {@link AddonSyncResult}: it carries
 * the live parsed manifest BY IDENTITY (never a clone — required for
 * `serializeProjectManifest`/`writeProjectManifest` byte-fidelity), its absolute path,
 * and the original file bytes, so `applyAddonMetadataSync` (P3) can mutate the same
 * object in place and write it back without re-parsing or re-probing canonical form.
 * Off-barrel, like every `addon*` sibling — not published API.
 */
export interface AddonSyncPlan {
  direction: SyncDirection;
  manifest: C3ProjectManifest; // parsed BY IDENTITY — mutate in place, never rebuild via spread
  manifestPath: string; // absolute path to project.c3proj
  originalText: string; // the file's bytes as read
  canonical: boolean; // true iff serializeProjectManifest(manifest) === originalText
  rows: AddonSyncRow[];
  manifestIssues: string[];
  reformatWarning?: string;
}

const FIELDS: Array<"version" | "author"> = ["version", "author"];

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Classify a single, unambiguous discovered addon against its (possibly absent)
 * `usedAddons` entry. Mirrors `addonValidator.ts`'s `checkMetadataMismatch` "both
 * defined && differ" comparison rule for `version`/`author` (never `name` — see #132 —
 * and never `id`/`type`/`bundled`), extended with three sync-specific `blocked` cases
 * that `checkMetadataMismatch` has no reason to know about: an editor-only manifest
 * entry (`bundled: false`), and a manifest entry missing the field key outright (the
 * tool overwrites, never adds — adding a key would perturb key order and break byte
 * fidelity). Direction is deliberately NOT a parameter: classification is symmetric
 * across `SyncDirection` — see `planAddonMetadataSync`'s doc comment.
 */
function classifyAddon(
  addon: DiscoveredAddon,
  resolvedId: string,
  pkg: string,
  usedById: Map<string, Record<string, unknown>>,
): AddonSyncRow {
  const metaResult = readAddonMetadata(addon);
  if (metaResult === null) {
    return {
      addonId: resolvedId,
      package: pkg,
      status: "blocked",
      changes: [],
      reason:
        "package is unreadable (corrupt archive, malformed zip, or un-materialized LFS pointer) — cannot read addon.json",
    };
  }

  const { metadata } = metaResult;
  const used = usedById.get(resolvedId);

  if (used === undefined) {
    return { addonId: resolvedId, package: pkg, status: "no-manifest-entry", changes: [] };
  }

  if (used.bundled === false) {
    return {
      addonId: resolvedId,
      package: pkg,
      status: "blocked",
      changes: [],
      reason:
        "manifest entry declares bundled:false (editor-only) — refusing to write a package version into an editor-only entry",
    };
  }

  // ── Missing-key pass: a package-side value with no corresponding manifest key
  // blocks the whole row (the tool overwrites, never adds a key). ─────────────
  for (const field of FIELDS) {
    const packageValue = metadata[field];
    if (packageValue === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(used, field)) {
      return {
        addonId: resolvedId,
        package: pkg,
        status: "blocked",
        changes: [],
        reason: `manifest entry has no '${field}' field — sync overwrites, never adds`,
      };
    }
  }

  const changes: AddonFieldChange[] = [];
  for (const field of FIELDS) {
    const packageValue = metadata[field];
    if (packageValue === undefined) continue;
    const rawManifestValue = used[field];
    const manifestValue = typeof rawManifestValue === "string" ? rawManifestValue : undefined;
    if (manifestValue === undefined) continue;
    if (packageValue !== manifestValue) {
      changes.push({ field, from: manifestValue, to: packageValue });
    }
  }

  if (changes.length > 0) {
    return { addonId: resolvedId, package: pkg, status: "would-change", changes };
  }

  return { addonId: resolvedId, package: pkg, status: "in-sync", changes: [] };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read `project.c3proj` (tolerantly) and every flat-discovered `.c3addon` package
 * under `projectRoot`, and classify each package's `version`/`author` sync status
 * against its matching `usedAddons` entry. Pure read + classify — never writes.
 *
 * **Rows are package-driven**: one row per flat-discovered package (`discoverAddons`,
 * NOT the recursive walk `addonValidator`'s duplicate pass uses). A `usedAddons` entry
 * with no matching package on disk produces no row (that's `list-addons`/
 * `validate-addons` territory), and likewise an editor-only (`bundled: false`) entry
 * with no matching package produces no row at all.
 *
 * **`direction` does not affect classification** — it only affects write eligibility
 * and rendering downstream (`applyAddonMetadataSync` / the CLI/MCP surfaces). The same
 * four-state classification (`would-change` / `in-sync` / `blocked` /
 * `no-manifest-entry`) applies for both `SyncDirection` values.
 *
 * Two flat-discovered packages resolving to the same addon id are `blocked` as a
 * SINGLE row (ambiguous — ordering data loss on a mutation would be too risky to
 * pick one silently); the `reason` names both POSIX-relative paths.
 *
 * `manifestIssues` carries the rule ids `readProjectManifestTolerant` tolerated
 * (e.g. an absent `savedWithRelease`, a `usedAddons` entry missing `author`) — these
 * are reported, never fatal; `usedAddons` itself is defensively re-checked with
 * `Array.isArray` rather than trusting c3source's `getUsedAddons` (which has no such
 * guard and would blow up a `for…of` on a tolerated non-array `usedAddons`).
 *
 * Returns `{ error }` — never throws — when `project.c3proj` can't be read or parsed
 * (ENOENT, a non-object top level, or malformed JSON all propagate unwrapped from
 * `readProjectManifestTolerant`/`JSON.parse` and are caught here).
 */
export function planAddonMetadataSync(
  projectRoot: string,
  opts: { direction: SyncDirection; addon?: string },
): AddonSyncResult | { error: string } {
  const plan = buildAddonSyncPlan(projectRoot, opts);
  if ("error" in plan) return plan;

  const result: AddonSyncResult = {
    direction: plan.direction,
    rows: plan.rows,
    dryRun: true,
    wrote: false,
    manifestIssues: plan.manifestIssues,
  };
  if (plan.reformatWarning !== undefined) result.reformatWarning = plan.reformatWarning;
  return result;
}

/**
 * The lower-level counterpart of {@link planAddonMetadataSync}: does the same read +
 * classify work, but returns the richer {@link AddonSyncPlan} — carrying the parsed
 * manifest BY IDENTITY, its absolute path, and the original file bytes — so
 * `applyAddonMetadataSync` (P3) can mutate the same object in place and write it back
 * without re-parsing. `planAddonMetadataSync` is a thin wrapper over this that discards
 * the write-oriented fields and fixes `dryRun: true` / `wrote: false` (it never writes).
 *
 * Never throws; see {@link planAddonMetadataSync} for the `{ error }` cases.
 */
export function buildAddonSyncPlan(
  projectRoot: string,
  opts: { direction: SyncDirection; addon?: string },
): AddonSyncPlan | { error: string } {
  const manifestPath = path.join(projectRoot, PROJECT_MANIFEST_FILE);

  let originalText: string;
  try {
    originalText = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    return { error: `failed to read ${PROJECT_MANIFEST_FILE}: ${err instanceof Error ? err.message : String(err)}` };
  }

  let manifest: C3ProjectManifest;
  let manifestIssues: string[];
  try {
    const manifestResult = readProjectManifestTolerant(manifestPath);
    manifest = manifestResult.manifest;
    manifestIssues = manifestResult.issues.map((issue) => issue.rule);
  } catch (err) {
    return { error: `failed to parse ${PROJECT_MANIFEST_FILE}: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Defensive re-check: c3source's own `getUsedAddons` has no `Array.isArray` guard,
  // so a tolerated non-array `usedAddons` (rule `used-addons-array`) would be handed
  // back as-is and blow up a `for…of` below.
  const rawUsedAddons: unknown = manifest.usedAddons;
  const usedAddonsList: unknown[] = Array.isArray(rawUsedAddons) ? rawUsedAddons : [];

  const usedById = new Map<string, Record<string, unknown>>();
  for (const raw of usedAddonsList) {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry.id === "string") usedById.set(entry.id, entry);
    }
  }

  const discovered = discoverAddons(projectRoot).map((addon) => ({ addon, resolvedId: resolveAddonId(addon) }));
  const scoped = opts.addon === undefined ? discovered : discovered.filter((d) => d.resolvedId === opts.addon);

  const byId = new Map<string, Array<{ addon: DiscoveredAddon; resolvedId: string }>>();
  for (const entry of scoped) {
    const list = byId.get(entry.resolvedId);
    if (list !== undefined) list.push(entry);
    else byId.set(entry.resolvedId, [entry]);
  }

  const rows: AddonSyncRow[] = [];
  for (const [resolvedId, group] of byId) {
    if (group.length > 1) {
      const paths = group.map(({ addon }) => toPosixPath(path.relative(projectRoot, addon.archivePath))).sort();
      rows.push({
        addonId: resolvedId,
        package: paths[0],
        status: "blocked",
        changes: [],
        reason: `ambiguous addon id '${resolvedId}': ${paths.length} packages resolve to it — ${paths.join(", ")}`,
      });
      continue;
    }

    const { addon } = group[0];
    const pkg = toPosixPath(path.relative(projectRoot, addon.archivePath));
    rows.push(classifyAddon(addon, resolvedId, pkg, usedById));
  }

  rows.sort((a, b) => a.addonId.localeCompare(b.addonId));

  const canonical = serializeProjectManifest(manifest) === originalText;
  let reformatWarning: string | undefined;
  if (!canonical) {
    const serialized = serializeProjectManifest(manifest);
    reformatWarning =
      `${PROJECT_MANIFEST_FILE} is not in canonical serialized form ` +
      `(original ${originalText.length} bytes vs canonical ${serialized.length} bytes) — ` +
      "a write will reformat the whole file";
  }

  const plan: AddonSyncPlan = {
    direction: opts.direction,
    manifest,
    manifestPath,
    originalText,
    canonical,
    rows,
    manifestIssues,
  };
  if (reformatWarning !== undefined) plan.reformatWarning = reformatWarning;
  return plan;
}

// ── Formatter ────────────────────────────────────────────────────────────────

const STATUS_ORDER: AddonSyncStatus[] = ["would-change", "in-sync", "blocked", "no-manifest-entry"];

/**
 * The per-row status label + framing, direction-aware for `would-change` only.
 * `direction` never changes classification (see {@link planAddonMetadataSync}),
 * only how a `would-change` row reads: `manifest-from-package` is the
 * write direction (the manifest entry would be updated to match the package),
 * so it reads as an action the tool would take. `package-from-manifest` never
 * writes anything — chef has no `.c3addon` writer — so the same row instead
 * tells the operator which side is stale and points them at Construct.
 */
function formatRowHeader(row: AddonSyncRow, direction: SyncDirection): string {
  const base = `  [${row.status}] ${row.addonId}  ${row.package}`;
  if (row.status !== "would-change") return base;

  const framing =
    direction === "package-from-manifest"
      ? "package is stale, re-export it from Construct to update"
      : "would update manifest entry";
  return `${base}  — ${framing}`;
}

/**
 * Render an `AddonSyncResult` to plain text. Shared by the CLI and MCP
 * surfaces so output stays byte-identical (see the sibling `addon*`
 * formatters — `formatAddonValidation`, `formatAddonInventory`,
 * `formatAceDiff` — this one matches their voice: a header + summary, one
 * line per row, and an owned empty case).
 *
 * The report is deliberately identical between a dry-run and an apply render
 * of the same rows, except for a single trailing `Nothing written (dry run).`
 * line appended only when `dryRun` — callers that preview with
 * `planAddonMetadataSync` (always `dryRun: true`) and then apply see the same
 * report shape, so the trailing line is the only tell.
 */
export function formatAddonMetadataSync(result: AddonSyncResult): string {
  const { direction, rows, dryRun, reformatWarning } = result;

  const counts: Record<AddonSyncStatus, number> = {
    "would-change": 0,
    "in-sync": 0,
    blocked: 0,
    "no-manifest-entry": 0,
  };
  for (const row of rows) counts[row.status]++;

  const lines: string[] = [
    `sync-addon-metadata: ${direction} — ${rows.length} package(s)`,
    "  " + STATUS_ORDER.map((status) => `${counts[status]} ${status}`).join(", "),
  ];

  if (rows.length === 0) {
    lines.push("");
    lines.push("No addon packages found to sync.");
  } else {
    for (const row of rows) {
      lines.push("");
      lines.push(formatRowHeader(row, direction));
      if (row.status === "blocked" && row.reason !== undefined) {
        lines.push(`    reason: ${row.reason}`);
      }
      if (row.status === "would-change") {
        for (const change of row.changes) {
          lines.push(`    ${change.field}: '${change.from}' → '${change.to}'`);
        }
      }
    }
  }

  if (reformatWarning !== undefined) {
    lines.push("");
    lines.push(`note: ${reformatWarning}`);
  }

  if (dryRun) {
    lines.push("Nothing written (dry run).");
  }

  return lines.join("\n");
}
