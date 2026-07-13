import * as fs from "node:fs";
import type { EventSheet } from "@genvidtech/c3source";
import { hasActions, hasConditions, openProject, visitEvents } from "@genvidtech/c3source";
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
 * Result of a plain (non-blast) `scanAddonUsage`. `blast` is left for a
 * follow-up step (P4, #110) that annotates dangling call sites — sites whose
 * `(kind, id)` no longer exists in the addon's current ACEs, e.g. after an
 * addon upgrade removed an action — without changing this shape's meaning.
 */
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
}

export type ScanAddonUsageResult = AddonUsageResult | { error: string };

// ── Internal helpers ─────────────────────────────────────────────────────────

function aceKey(kind: "condition" | "action", id: string): string {
  return `${kind}:${id}`;
}

const PRESENCE_KIND_ORDER: Record<ObjectDefn["kind"], number> = { objectType: 0, family: 1 };

function byPresenceOrder(a: ObjectDefn, b: ObjectDefn): number {
  const kindDiff = PRESENCE_KIND_ORDER[a.kind] - PRESENCE_KIND_ORDER[b.kind];
  if (kindDiff !== 0) return kindDiff;
  return a.name.localeCompare(b.name);
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
 * Errors as values, mirroring `addonAceDiff.resolveAceSource`: returns
 * `{ error }` when the addon can't be resolved. Never throws.
 */
export function scanAddonUsage(rootDir: string, addonArg: string): ScanAddonUsageResult {
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

  const project = openProject(rootDir);
  const objects = readProjectObjects(project);
  const matched = objects.filter((d) => d.pluginId === addonId).sort(byPresenceOrder);
  const nameSet = new Set(matched.map((d) => d.name));

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
          if (nameSet.has(cond.objectClass) && aceKeySet.has(aceKey("condition", cond.id))) {
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
          if (nameSet.has(action.objectClass) && aceKeySet.has(aceKey("action", action.id))) {
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
    callSiteCountByName.set(site.objectClass, (callSiteCountByName.get(site.objectClass) ?? 0) + 1);
  }

  const presence: PresenceRow[] = matched.map((d) => ({
    name: d.name,
    kind: d.kind,
    callSiteCount: callSiteCountByName.get(d.name) ?? 0,
  }));

  return { addonId, addonLabel: target.name, presence, callSites, aces };
}

// ── Formatter ────────────────────────────────────────────────────────────────

const PRESENCE_SECTION_TITLE: Record<PresenceRow["kind"], string> = {
  objectType: "Object types",
  family: "Families",
};

function formatCallSiteLine(site: CallSite, aceByKey: Map<string, AceEntry>): string {
  const ace = aceByKey.get(aceKey(site.kind, site.id));
  const paramNames = ace ? ace.params.map((p) => p.name).join(", ") : "";
  return `    event #${site.eventNumber ?? "?"}  ${site.jsonPath}   [${site.kind}] ${site.objectClass}.${site.id}(${paramNames})`;
}

/**
 * Render a `ScanAddonUsageResult` to plain text: a header + summary, a
 * presence section grouped by kind (Object types / Families), then a call
 * sites section grouped by event sheet. Shared by the CLI and MCP surfaces so
 * output stays byte-identical. Owns both the empty case (`No usage of addon
 * "<id>" found.`) and the error-value case so neither call site special-cases
 * them.
 */
export function formatAddonUsage(result: ScanAddonUsageResult): string {
  if ("error" in result) {
    return `scan-addon-usage: ${result.error}`;
  }

  const { addonId, presence, callSites, aces } = result;

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

  if (presence.length > 0) {
    for (const kind of ["objectType", "family"] as const) {
      const rows = presence.filter((p) => p.kind === kind);
      if (rows.length === 0) continue;
      lines.push("");
      lines.push(`${PRESENCE_SECTION_TITLE[kind]}:`);
      for (const row of rows) {
        const suffix = row.callSiteCount === 0 ? " (instantiated, no ACE calls)" : "";
        lines.push(`  ${row.name}   ${row.callSiteCount} call site(s)${suffix}`);
      }
    }
  }

  if (callSites.length > 0) {
    const aceByKey = new Map<string, AceEntry>();
    for (const ace of aces) {
      if (ace.kind === "expression") continue;
      aceByKey.set(aceKey(ace.kind, ace.id), ace);
    }

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
        lines.push(formatCallSiteLine(site, aceByKey));
      }
    }
  }

  return lines.join("\n");
}
