import * as fs from "node:fs";
import * as path from "node:path";
import type { C3Project } from "@genvidtech/c3source";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A behavior instance attached to an objectType/family, from its `behaviorTypes`
 * entry. `sid` is intentionally dropped — callers key on `(behaviorId, name)`.
 */
export interface BehaviorRef {
  behaviorId: string;
  name: string;
}

/**
 * An effect instance attached to an objectType/family, from its `effectTypes`
 * entry. `sid` is intentionally dropped — callers key on `(effectId, name)`.
 */
export interface EffectRef {
  effectId: string;
  name: string;
}

/**
 * A normalized `objectTypes/*.json` or `families/*.json` entry, addon-agnostic
 * (an object type's `plugin-id` names the C3 plugin/behavior it's an instance
 * of — a built-in like `Sprite` as readily as a third-party addon).
 */
export interface ObjectDefn {
  name: string;
  kind: "objectType" | "family";
  /** From the JSON `plugin-id` field; absent on malformed/legacy entries. */
  pluginId?: string;
  /** Family membership (object-type names); always `[]` for object types. */
  members: string[];
  /** Behavior instances from `behaviorTypes`; malformed entries are dropped. */
  behaviors: BehaviorRef[];
  /** Effect instances from `effectTypes`; malformed entries are dropped. */
  effectTypes: EffectRef[];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface RawBehaviorType {
  behaviorId?: unknown;
  name?: unknown;
}

interface RawEffectType {
  effectId?: unknown;
  name?: unknown;
}

function readBehaviors(behaviorTypes: unknown): BehaviorRef[] {
  if (!Array.isArray(behaviorTypes)) return [];
  const behaviors: BehaviorRef[] = [];
  for (const entry of behaviorTypes as RawBehaviorType[]) {
    if (typeof entry?.behaviorId === "string" && typeof entry?.name === "string") {
      behaviors.push({ behaviorId: entry.behaviorId, name: entry.name });
    }
  }
  return behaviors;
}

function readEffects(effectTypes: unknown): EffectRef[] {
  if (!Array.isArray(effectTypes)) return [];
  const effects: EffectRef[] = [];
  for (const entry of effectTypes as RawEffectType[]) {
    if (typeof entry?.effectId === "string" && typeof entry?.name === "string") {
      effects.push({ effectId: entry.effectId, name: entry.name });
    }
  }
  return effects;
}

function readObjectDefn(filePath: string, kind: "objectType" | "family"): ObjectDefn {
  const raw = fs.readFileSync(filePath, "utf-8");
  const json = JSON.parse(raw) as {
    name?: string;
    "plugin-id"?: string;
    members?: string[];
    behaviorTypes?: unknown;
    effectTypes?: unknown;
  };
  const name = json.name ?? path.basename(filePath, path.extname(filePath));
  const defn: ObjectDefn = {
    name,
    kind,
    members: kind === "family" ? (json.members ?? []) : [],
    behaviors: readBehaviors(json.behaviorTypes),
    effectTypes: readEffects(json.effectTypes),
  };
  if (json["plugin-id"] !== undefined) defn.pluginId = json["plugin-id"];
  return defn;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read and normalize every `objectTypes/*.json` and `families/*.json` entry
 * for `project` into one flat `ObjectDefn[]`. Shared read primitive — no
 * addon-specific filtering; callers (e.g. `scan-addon-usage`, #124/#125) cross
 * it against addon ACE ids themselves.
 */
export function readProjectObjects(project: C3Project): ObjectDefn[] {
  const objectTypes = project.findAllObjectTypes().map((f) => readObjectDefn(f, "objectType"));
  const families = project.findAllFamilies().map((f) => readObjectDefn(f, "family"));
  return [...objectTypes, ...families];
}

/**
 * An effect application site: an `effectTypes` entry on a layout's own
 * top-level `effectTypes[]` (`container: "layout"`) or on one of its layers/
 * sub-layers (`container: "layer"`). These live in `layouts/*.json`, distinct
 * from the object-type/family `effectTypes` in `ObjectDefn.effectTypes` — a
 * layout/layer effect application isn't tied to any object type.
 */
export interface LayoutEffectSite {
  effectId: string;
  name: string;
  container: "layer" | "layout";
  /** Layout display name (JSON `name` field). */
  layout: string;
  /** Layer display name; set only when `container === "layer"`. */
  layer?: string;
}

interface RawLayer {
  name?: unknown;
  effectTypes?: unknown;
  subLayers?: unknown;
}

function readLayerEffects(layers: unknown, layoutName: string, sites: LayoutEffectSite[]): void {
  if (!Array.isArray(layers)) return;
  for (const layer of layers as RawLayer[]) {
    const layerName = typeof layer?.name === "string" ? layer.name : "";
    for (const effect of readEffects(layer?.effectTypes)) {
      sites.push({ ...effect, container: "layer", layout: layoutName, layer: layerName });
    }
    readLayerEffects(layer?.subLayers, layoutName, sites);
  }
}

/**
 * Read every layout/layer effect **application site** (c/d in #125) across
 * `project`'s `layouts/*.json`: a layout's own top-level `effectTypes[]`
 * (`container: "layout"`) and every layer/sub-layer's `effectTypes[]`
 * (`container: "layer"`), recursing `subLayers` to arbitrary depth (mirrors
 * `generators.ts`'s `collectTemplateTypesFromLayers` walk). Distinct from
 * `readProjectObjects`'s per-object-type `effectTypes` — these effects are
 * applied at the layout/layer level, not on an object instance.
 */
export function readLayoutEffects(project: C3Project): LayoutEffectSite[] {
  const sites: LayoutEffectSite[] = [];
  for (const filePath of project.findAllLayouts()) {
    const raw = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(raw) as {
      name?: string;
      layers?: unknown;
      effectTypes?: unknown;
    };
    const layoutName = json.name ?? path.basename(filePath, path.extname(filePath));
    for (const effect of readEffects(json.effectTypes)) {
      sites.push({ ...effect, container: "layout", layout: layoutName });
    }
    readLayerEffects(json.layers, layoutName, sites);
  }
  return sites;
}
