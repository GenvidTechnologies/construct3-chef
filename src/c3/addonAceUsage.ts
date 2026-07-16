import * as fs from "node:fs";
import type { EventSheet } from "@genvidtech/c3source";
import { hasActions, hasConditions, openProject, visitEvents } from "@genvidtech/c3source";
import { diffAddonAces, resolveAceSource } from "./addonAceDiff.js";
import { resolveAddonTarget, type DiscoveredAddon } from "./addonDiscovery.js";
import { readAddonAces, resolveAddonId } from "./addonReader.js";
import type { AceEntry } from "./c3Reference.js";
import { isStandardAction, type C3Action } from "./eventSheetMutator.js";
import { readLayoutEffects, readProjectObjects, type ObjectDefn } from "./projectObjects.js";

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
  /**
   * Behavior instance name(s) this host attached the scanned addon under
   * (from `behaviorTypes[].name`) — e.g. `["MyCustomBehavior"]`, or
   * `["Timer", "Timer2"]` for two instances of the same behavior on one
   * host. Present only on behavior-kind scans ({@link
   * createBehaviorUsageMatcher}); plugin/effect presence rows never carry
   * this field (a plugin instance has no comparable per-instance name).
   */
  instanceNames?: string[];
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

/**
 * An effect **application site**: an `effectTypes` entry naming the scanned
 * effect addon, on an object type/family ({@link ObjectDefn.effectTypes}) or
 * on a layout/layer ({@link LayoutEffectSite}). Unlike a plugin/behavior
 * `CallSite`, an effect has no event-sheet call — its "usage" IS the
 * application site, so `EffectSite` is effect scanning's analogue of both
 * `PresenceRow` and `CallSite` at once.
 */
export interface EffectSite {
  effectId: string;
  /** The `effectTypes` entry's own display name (e.g. "Burn", "Sepia"). */
  name: string;
  container: "objectType" | "family" | "layout" | "layer";
  /** Object type/family name, or layout display name. */
  host: string;
  /** Layer display name; set only when `container === "layer"`. */
  layer?: string;
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
  /**
   * The resolved addon's kind, mirroring `DiscoveredAddon.kind`. Optional so
   * the ~9 existing synthetic `AddonUsageResult` test literals (predating
   * this field) don't need updating; set on every real `scanAddonUsage`/
   * {@link scanEffectUsage} result.
   */
  kind?: "plugin" | "behavior" | "effect";
  /**
   * Effect application sites, present only on an effect scan
   * ({@link scanEffectUsage}) — `presence`/`callSites` stay empty for an
   * effect result, since effects have no event-sheet call sites.
   */
  effectSites?: EffectSite[];
  /** Present only when `scanAddonUsage`/`scanEffectUsage` was called with a `fromArg`. */
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

/**
 * A condition/action node as seen mid-walk, before it's known to be a call
 * site. `behaviorType` is the node's own behavior-instance name (present on
 * behavior-scoped conditions/actions only); the plugin matcher ignores it,
 * the behavior matcher requires it.
 */
interface CallCandidate {
  objectClass: string;
  kind: "condition" | "action";
  id: string;
  behaviorType?: string;
}

/**
 * Isolates the addon-kind-specific pieces of a usage scan (presence +
 * per-node match rule + call-site attribution) behind a common seam, so the
 * event-sheet-walk shell, blast-radius wiring, result assembly, and
 * {@link formatAddonUsage} stay shared/kind-agnostic across addon kinds:
 * {@link createPluginUsageMatcher} for plugins/effects, {@link
 * createBehaviorUsageMatcher} for behaviors.
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

/**
 * Builds the behavior {@link UsageMatcher}: presence is every object
 * type/family whose `behaviors[]` contains an entry with
 * `behaviorId === addonId` — i.e. it carries its OWN instance of the
 * behavior, never a family member (a member inherits the family's behavior
 * rather than attaching its own instance, so members are deliberately
 * excluded from presence).
 *
 * A behavior-scoped condition/action node identifies which behavior
 * *instance* it calls by name (`behaviorType`), not by addon id, and a host
 * may rename its instance (or attach two instances of the same behavior
 * under different names) — so the match rule widens to the UNION of
 * instance names across every presence host, then narrows back down with an
 * `objectClass` attribution check: a node matches only when its
 * `behaviorType` is one of those instance names, its `objectClass` is
 * attributable (a presence host itself, or a member of a presence family),
 * and its `(kind, id)` is in `matchKeySet`. The `objectClass` check is what
 * stops an unrelated object from matching just because it happens to reuse
 * the same instance-name string for a different behavior.
 *
 * Attribution routes a family-member call site (real `objectClass`, e.g.
 * `"Text"`) to its owning family's presence row (`"TextFamily"`) without
 * altering the `CallSite`'s own `objectClass` — the call site itself still
 * records which object actually made the call; only the aggregated
 * `callSiteCount` is attributed to the family. Presence hosts map to
 * themselves. `matched` is iterated in `byPresenceOrder` (object types
 * before families), so a family's member-mapping entries are written after
 * — and take precedence over — any self-mapping entry from a same-named
 * object type that also happens to carry its own instance of the behavior.
 *
 * Each presence row also carries {@link PresenceRow.instanceNames} — the
 * host's own `behaviorTypes[].name` entries matching `addonId` (so
 * {@link formatAddonUsage} can render which instance(s) a host attached,
 * distinct from the addon-wide instance-name UNION used for matching above).
 *
 * Exported (this module is off the `src/index.ts` barrel, so this isn't
 * published API) so tests can drive the family-member attribution rule
 * directly against synthetic `ObjectDefn`s/nodes: the project's own
 * `TextFamily`/`Timer` fixture data exercises the real shape, but `Timer` is
 * a C3 built-in with no addon package to scan end-to-end through {@link
 * scanAddonUsage}.
 */
export function createBehaviorUsageMatcher(
  addonId: string,
  objects: ObjectDefn[],
  matchKeySet: Set<string>,
): UsageMatcher {
  const matched = objects.filter((d) => d.behaviors.some((b) => b.behaviorId === addonId)).sort(byPresenceOrder);

  const instanceNameSet = new Set<string>();
  for (const d of matched) {
    for (const b of d.behaviors) {
      if (b.behaviorId === addonId) instanceNameSet.add(b.name);
    }
  }

  const attributeMap = new Map<string, string>();
  for (const d of matched) {
    attributeMap.set(d.name, d.name);
    if (d.kind === "family") {
      for (const member of d.members) {
        attributeMap.set(member, d.name);
      }
    }
  }

  return {
    presence: matched.map((d) => ({
      name: d.name,
      kind: d.kind,
      instanceNames: d.behaviors.filter((b) => b.behaviorId === addonId).map((b) => b.name),
    })),
    matches: (node) =>
      node.behaviorType !== undefined &&
      instanceNameSet.has(node.behaviorType) &&
      attributeMap.has(node.objectClass) &&
      matchKeySet.has(aceKey(node.kind, node.id)),
    attributeTo: (objectClass) => attributeMap.get(objectClass),
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
 * 2. Reads every `objectTypes/*.json` / `families/*.json` entry
 *    ({@link readProjectObjects}) and routes on the resolved addon's `kind`
 *    to build the presence set + per-node match rule: `plugin` addons use
 *    {@link createPluginUsageMatcher} (presence = entries whose `plugin-id`
 *    names the addon); `behavior` addons use {@link
 *    createBehaviorUsageMatcher} (presence = entries carrying their own
 *    instance of the behavior in `behaviorTypes`; family members are
 *    attributed to their family's presence row instead of getting their
 *    own). `effect` addons never reach this step — they short-circuit to
 *    {@link scanEffectUsage} above, since effects have no ACEs and presence
 *    (application) is the whole story.
 * 3. Walks every event sheet's conditions/actions; a node counts as a call
 *    site when the matcher's `matches` rule accepts it — which always
 *    includes its `(kind, id)` matching a current ACE. Conditions and
 *    actions only — expression usage isn't a structured node and is out of
 *    scope here (tracked separately).
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

  // Effects have no ACEs and no event-sheet call sites — presence IS usage,
  // so they take a dedicated layout/objectType-side path that bypasses the
  // ACE read + event walk entirely (see {@link scanEffectUsage}).
  if (target.kind === "effect") {
    return scanEffectUsage(rootDir, target, fromArg);
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
  const matcher =
    target.kind === "behavior"
      ? createBehaviorUsageMatcher(addonId, objects, matchKeySet)
      : createPluginUsageMatcher(addonId, objects, matchKeySet);

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
          if (
            matcher.matches({
              objectClass: cond.objectClass,
              kind: "condition",
              id: cond.id,
              behaviorType: cond.behaviorType,
            })
          ) {
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
          if (
            matcher.matches({
              objectClass: action.objectClass,
              kind: "action",
              id: action.id,
              behaviorType: action.behaviorType,
            })
          ) {
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

  return {
    addonId,
    addonLabel: target.name,
    presence,
    callSites,
    aces,
    kind: target.kind,
    ...(blast !== undefined ? { blast } : {}),
  };
}

// ── Effect scanning ──────────────────────────────────────────────────────────

const EFFECT_SITE_CONTAINER_ORDER: Record<EffectSite["container"], number> = {
  objectType: 0,
  family: 1,
  layout: 2,
  layer: 3,
};

function byEffectSiteOrder(a: EffectSite, b: EffectSite): number {
  const containerDiff = EFFECT_SITE_CONTAINER_ORDER[a.container] - EFFECT_SITE_CONTAINER_ORDER[b.container];
  if (containerDiff !== 0) return containerDiff;
  const hostDiff = a.host.localeCompare(b.host);
  if (hostDiff !== 0) return hostDiff;
  return a.name.localeCompare(b.name);
}

/**
 * Scan a project for **application sites** of `target` (an already-resolved
 * effect addon — callers get one from {@link resolveAddonTarget}) rather than
 * event-sheet call sites: effects have no ACEs to call, they're *applied* to
 * an object type/family ({@link readProjectObjects}'s `effectTypes`) or a
 * layout/layer ({@link readLayoutEffects}). Sites are sorted objectType →
 * family → layout → layer, then by host name, then by effect-instance name.
 *
 * Optional blast-radius mode mirrors `scanAddonUsage`'s `fromArg`, resolved
 * the same way ({@link resolveAceSource}, not contained to `rootDir`) — but
 * since effects have no ACEs to diff, `changedKeys`/`removedKeys` are always
 * empty and `affectedCount` is simply every application site (a version bump
 * touches every instance of an applied effect, there's no per-site diff to
 * narrow it).
 *
 * Errors as values (mirrors `scanAddonUsage`): returns `{ error }` only when,
 * in blast mode, the `from` source can't be resolved. Never throws.
 *
 * NOT wired into the public {@link scanAddonUsage} dispatch yet (P3 of #125)
 * — that's a follow-up (F1): calling `scanAddonUsage(rootDir, effectAddonId)`
 * today still routes an effect target through the plugin matcher and returns
 * no `effectSites`.
 */
export function scanEffectUsage(rootDir: string, target: DiscoveredAddon, fromArg?: string): ScanAddonUsageResult {
  const addonId = resolveAddonId(target);

  const project = openProject(rootDir);
  const objects = readProjectObjects(project);

  const effectSites: EffectSite[] = [];

  for (const d of objects) {
    for (const e of d.effectTypes) {
      if (e.effectId !== addonId) continue;
      effectSites.push({
        effectId: addonId,
        name: e.name,
        container: d.kind === "family" ? "family" : "objectType",
        host: d.name,
      });
    }
  }

  for (const s of readLayoutEffects(project)) {
    if (s.effectId !== addonId) continue;
    effectSites.push({
      effectId: addonId,
      name: s.name,
      container: s.container,
      host: s.layout,
      ...(s.layer !== undefined ? { layer: s.layer } : {}),
    });
  }

  effectSites.sort(byEffectSiteOrder);

  let blast: BlastInfo | undefined;
  if (fromArg !== undefined) {
    const fromSource = resolveAceSource(rootDir, fromArg);
    if ("error" in fromSource) {
      return { error: fromSource.error };
    }
    blast = { fromLabel: fromSource.label, changedKeys: [], removedKeys: [], affectedCount: effectSites.length };
  }

  return {
    addonId,
    addonLabel: target.name,
    presence: [],
    callSites: [],
    aces: [],
    kind: "effect",
    effectSites,
    ...(blast !== undefined ? { blast } : {}),
  };
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

function formatEffectSiteLine(site: EffectSite, exposed: boolean): string {
  const marker = exposed ? " ⚠ exposed" : "";
  const hostSegment =
    site.container === "layout"
      ? `${site.host} (layout stack)`
      : site.container === "layer"
        ? `${site.host} / ${site.layer}`
        : site.host;
  return `  ${hostSegment}   [${site.name}]${marker}`;
}

/**
 * Render an effect-scan `AddonUsageResult` ({@link scanEffectUsage}). Owns
 * the same empty-case sentence as the plugin/behavior path (an effect with
 * zero application sites), so the caller never special-cases it — this is
 * why {@link formatAddonUsage} dispatches here BEFORE its own
 * `presence`/`callSites` empty check, which would otherwise misfire (an
 * effect result always carries empty `presence`/`callSites`).
 *
 * Sites are grouped into three headed sections in the same
 * objectType → family → layout/layer order {@link scanEffectUsage} sorts
 * them in: `Object types:` / `Families:` (rendered `<host>   [<name>]`) and
 * `Layouts:` (a `layout`-container site renders `<host> (layout stack)`, a
 * `layer`-container site renders `<host> / <layer>`). When `result.blast` is
 * present, EVERY site line gets a trailing ` ⚠ exposed` marker — effects have
 * no per-site ACE diff, so (unlike the plugin/behavior CHANGED/REMOVED
 * markers) a version bump exposes every application site uniformly.
 */
function formatEffectUsage(result: AddonUsageResult): string {
  const { addonId, blast } = result;
  const effectSites = result.effectSites ?? [];

  if (effectSites.length === 0) {
    return `No usage of addon "${addonId}" found.`;
  }

  const lines: string[] = [`scan-addon-usage: ${addonId} (effect)`, `applied at ${effectSites.length} site(s)`];

  if (blast !== undefined) {
    lines.push(`blast radius (vs ${blast.fromLabel}): ${blast.affectedCount} site(s) affected by version bump`);
  }

  const exposed = blast !== undefined;

  const objectTypeSites = effectSites.filter((s) => s.container === "objectType");
  const familySites = effectSites.filter((s) => s.container === "family");
  const layoutSites = effectSites.filter((s) => s.container === "layout" || s.container === "layer");

  if (objectTypeSites.length > 0) {
    lines.push("");
    lines.push("Object types:");
    for (const site of objectTypeSites) lines.push(formatEffectSiteLine(site, exposed));
  }

  if (familySites.length > 0) {
    lines.push("");
    lines.push("Families:");
    for (const site of familySites) lines.push(formatEffectSiteLine(site, exposed));
  }

  if (layoutSites.length > 0) {
    lines.push("");
    lines.push("Layouts:");
    for (const site of layoutSites) lines.push(formatEffectSiteLine(site, exposed));
  }

  return lines.join("\n");
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
 *
 * On a behavior scan, a presence row whose {@link PresenceRow.instanceNames}
 * is non-empty renders a trailing `[instanceName]` segment right after the
 * row's name (`[InstanceA, InstanceB]` when a host carries two instances of
 * the scanned behavior) — plugin/effect presence rows never carry
 * `instanceNames`, so their rendering is unchanged.
 */
export function formatAddonUsage(result: ScanAddonUsageResult): string {
  if ("error" in result) {
    return `scan-addon-usage: ${result.error}`;
  }

  if (result.kind === "effect") {
    return formatEffectUsage(result);
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
        const instanceSegment =
          row.instanceNames !== undefined && row.instanceNames.length > 0 ? ` [${row.instanceNames.join(", ")}]` : "";
        lines.push(`  ${row.name}${instanceSegment}   ${row.callSiteCount} call site(s)${suffix}${exposedMarker}`);
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
