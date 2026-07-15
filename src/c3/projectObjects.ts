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
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface RawBehaviorType {
  behaviorId?: unknown;
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

function readObjectDefn(filePath: string, kind: "objectType" | "family"): ObjectDefn {
  const raw = fs.readFileSync(filePath, "utf-8");
  const json = JSON.parse(raw) as {
    name?: string;
    "plugin-id"?: string;
    members?: string[];
    behaviorTypes?: unknown;
  };
  const name = json.name ?? path.basename(filePath, path.extname(filePath));
  const defn: ObjectDefn = {
    name,
    kind,
    members: kind === "family" ? (json.members ?? []) : [],
    behaviors: readBehaviors(json.behaviorTypes),
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
