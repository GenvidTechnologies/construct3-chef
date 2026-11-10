import { isDeepStrictEqual } from "node:util";
import type { EventSheet, EventSheetEvent } from "@genvidtech/c3source";
import { extractFunctions, hasActions, hasConditions, visitEvents } from "@genvidtech/c3source";
import { builtinParamSlot } from "./builtinBooleanParams.js";
import type { BuiltinParamAceKind, BuiltinParamSlot } from "./builtinBooleanParams.js";

/**
 * Pure check for the values a recipe writes into boolean slots of an event sheet.
 *
 * A "boolean" slot (a boolean function or custom-ACE parameter, or a built-in
 * boolean parameter) keeps only a constant: C3 loads any non-boolean value as true.
 * A "combo-bool" slot is a choice whose items are exactly "false" and "true": C3
 * stores the item string, so a native boolean there is normalized and any other
 * string is refused.
 *
 * The module does no file access. The caller feeds it parsed object-type records,
 * family records and event sheets. It is deliberately off the `src/index.ts` barrel.
 */

// ─── Types ───

export type BooleanSlotType = "boolean" | "combo-bool";

/** The part of an object-type or family record the owner resolver reads. */
export interface OwnerRecord {
  name: string;
  "plugin-id"?: string;
  behaviorTypes?: { name: string; behaviorId: string }[];
  /** Family records only: the names of the member object types. */
  members?: string[];
}

export interface OwnerResolver {
  /** The plugin id that owns `objectClass`; `"system"` for System; undefined for an unknown name. */
  pluginOwner(objectClass: string): string | undefined;
  /** The behavior id behind a behavior INSTANCE name on `objectClass` or on a family it belongs to. */
  behaviorOwner(objectClass: string, behaviorInstance: string): string | undefined;
  /** The names of the families that list `objectClass` as a member. */
  familiesOf(objectClass: string): readonly string[];
  /** True when `objectClass` is a known object type or family. */
  isKnown(objectClass: string): boolean;
}

/** One declared parameter of a callee. `type` is undefined when definitions disagree. */
export interface SignatureParam {
  name: string;
  type: "string" | "number" | "boolean" | undefined;
}

export interface SignatureIndex {
  /** Parameters of the function `name`, matched case-insensitively across the project. */
  fn(name: string): readonly SignatureParam[] | undefined;
  /** Parameters of the custom ACE `(objectClass, aceName)`, matched exactly. */
  customAce(objectClass: string, aceName: string): readonly SignatureParam[] | undefined;
}

type ParamRecord = Record<string, unknown>;

/** An action or condition parameter the recipe wrote, with its location. */
export interface WrittenSlot {
  /** The action or condition node inside the `modified` sheet. */
  node: ParamRecord;
  nodeKind: "action" | "condition";
  /** The parameter id (object form) or the 0-based position (array form). */
  key: string | number;
  value: unknown;
  /** Sheet locator, e.g. `events[0].children[1].actions[2]`. */
  locator: string;
  /** C3's 1-based number of the containing event; null for a non-counting event. */
  eventNumber: number | null;
  sid: number | undefined;
}

export type SlotTarget =
  | { kind: "function"; name: string; position: number; paramName: string }
  | { kind: "custom-action"; name: string; position: number; paramName: string }
  | { kind: "builtin"; aceKind: BuiltinParamAceKind; aceId: string; paramId: string };

export interface SlotClassification {
  type: BooleanSlotType;
  /** The editor's initial value for a combo-bool slot; null when none is declared. */
  initialValue: string | null;
  target: SlotTarget;
}

export interface BooleanSlotFinding {
  /** The recipe's file key, e.g. `eventSheets/X.json`. */
  fileKey: string;
  locator: string;
  eventNumber: number | null;
  sid: number | undefined;
  value: unknown;
  classification: SlotClassification;
}

// ─── Callee index ───

const functionKey = (name: string): string => name.normalize().toLowerCase();
const customKey = (objectClass: string, aceName: string): string => JSON.stringify([objectClass, aceName]);

type RawParam = { name: string; type: "string" | "number" | "boolean" };

/**
 * Merge every definition of one callee into per-position parameters. A position
 * keeps its type only when every definition has that position with the same type.
 */
function mergeDefinitions(defs: RawParam[][]): SignatureParam[] {
  const width = Math.max(...defs.map((d) => d.length));
  const merged: SignatureParam[] = [];
  for (let i = 0; i < width; i++) {
    const present = defs.filter((d) => i < d.length).map((d) => d[i]);
    const first = present[0];
    const agree = present.length === defs.length && present.every((p) => p.type === first.type);
    merged.push({ name: first.name, type: agree ? first.type : undefined });
  }
  return merged;
}

/**
 * Index the parameter types of every function and custom ACE the given sheets
 * define. The C3 editor compares function names case-insensitively across the
 * whole project with no include-tree scoping, so every sheet contributes.
 */
export function buildSignatureIndex(sheets: Iterable<EventSheet>): SignatureIndex {
  const fnDefs = new Map<string, RawParam[][]>();
  const aceDefs = new Map<string, RawParam[][]>();
  const push = (map: Map<string, RawParam[][]>, key: string, params: RawParam[]): void => {
    const list = map.get(key);
    if (list) list.push(params);
    else map.set(key, [params]);
  };
  for (const sheet of sheets) {
    for (const def of extractFunctions(sheet)) {
      const params = (def.params ?? []).map((p) => ({ name: p.name, type: p.type }));
      if (def.kind === "function") {
        push(fnDefs, functionKey(def.name), params);
      } else if (def.objectClass != null) {
        push(aceDefs, customKey(def.objectClass, def.name), params);
      }
    }
  }
  const fnMerged = new Map([...fnDefs].map(([k, v]) => [k, mergeDefinitions(v)]));
  const aceMerged = new Map([...aceDefs].map(([k, v]) => [k, mergeDefinitions(v)]));
  return {
    fn: (name) => fnMerged.get(functionKey(name)),
    customAce: (objectClass, aceName) => aceMerged.get(customKey(objectClass, aceName)),
  };
}

// ─── Owner resolution ───

/** Build an owner resolver from parsed object-type and family records. */
export function buildOwnerResolver(objectTypes: Iterable<OwnerRecord>, families: Iterable<OwnerRecord>): OwnerResolver {
  const records = new Map<string, OwnerRecord>();
  const memberToFamilies = new Map<string, string[]>();
  for (const rec of objectTypes) {
    if (rec && typeof rec.name === "string") records.set(rec.name, rec);
  }
  for (const fam of families) {
    if (!fam || typeof fam.name !== "string") continue;
    records.set(fam.name, fam);
    if (!Array.isArray(fam.members)) continue;
    for (const member of fam.members) {
      const list = memberToFamilies.get(member);
      if (list) list.push(fam.name);
      else memberToFamilies.set(member, [fam.name]);
    }
  }
  const familiesOf = (objectClass: string): readonly string[] => memberToFamilies.get(objectClass) ?? [];
  return {
    pluginOwner(objectClass) {
      if (objectClass === "System") return "system";
      const id = records.get(objectClass)?.["plugin-id"];
      return typeof id === "string" ? id : undefined;
    },
    behaviorOwner(objectClass, behaviorInstance) {
      // A behavior instance lives on the object type itself or on a family it belongs to.
      for (const name of [objectClass, ...familiesOf(objectClass)]) {
        const found = records.get(name)?.behaviorTypes?.find((b) => b.name === behaviorInstance);
        if (found) return found.behaviorId;
      }
      return undefined;
    },
    familiesOf,
    isKnown: (objectClass) => objectClass === "System" || records.has(objectClass),
  };
}

/**
 * Find the built-in boolean-slot row for a standard action or condition.
 *
 * - With a `behaviorType`, only a behavior row (keyed by behavior id) can apply.
 * - Otherwise the plugin owner's row applies; when that owner has no row for the
 *   parameter, the common rows apply, except for System.
 * - An object class that is neither System nor a known object type or family has
 *   no owner, so nothing is checked.
 */
export function resolveBuiltinSlot(
  owners: OwnerResolver,
  aceKind: BuiltinParamAceKind,
  objectClass: string,
  behaviorType: string | undefined,
  aceId: string,
  paramId: string,
): BuiltinParamSlot | undefined {
  if (behaviorType !== undefined) {
    const behaviorId = owners.behaviorOwner(objectClass, behaviorType);
    return behaviorId === undefined ? undefined : builtinParamSlot("behavior", behaviorId, aceKind, aceId, paramId);
  }
  const plugin = owners.pluginOwner(objectClass);
  if (plugin === undefined) return undefined;
  const pluginRow = builtinParamSlot("plugin", plugin, aceKind, aceId, paramId);
  if (pluginRow || objectClass === "System") return pluginRow;
  for (const common of ["instance-variables", "size-position", "hierarchy", "mesh"]) {
    const row = builtinParamSlot("common", common, aceKind, aceId, paramId);
    if (row) return row;
  }
  return undefined;
}

// ─── Written slots ───

type Nodes = Record<string, unknown>[];

function paramEntries(node: ParamRecord): [string | number, unknown][] {
  const params = node.parameters;
  if (Array.isArray(params)) return params.map((v, i): [number, unknown] => [i, v]);
  if (params !== null && typeof params === "object") return Object.entries(params as ParamRecord);
  return [];
}

function paramAt(node: ParamRecord | undefined, key: string | number): { has: boolean; value: unknown } {
  const params = node?.parameters;
  if (Array.isArray(params) && typeof key === "number") return { has: key < params.length, value: params[key] };
  if (params !== null && typeof params === "object" && !Array.isArray(params) && typeof key === "string") {
    const rec = params as ParamRecord;
    return { has: key in rec, value: rec[key] };
  }
  return { has: false, value: undefined };
}

function forEachNode(
  sheet: EventSheet,
  visit: (
    node: ParamRecord,
    nodeKind: "action" | "condition",
    locator: string,
    eventNumber: number | null,
    event: EventSheetEvent,
  ) => void,
): void {
  visitEvents(sheet.events, (event, ctx) => {
    if (hasConditions(event)) {
      (event.conditions as unknown as Nodes).forEach((c, i) =>
        visit(c, "condition", `${ctx.jsonPath}.conditions[${i}]`, ctx.eventNumber, event),
      );
    }
    if (hasActions(event)) {
      (event.actions as unknown as Nodes).forEach((a, i) =>
        visit(a, "action", `${ctx.jsonPath}.actions[${i}]`, ctx.eventNumber, event),
      );
    }
  });
}

/**
 * List the action and condition parameters that `modified` writes relative to
 * `original`. A node whose SID is absent from `original` is new: every parameter
 * is written. A node whose SID exists contributes only the parameters whose value
 * differs, compared per key (object form) or per position (array form).
 */
export function findWrittenSlots(original: EventSheet, modified: EventSheet): WrittenSlot[] {
  const originals = new Map<string, ParamRecord>();
  forEachNode(original, (node, nodeKind) => {
    if (typeof node.sid === "number") originals.set(`${nodeKind}:${node.sid}`, node);
  });
  const slots: WrittenSlot[] = [];
  forEachNode(modified, (node, nodeKind, locator, eventNumber) => {
    const sid = typeof node.sid === "number" ? node.sid : undefined;
    const before = sid === undefined ? undefined : originals.get(`${nodeKind}:${sid}`);
    for (const [key, value] of paramEntries(node)) {
      if (before) {
        const prior = paramAt(before, key);
        if (prior.has && isDeepStrictEqual(prior.value, value)) continue;
      }
      slots.push({ node, nodeKind, key, value, locator, eventNumber, sid });
    }
  });
  return slots;
}

// ─── Classification ───

/**
 * Classify a written slot as a boolean or a combo-bool, or return undefined when
 * the slot is not known to be either (unknown callee, a position beyond the
 * callee's parameters, definitions that disagree, or no built-in row).
 */
export function classifySlot(
  slot: WrittenSlot,
  signatures: SignatureIndex | undefined,
  owners: OwnerResolver,
): SlotClassification | undefined {
  const node = slot.node;
  if (slot.nodeKind === "action" && typeof node.callFunction === "string" && typeof slot.key === "number") {
    // C3 pairs call argument i with the callee's functionParameters[i] by position.
    const param = signatures?.fn(node.callFunction)?.[slot.key];
    if (param?.type !== "boolean") return undefined;
    return {
      type: "boolean",
      initialValue: null,
      target: { kind: "function", name: node.callFunction, position: slot.key + 1, paramName: param.name },
    };
  }
  if (slot.nodeKind === "action" && typeof node.customAction === "string" && typeof slot.key === "number") {
    const aceName = node.customAction;
    const objectClass = typeof node.objectClass === "string" ? node.objectClass : undefined;
    const override = node.customActionObjectClass;
    let params: readonly SignatureParam[] | undefined;
    if (typeof override === "string") {
      params = signatures?.customAce(override, aceName);
    } else if (objectClass !== undefined) {
      params = signatures?.customAce(objectClass, aceName);
      if (!params) {
        // Same fallback as customAceIndex: the first family of the object that defines the ACE.
        for (const family of owners.familiesOf(objectClass)) {
          params = signatures?.customAce(family, aceName);
          if (params) break;
        }
      }
    }
    // Argument i pairs with the custom ACE's functionParameters[i] by position, as for functions.
    const param = params?.[slot.key];
    if (param?.type !== "boolean") return undefined;
    return {
      type: "boolean",
      initialValue: null,
      target: { kind: "custom-action", name: aceName, position: slot.key + 1, paramName: param.name },
    };
  }
  if (typeof node.id === "string" && typeof node.objectClass === "string" && typeof slot.key === "string") {
    const behaviorType = typeof node.behaviorType === "string" ? node.behaviorType : undefined;
    const row = resolveBuiltinSlot(owners, slot.nodeKind, node.objectClass, behaviorType, node.id, slot.key);
    if (!row) return undefined;
    return {
      type: row.paramType,
      initialValue: row.initialValue,
      target: { kind: "builtin", aceKind: slot.nodeKind, aceId: node.id, paramId: slot.key },
    };
  }
  return undefined;
}

// ─── Normalization ───

/**
 * Write the item string into every written combo-bool slot that holds a native
 * boolean, and report each change through `log`. Mutates `modified` in place.
 * Returns the number of slots changed.
 */
export function normalizeWrittenComboBools(
  original: EventSheet,
  modified: EventSheet,
  owners: OwnerResolver,
  log: (line: string) => void,
): number {
  let count = 0;
  for (const slot of findWrittenSlots(original, modified)) {
    if (typeof slot.value !== "boolean") continue;
    const cls = classifySlot(slot, undefined, owners);
    if (cls?.type !== "combo-bool" || cls.target.kind !== "builtin") continue;
    const params = slot.node.parameters as ParamRecord;
    params[slot.key as string] = String(slot.value);
    log(
      `normalized ${cls.target.aceId} "${cls.target.paramId}": ${String(slot.value)} → "${String(slot.value)}" (C3 stores this choice as a string)`,
    );
    count++;
  }
  return count;
}

// ─── Violations ───

/** True when the written value is acceptable for the slot type. */
function acceptsValue(type: BooleanSlotType, value: unknown): boolean {
  if (type === "boolean") return typeof value === "boolean";
  return value === "true" || value === "false";
}

/**
 * Find the written slots whose value the slot type does not accept. A boolean slot
 * accepts only a native boolean. A combo-bool slot accepts only the strings "true"
 * and "false" (a native boolean has been normalized before this check runs).
 */
export function findBooleanSlotViolations(
  fileKey: string,
  slots: readonly WrittenSlot[],
  signatures: SignatureIndex,
  owners: OwnerResolver,
): BooleanSlotFinding[] {
  const findings: BooleanSlotFinding[] = [];
  for (const slot of slots) {
    const cls = classifySlot(slot, signatures, owners);
    if (!cls || acceptsValue(cls.type, slot.value)) continue;
    findings.push({
      fileKey,
      locator: slot.locator,
      eventNumber: slot.eventNumber,
      sid: slot.sid,
      value: slot.value,
      classification: cls,
    });
  }
  return findings;
}

// ─── Rendering ───

const REMEDY =
  'For a computed value, branch with a condition and "else", pass a number and test it with != 0, or use a script block.';

function slotPhrase(target: SlotTarget): string {
  switch (target.kind) {
    case "function":
      return `function "${target.name}" parameter ${target.position} "${target.paramName}"`;
    case "custom-action":
      return `custom action "${target.name}" parameter ${target.position} "${target.paramName}"`;
    case "builtin":
      return `${target.aceKind} "${target.aceId}" parameter "${target.paramId}"`;
  }
}

function renderValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** Render one finding as a single line. */
export function formatBooleanSlotFinding(f: BooleanSlotFinding): string {
  const where = [
    f.eventNumber === null ? undefined : `event ${f.eventNumber}`,
    f.sid === undefined ? undefined : `sid ${f.sid}`,
  ].filter((p) => p !== undefined);
  const prefix = `${f.fileKey} ${f.locator}${where.length > 0 ? ` (${where.join(", ")})` : ""}: `;
  const phrase = slotPhrase(f.classification.target);
  let body: string;
  if (f.classification.type === "boolean") {
    if (f.value === "true" || f.value === "false") {
      body = `${phrase} is boolean, but the recipe writes the string "${f.value}", which C3 loads as true. Write the native boolean ${f.value} (no quotes).`;
    } else {
      body = `${phrase} is boolean, but the recipe writes ${renderValue(f.value)}. C3 keeps only true or false here: it loads an empty string, 0 or null as false and any other value as true. Write a native true or false.`;
    }
  } else {
    const iv = f.classification.initialValue;
    const fallback = iv === null ? "its default" : `its default ("${iv}")`;
    body = `${phrase} is a "true"/"false" choice, but the recipe writes ${renderValue(f.value)}. C3 accepts only the strings "true" or "false" here and replaces any other value with ${fallback} when the project loads.`;
  }
  return `${prefix}${body} ${REMEDY}`;
}

/** Render the whole failure: a header and one `\n  - <line>` per finding. */
export function formatBooleanSlotFailure(findings: readonly BooleanSlotFinding[]): string {
  return `Boolean-slot validation failed:${findings.map((f) => `\n  - ${formatBooleanSlotFinding(f)}`).join("")}`;
}
