import * as fs from "node:fs";
import type { EventSheet } from "@genvidtech/c3source";
import { hasActions, hasConditions, openProject, visitEvents } from "@genvidtech/c3source";
import { diffAddonAces, resolveAceSource } from "./addonAceDiff.js";
import { resolveAddonTarget } from "./addonDiscovery.js";
import { readAddonAces, resolveAddonId } from "./addonReader.js";
import type { AceEntry } from "./c3Reference.js";
import { isStandardAction, type C3Action } from "./eventSheetMutator.js";
import { readProjectObjects, type ObjectDefn } from "./projectObjects.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One condition/action node in an event sheet whose `(objectClass, kind, id)`
 * matches an ACE the target addon currently declares. `sid` is the
 * condition/action node's OWN sid — not the owning event's — because several
 * conditions/actions commonly share one event's `jsonPath`, so the node sid
 * is what disambiguates one call site from its siblings.
 */
export interface CallSite {
  sheet: string;
  eventNumber: number | null;
  jsonPath: string;
  kind: "condition" | "action";
  objectClass: string;
  id: string;
  sid: number;
}

/** An object type or family whose `plugin-id` names the scanned addon. */
export interface PresenceRow {
  name: string;
  kind: "objectType" | "family";
  callSiteCount: number;
}

/**
 * Blast-radius data attached to `AddonUsageResult` when `scanAddonUsage` was
 * called with a `fromArg` (a `--from` old-version source). `changedKeys` /
 * `removedKeys` are `<kind>:<id>` identity keys ({@link aceKey}) drawn from
 * `diffAddonAces(fromAces, currentAces)`'s `changed`/`removed` buckets —
 * added ACEs are deliberately excluded, since no pre-existing call site can
 * reference an ACE that didn't exist yet. `affectedCount` is the number of
 * `callSites` whose `(kind, id)` falls in either set.
 */
export interface BlastInfo {
  fromLabel: string;
  changedKeys: string[];
  removedKeys: string[];
  affectedCount: number;
}

export interface AddonUsageResult {
  addonId: string;
  addonLabel: string;
  presence: PresenceRow[];
  callSites: CallSite[];
  /**
   * The addon's current ACEs (as read for matching). Carried through so
   * {@link formatAddonUsage} can render each call site's declared param
   * names without re-reading the addon.
   */
  aces: AceEntry[];
  /** Present only when `scanAddonUsage` was called with a `fromArg`. */
  blast?: BlastInfo;
}

export type ScanAddonUsageResult = AddonUsageResult | { error: string };

// ── Internal helpers ─────────────────────────────────────────────────────────

function aceKey(kind: AceEntry["kind"], id: string): string {
  return `${kind}:${id}`;
}

const PRESENCE_KIND_ORDER: Record<ObjectDefn["kind"], number> = { objectType: 0, family: 1 };

function byPresenceOrder(a: ObjectDefn, b: ObjectDefn): number {
  const kindDiff = PRESENCE_KIND_ORDER[a.kind] - PRESENCE_KIND_ORDER[b.kind];
  if (kindDiff !== 0) return kindDiff;
  return a.name.localeCompare(b.name);
}

/** A condition/action node as seen mid-walk, before it's known to be a call site. */
interface CallCandidate {
  objectClass: string;
  kind: "condition" | "action";
  id: string;
}

/**
 * Isolates the addon-kind-specific pieces of a usage scan (presence +
 * per-node match rule + call-site attribution) behind a common seam, so the
 * event-sheet-walk shell, blast-radius wiring, result assembly, and
 * {@link formatAddonUsage} stay shared/kind-agnostic across addon kinds
 * (plugin today; behavior in a follow-up).
 */
interface UsageMatcher {
  /** Presence rows (name + kind), before call-site counts are known. */
  presence: Omit<PresenceRow, "callSiteCount">[];
  /** Does this condition/action node call the addon? */
  matches(node: CallCandidate): boolean;
  /**
   * Which presence-row name a call site's `objectClass` counts toward, or
   * `undefined` if it shouldn't be attributed to any row.
   */
  attributeTo(objectClass: string): string | undefined;
}

/**
 * Builds the plugin {@link UsageMatcher}: presence is every object
 * type/family whose `plugin-id` names the addon, a node matches when its
 * `objectClass` is one of those presence names AND its `(kind, id)` is in
 * `matchKeySet`, and every matched call site attributes to its own
 * `objectClass` (which is always a presence name, by construction of
 * `matches`).
 */
function createPluginUsageMatcher(addonId: string, objects: ObjectDefn[], matchKeySet: Set<string>): UsageMatcher {
  const matched = objects.filter((d) => d.pluginId === addonId).sort(byPresenceOrder);
  const nameSet = new Set(matched.map((d) => d.name));

  return {
    presence: matched.map((d) => ({ name: d.name, kind: d.kind })),
    matches: (node) => nameSet.has(node.objectClass) && matchKeySet.has(aceKey(node.kind, node.id)),
    attributeTo: (objectClass) => (nameSet.has(objectClass) ? objectClass : undefined),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a project's event sheets for call sites of `addonArg`'s current ACEs.
 *
 * 1. Resolves the addon ({@link resolveAddonTarget}) and reads its current
 *    ACEs ({@link readAddonAces}), keyed `(kind, id)` — deliberately NOT
 *    `objectClass`, which is a caller-supplied addon name, constant per addon
 *    and not a stable per-ACE identity (see `aceRegistry.ts`'s docstring).
 * 2. Finds every `objectTypes/*.json` / `families/*.json` entry whose
 *    `plugin-id` names the addon ({@link readProjectObjects}) — this is the
 *    presence set: object types/families instantiated FROM the addon.
 * 3. Walks every event sheet's conditions/actions; a node counts as a call
 *    site when its `objectClass` is in the presence set AND its `(kind, id)`
 *    matches a current ACE. Conditions and actions only — expression usage
 *    isn't a structured node and is out of scope here (tracked separately).
 *
 * Optional blast-radius mode: when `fromArg` is given, it's resolved via
 * `addonAceDiff.resolveAceSource` — deliberately NOT contained to `rootDir`,
 * mirroring `diff-addon-aces`'s own `resolveAceSource` call site: a `--from`
 * source (e.g. a previously downloaded release archive) may legitimately
 * live outside the project being scanned, and this tool is read-only. The
 * `from` ACEs are diffed against the addon's current ACEs
 * ({@link diffAddonAces}), and the resulting `changed`/`removed` buckets do
 * two things: (a) widen the call-site match set to also catch *dangling*
 * calls — a call site whose `(kind, id)` was REMOVED no longer appears in
 * the addon's current ACEs, so the plain match rule above would silently
 * drop it; this is exactly the "reimport didn't migrate this event sheet"
 * scenario blast mode exists to surface — and (b) get carried on the result
 * as `blast` so {@link formatAddonUsage} can mark affected rows/call sites
 * without recomputing the diff.
 *
 * Errors as values, mirroring `addonAceDiff.resolveAceSource`: returns
 * `{ error }` when the addon (or, in blast mode, the `from` source) can't be
 * resolved. Never throws.
 */
export function scanAddonUsage(rootDir: string, addonArg: string, fromArg?: string): ScanAddonUsageResult {
  const target = resolveAddonTarget(rootDir, addonArg);
  if (target === null) {
    return { error: `addon source not found: ${addonArg}` };
  }

  const addonId = resolveAddonId(target);
  const aces: AceEntry[] = readAddonAces(target);
  // Expressions aren't structured condition/action nodes (see the module
  // doc), so only condition/action ACEs participate in the match key.
  const aceKeySet = new Set(
    aces
      .filter((a): a is AceEntry & { kind: "condition" | "action" } => a.kind !== "expression")
      .map((a) => aceKey(a.kind, a.id)),
  );

  let matchKeySet = aceKeySet;
  let blast: BlastInfo | undefined;

  if (fromArg !== undefined) {
    const fromSource = resolveAceSource(rootDir, fromArg);
    if ("error" in fromSource) {
      return { error: fromSource.error };
    }

    const diff = diffAddonAces(fromSource.aces, aces);
    const changedKeys = diff.changed.map((c) => aceKey(c.after.kind, c.after.id));
    const removedKeys = diff.removed.map((r) => aceKey(r.kind, r.id));

    // Widen the match set with the removed keys only — changed keys are
    // still present in `aceKeySet` (the ACE still exists, just with a
    // different param signature), but removed keys are by definition gone
    // from `aceKeySet` and would otherwise never surface a call site.
    matchKeySet = new Set([...aceKeySet, ...removedKeys]);

    blast = { fromLabel: fromSource.label, changedKeys, removedKeys, affectedCount: 0 };
  }

  const project = openProject(rootDir);
  const objects = readProjectObjects(project);
  const matcher = createPluginUsageMatcher(addonId, objects, matchKeySet);

  const callSites: CallSite[] = [];

  for (const absPath of project.findAllEventSheets()) {
    let sheet: EventSheet;
    try {
      sheet = JSON.parse(fs.readFileSync(absPath, "utf-8")) as EventSheet;
    } catch {
      continue; // skip unreadable/unparseable sheets rather than crashing the scan
    }

    visitEvents(sheet.events, (event, ctx) => {
      if (hasConditions(event)) {
        for (const cond of event.conditions) {
          if (matcher.matches({ objectClass: cond.objectClass, kind: "condition", id: cond.id })) {
            callSites.push({
              sheet: sheet.name,
              eventNumber: ctx.eventNumber,
              jsonPath: ctx.jsonPath,
              kind: "condition",
              objectClass: cond.objectClass,
              id: cond.id,
              sid: cond.sid,
            });
          }
        }
      }

      if (hasActions(event)) {
        for (const action of event.actions as C3Action[]) {
          if (!isStandardAction(action)) continue;
          if (matcher.matches({ objectClass: action.objectClass, kind: "action", id: action.id })) {
            callSites.push({
              sheet: sheet.name,
              eventNumber: ctx.eventNumber,
              jsonPath: ctx.jsonPath,
              kind: "action",
              objectClass: action.objectClass,
              id: action.id,
              sid: action.sid,
            });
          }
        }
      }
    });
  }

  const callSiteCountByName = new Map<string, number>();
  for (const site of callSites) {
    const name = matcher.attributeTo(site.objectClass);
    if (name === undefined) continue;
    callSiteCountByName.set(name, (callSiteCountByName.get(name) ?? 0) + 1);
  }

  const presence: PresenceRow[] = matcher.presence.map((p) => ({
    ...p,
    callSiteCount: callSiteCountByName.get(p.name) ?? 0,
  }));

  if (blast !== undefined) {
    const changedSet = new Set(blast.changedKeys);
    const removedSet = new Set(blast.removedKeys);
    blast.affectedCount = callSites.filter((s) => {
      const key = aceKey(s.kind, s.id);
      return changedSet.has(key) || removedSet.has(key);
    }).length;
  }

  return { addonId, addonLabel: target.name, presence, callSites, aces, ...(blast !== undefined ? { blast } : {}) };
}

// ── Formatter ────────────────────────────────────────────────────────────────

const PRESENCE_SECTION_TITLE: Record<PresenceRow["kind"], string> = {
  objectType: "Object types",
  family: "Families",
};

function formatCallSiteLine(
  site: CallSite,
  aceByKey: Map<string, AceEntry>,
  changedKeySet: Set<string> | undefined,
  removedKeySet: Set<string> | undefined,
): string {
  const ace = aceByKey.get(aceKey(site.kind, site.id));
  const paramNames = ace ? ace.params.map((p) => p.name).join(", ") : "";
  const key = aceKey(site.kind, site.id);
  const marker = removedKeySet?.has(key) ? " ⚠ REMOVED" : changedKeySet?.has(key) ? " ⚠ CHANGED" : "";
  return `    event #${site.eventNumber ?? "?"}  ${site.jsonPath}   [${site.kind}] ${site.objectClass}.${site.id}(${paramNames})${marker}`;
}

/**
 * Render a `ScanAddonUsageResult` to plain text: a header + summary, a
 * presence section grouped by kind (Object types / Families), then a call
 * sites section grouped by event sheet. Shared by the CLI and MCP surfaces so
 * output stays byte-identical. Owns both the empty case (`No usage of addon
 * "<id>" found.`) and the error-value case so neither call site special-cases
 * them.
 *
 * When `result.blast` is present (a `--from`/blast-radius scan), the output
 * gains: a `blast radius (vs <fromLabel>): N affected call site(s)` line
 * after the summary; a trailing ` ⚠ exposed` marker on every presence row
 * when the diff has any changed/removed entries (a version bump touches
 * every instance of the addon regardless of whether that instance has any
 * matched call sites); and a trailing ` ⚠ CHANGED` / ` ⚠ REMOVED` marker on
 * each affected call-site line. With no `blast`, output is byte-identical to
 * the plain (P3) scan.
 */
export function formatAddonUsage(result: ScanAddonUsageResult): string {
  if ("error" in result) {
    return `scan-addon-usage: ${result.error}`;
  }

  const { addonId, presence, callSites, aces, blast } = result;

  if (presence.length === 0 && callSites.length === 0) {
    return `No usage of addon "${addonId}" found.`;
  }

  const objectTypeCount = presence.filter((p) => p.kind === "objectType").length;
  const familyCount = presence.filter((p) => p.kind === "family").length;

  const lines: string[] = [
    `scan-addon-usage: ${addonId}`,
    `presence: ${objectTypeCount} object type(s), ${familyCount} famil${familyCount === 1 ? "y" : "ies"}  ` +
      `call sites: ${callSites.length}`,
  ];

  if (blast !== undefined) {
    lines.push(`blast radius (vs ${blast.fromLabel}): ${blast.affectedCount} affected call site(s)`);
  }

  const exposed = blast !== undefined && (blast.changedKeys.length > 0 || blast.removedKeys.length > 0);

  if (presence.length > 0) {
    for (const kind of ["objectType", "family"] as const) {
      const rows = presence.filter((p) => p.kind === kind);
      if (rows.length === 0) continue;
      lines.push("");
      lines.push(`${PRESENCE_SECTION_TITLE[kind]}:`);
      for (const row of rows) {
        const suffix = row.callSiteCount === 0 ? " (instantiated, no ACE calls)" : "";
        const exposedMarker = exposed ? " ⚠ exposed" : "";
        lines.push(`  ${row.name}   ${row.callSiteCount} call site(s)${suffix}${exposedMarker}`);
      }
    }
  }

  if (callSites.length > 0) {
    const aceByKey = new Map<string, AceEntry>();
    for (const ace of aces) {
      if (ace.kind === "expression") continue;
      aceByKey.set(aceKey(ace.kind, ace.id), ace);
    }

    const changedKeySet = blast !== undefined ? new Set(blast.changedKeys) : undefined;
    const removedKeySet = blast !== undefined ? new Set(blast.removedKeys) : undefined;

    const bySheet = new Map<string, CallSite[]>();
    for (const site of callSites) {
      let list = bySheet.get(site.sheet);
      if (!list) {
        list = [];
        bySheet.set(site.sheet, list);
      }
      list.push(site);
    }

    lines.push("");
    lines.push("Call sites:");
    for (const [sheet, sites] of bySheet) {
      lines.push(`  ${sheet}`);
      for (const site of sites) {
        lines.push(formatCallSiteLine(site, aceByKey, changedKeySet, removedKeySet));
      }
    }
  }

  return lines.join("\n");
}
