import * as fs from "node:fs";
import * as path from "node:path";
import { aceIdentity } from "@genvidtech/c3source";
import { readAddonAces, resolveAddonId } from "./addonReader.js";
import { resolveAddonTarget, type DiscoveredAddon } from "./addonDiscovery.js";
import type { AceEntry } from "./c3Reference.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AceDiff {
  added: AceEntry[];
  removed: AceEntry[];
  changed: { before: AceEntry; after: AceEntry }[];
  unchangedCount: number;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function paramsEqual(a: AceEntry, b: AceEntry): boolean {
  if (a.params.length !== b.params.length) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (a.params[i].name !== b.params[i].name || a.params[i].type !== b.params[i].type) return false;
  }
  return true;
}

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key.localeCompare(b.key);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Diff two ACE lists by identity key `<kind>:<id>`. Pure — takes/returns
 * plain data, no I/O. `objectClass` deliberately does NOT participate in the
 * identity key: `readAddonAces`/`mapAcesJsonToEntries` stamp every ACE in an
 * `aces.json` with the addon's *name* (the `.c3addon` filename basename, or
 * discovered id) as `objectClass`, which is constant within one addon but
 * commonly differs between two versions of the same addon (e.g.
 * `GCore-1.0.c3addon` vs `GCore-2.0.c3addon`, or once `resolveAceSource`
 * resolves each side to its real addon id). Keying on `objectClass` too would
 * make every ACE of a renamed/re-versioned addon show as removed+added
 * instead of unchanged/changed. `kind` stays in the key so a condition and an
 * action sharing an `id` remain distinct. Buckets are sorted by key for a
 * deterministic, stable output regardless of input ordering. Duplicate keys
 * within one side are resolved last-wins (defensive; well-formed aces.json
 * never produces duplicates).
 */
export function diffAddonAces(acesA: AceEntry[], acesB: AceEntry[]): AceDiff {
  const mapA = new Map<string, AceEntry>();
  for (const ace of acesA) mapA.set(aceIdentity(ace.kind, ace.id), ace);
  const mapB = new Map<string, AceEntry>();
  for (const ace of acesB) mapB.set(aceIdentity(ace.kind, ace.id), ace);

  const added: { key: string; ace: AceEntry }[] = [];
  const removed: { key: string; ace: AceEntry }[] = [];
  const changed: { key: string; before: AceEntry; after: AceEntry }[] = [];
  let unchangedCount = 0;

  for (const [key, before] of mapA) {
    const after = mapB.get(key);
    if (after === undefined) {
      removed.push({ key, ace: before });
    } else if (!paramsEqual(before, after)) {
      changed.push({ key, before, after });
    } else {
      unchangedCount++;
    }
  }

  for (const [key, after] of mapB) {
    if (!mapA.has(key)) added.push({ key, ace: after });
  }

  return {
    added: added.sort(byKey).map((e) => e.ace),
    removed: removed.sort(byKey).map((e) => e.ace),
    changed: changed.sort(byKey).map((e) => ({ before: e.before, after: e.after })),
    unchangedCount,
  };
}

/**
 * Resolve a CLI/MCP `--addon`-style diff-source argument to `{ label, aces }`.
 * Two modes, tried in order:
 *
 * 1. A path to an existing `.c3addon` file (absolute or relative to cwd, NOT
 *    contained to `projectRoot` — this tool is read-only and exists to diff
 *    packages that may live outside the project, e.g. a downloaded new
 *    version). Read via a synthetic `DiscoveredAddon` (kind is a placeholder;
 *    `readAddonAces` never inspects it).
 * 2. An addon id or extracted-directory path resolved via
 *    {@link resolveAddonTarget} against `projectRoot`.
 *
 * Returns `{ error }` when neither mode resolves. Never throws.
 */
export function resolveAceSource(
  projectRoot: string,
  arg: string,
): { label: string; aces: AceEntry[] } | { error: string } {
  try {
    const resolvedPath = path.resolve(arg);
    if (
      resolvedPath.toLowerCase().endsWith(".c3addon") &&
      fs.existsSync(resolvedPath) &&
      fs.statSync(resolvedPath).isFile()
    ) {
      const addon: DiscoveredAddon = {
        name: path.basename(resolvedPath).replace(/\.c3addon$/, ""),
        kind: "plugin",
        archivePath: resolvedPath,
        extractedDir: null,
      };
      // Rename to the addon's real, stable id (addon.json's `id`, falling
      // back to the basename) before reading ACEs, so the objectClass
      // stamped onto every entry reflects the addon's identity rather than
      // the archive's filename — filenames commonly encode a version suffix
      // (e.g. `GCore-2.0.c3addon`) that would otherwise leak into display.
      addon.name = resolveAddonId(addon);
      return { label: path.basename(resolvedPath), aces: readAddonAces(addon) };
    }
  } catch {
    // fall through to addon-target resolution
  }

  const target = resolveAddonTarget(projectRoot, arg);
  if (target !== null) {
    return { label: target.name, aces: readAddonAces(target) };
  }

  return { error: `addon source not found: ${arg}` };
}

// ── Formatter ────────────────────────────────────────────────────────────────

function formatAceLine(ace: AceEntry): string {
  const paramNames = ace.params.map((p) => p.name).join(", ");
  return `[${ace.kind}] ${ace.objectClass}.${ace.id}(${paramNames})`;
}

/**
 * Render an `AceDiff` to plain text: a header naming both sources and the
 * counts, then a section per non-empty bucket. Owns the empty case (returns
 * `No ACE differences.`) so the CLI and MCP surfaces stay byte-identical.
 */
export function formatAceDiff(diff: AceDiff, labelA: string, labelB: string): string {
  const { added, removed, changed, unchangedCount } = diff;

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return "No ACE differences.";
  }

  const lines: string[] = [
    `diff-addon-aces: ${labelA} → ${labelB}`,
    `  +${added.length} added, -${removed.length} removed, ~${changed.length} changed  (${unchangedCount} unchanged)`,
  ];

  if (added.length > 0) {
    lines.push("");
    lines.push("Added (A):");
    for (const ace of added) lines.push(`  ${formatAceLine(ace)}`);
  }

  if (removed.length > 0) {
    lines.push("");
    lines.push("Removed (R):");
    for (const ace of removed) lines.push(`  ${formatAceLine(ace)}`);
  }

  if (changed.length > 0) {
    lines.push("");
    lines.push("Changed (C):");
    for (const { before, after } of changed) {
      lines.push(`  [${after.kind}] ${after.objectClass}.${after.id}`);
      lines.push(`    - (${before.params.map((p) => p.name).join(", ")})`);
      lines.push(`    + (${after.params.map((p) => p.name).join(", ")})`);
    }
  }

  return lines.join("\n");
}
