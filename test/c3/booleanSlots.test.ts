import { describe, it } from "mocha";
import { assert } from "chai";
import * as c3source from "@genvidtech/c3source";
import type { EventSheet } from "@genvidtech/c3source";
import { BUILTIN_PARAM_SLOTS, builtinParamSlot } from "../../src/c3/builtinBooleanParams.js";
import {
  buildOwnerResolver,
  buildSignatureIndex,
  classifySlot,
  findBooleanSlotViolations,
  findWrittenSlots,
  formatBooleanSlotFailure,
  formatBooleanSlotFinding,
  normalizeWrittenComboBools,
} from "../../src/c3/booleanSlots.js";
import type { WrittenSlot } from "../../src/c3/booleanSlots.js";

// Tests for the built-in boolean-slot table (a local bridge until c3source ships it).

describe("builtin boolean param table", () => {
  it("I371-R12: the table has 117 rows with a known paramType", () => {
    assert.equal(BUILTIN_PARAM_SLOTS.length, 117);
    for (const s of BUILTIN_PARAM_SLOTS) {
      assert.include(["boolean", "combo-bool"], s.paramType, `${s.owner}/${s.aceId}/${s.paramId}`);
    }
  });

  it("I371-R12: the full tuple is unique and resolves to its own row", () => {
    const keys = new Set<string>();
    for (const s of BUILTIN_PARAM_SLOTS) {
      keys.add(JSON.stringify([s.ownerKind, s.owner, s.kind, s.aceId, s.paramId]));
      assert.strictEqual(builtinParamSlot(s.ownerKind, s.owner, s.kind, s.aceId, s.paramId), s);
    }
    assert.equal(keys.size, BUILTIN_PARAM_SLOTS.length);
    assert.isUndefined(builtinParamSlot("plugin", "no-such-owner", "action", "x", "y"));
  });

  it("I371-R12: the rows split into the expected classes", () => {
    const counts: Record<string, number> = {};
    for (const s of BUILTIN_PARAM_SLOTS) {
      const k = `${s.ownerKind}/${s.paramType}/${s.kind}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    assert.deepEqual(counts, {
      "plugin/combo-bool/action": 10,
      "plugin/boolean/action": 67,
      "plugin/boolean/condition": 2,
      "behavior/boolean/action": 24,
      "common/boolean/condition": 2,
      "common/combo-bool/action": 1,
      "common/boolean/action": 11,
    });
  });
});

// One predicate serves the real check and the synthetic positive control.
// Add the name of an export that matches but is not the boolean-slot table.
const ALLOWED_EXPORT_NAMES: readonly string[] = [];

function tableLikeExports(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((name) => /bool|param|combo/i.test(name) && !ALLOWED_EXPORT_NAMES.includes(name));
}

describe("c3source boolean-slot tripwire", () => {
  it("I371-T1: c3source does not yet export a boolean-slot table", () => {
    assert.deepEqual(
      tableLikeExports({ ACE_PARAM_TYPES: [] }),
      ["ACE_PARAM_TYPES"],
      "the predicate must flag a synthetic table-like export",
    );
    const mod = c3source as unknown as Record<string, unknown>;
    assert.isAtLeast(
      Object.keys(mod).filter((n) => /eventvar/i.test(n)).length,
      1,
      "positive control: /eventvar/i must match a real export, or the export enumeration is broken",
    );
    const found = tableLikeExports(mod);
    assert.deepEqual(
      found,
      [],
      `c3source now exports ${JSON.stringify(found)}, which may be the boolean-slot table (c3source#132). Retire the local bridge:\n` +
        "  1. Check that the matched export is the boolean-slot table. If it is not, add its name to ALLOWED_EXPORT_NAMES in this test and stop.\n" +
        "  2. Delete src/c3/builtinBooleanParams.ts, its import in src/c3/booleanSlots.ts, and the I371-T1: and I371-R12: tests.\n" +
        "  3. Switch the lookup to the upstream export.\n" +
        "  4. Revert-confirm that I371-R3:, I371-R4:, I371-R6: and I371-R7: stay green.",
    );
  });
});

// ─── Pure boolean-slot module ───

type Json = Record<string, unknown>;

const fnBlock = (name: string, params: [string, "string" | "number" | "boolean"][], sid = 1): Json => ({
  eventType: "function-block",
  functionName: name,
  functionDescription: "",
  functionCategory: "",
  functionReturnType: "none",
  functionCopyPicked: false,
  functionIsAsync: false,
  functionParameters: params.map(([n, type], i) => ({ name: n, type, initialValue: "", sid: 900 + i })),
  conditions: [],
  actions: [],
  sid,
});

const aceBlock = (objectClass: string, aceName: string, params: [string, "string" | "number" | "boolean"][]): Json => ({
  eventType: "custom-ace-block",
  aceType: "action",
  aceName,
  objectClass,
  functionDescription: "",
  functionCategory: "",
  functionReturnType: "none",
  functionCopyPicked: false,
  functionIsAsync: false,
  functionParameters: params.map(([n, type], i) => ({ name: n, type, initialValue: "", sid: 800 + i })),
  conditions: [],
  actions: [],
  sid: 2,
});

const block = (actions: Json[], conditions: Json[] = [], sid = 10, extra: Json = {}): Json => ({
  eventType: "block",
  conditions,
  actions,
  sid,
  ...extra,
});

const sheetOf = (events: Json[], name = "S"): EventSheet => ({ name, events, sid: 5 }) as unknown as EventSheet;

const OBJECT_TYPES = [
  {
    name: "Hero",
    "plugin-id": "Sprite",
    behaviorTypes: [
      { name: "Shot", behaviorId: "Bullet" },
      { name: "Board", behaviorId: "Billboard" },
    ],
  },
  { name: "Label", "plugin-id": "Text" },
  { name: "Data", "plugin-id": "Json" },
];
const FAMILIES = [
  {
    name: "Movers",
    "plugin-id": "Sprite",
    behaviorTypes: [{ name: "FamilyFollow", behaviorId: "Follow" }],
    members: ["Hero"],
  },
];
const owners = buildOwnerResolver(OBJECT_TYPES, FAMILIES);

const slotOf = (node: Json, key: string | number, nodeKind: "action" | "condition" = "action"): WrittenSlot => ({
  node,
  nodeKind,
  key,
  value: (node.parameters as Json)[key as string],
  locator: "events[0].actions[0]",
  eventNumber: 1,
  sid: 77,
});

const callSlot = (callFunction: string, parameters: unknown[], position = 0): WrittenSlot =>
  slotOf({ callFunction, sid: 77, parameters }, position);

const builtinSlot = (
  node: { id: string; objectClass: string; behaviorType?: string },
  paramId: string,
  value: unknown,
  nodeKind: "action" | "condition" = "action",
): WrittenSlot => slotOf({ ...node, sid: 77, parameters: { [paramId]: value } }, paramId, nodeKind);

describe("boolean slot classification", () => {
  const sigs = buildSignatureIndex([
    sheetOf([
      fnBlock("Unlock", [
        ["name", "string"],
        ["isBulk", "boolean"],
        ["count", "number"],
      ]),
      aceBlock("Hero", "Boost", [["strong", "boolean"]]),
      aceBlock("Movers", "Dash", [["fast", "boolean"]]),
    ]),
  ]);
  const type = (slot: WrittenSlot): string | undefined => classifySlot(slot, sigs, owners)?.type;

  it("I371-U1: a callFunction argument takes the type of the callee's parameter at the same position", () => {
    const cls = classifySlot(callSlot("Unlock", ["x", "true", "3"], 1), sigs, owners);
    assert.equal(cls?.type, "boolean");
    assert.deepEqual(cls?.target, { kind: "function", name: "Unlock", position: 2, paramName: "isBulk" });
    assert.isUndefined(type(callSlot("Unlock", ["x"], 0)));
    assert.isUndefined(type(callSlot("Unlock", ["x", "y", "3"], 2)));
  });

  it("I371-U2: the function lookup ignores letter case", () => {
    assert.equal(type(callSlot("uNLOCK", ["x", "true"], 1)), "boolean");
  });

  it("I371-U3: a position on which two definitions disagree is skipped", () => {
    const dup = buildSignatureIndex([
      sheetOf([fnBlock("Dup", [["a", "boolean"]], 1)], "A"),
      sheetOf([fnBlock("dup", [["a", "number"]], 1)], "B"),
    ]);
    assert.isUndefined(classifySlot(callSlot("Dup", ["x"], 0), dup, owners));
    const agree = buildSignatureIndex([
      sheetOf([fnBlock("Dup", [["a", "boolean"]], 1)], "A"),
      sheetOf([fnBlock("dup", [["a", "boolean"]], 1)], "B"),
    ]);
    assert.equal(classifySlot(callSlot("Dup", ["x"], 0), agree, owners)?.type, "boolean");
  });

  it("I371-U4: an unknown callee or a position beyond the parameters is skipped", () => {
    assert.isUndefined(type(callSlot("NoSuchFunction", ["x"], 0)));
    assert.isUndefined(type(callSlot("Unlock", ["x", "y", "z", "w"], 3)));
  });

  it("I371-U5: a custom action resolves on its own object class", () => {
    const slot = slotOf({ customAction: "Boost", objectClass: "Hero", sid: 77, parameters: ["x"] }, 0);
    const cls = classifySlot(slot, sigs, owners);
    assert.equal(cls?.type, "boolean");
    assert.deepEqual(cls?.target, { kind: "custom-action", name: "Boost", position: 1, paramName: "strong" });
  });

  it("I371-U6: a custom action falls back to a family of its object class, or to customActionObjectClass", () => {
    const viaFamily = slotOf({ customAction: "Dash", objectClass: "Hero", sid: 77, parameters: ["x"] }, 0);
    assert.equal(type(viaFamily), "boolean");
    const explicit = slotOf(
      { customAction: "Dash", objectClass: "Hero", customActionObjectClass: "Movers", sid: 77, parameters: ["x"] },
      0,
    );
    assert.equal(type(explicit), "boolean");
    const wrongOverride = slotOf(
      { customAction: "Boost", objectClass: "Hero", customActionObjectClass: "Movers", sid: 77, parameters: ["x"] },
      0,
    );
    assert.isUndefined(type(wrongOverride));
  });

  it("I371-U7: a plugin action is keyed by the plugin id of the object type", () => {
    const slot = builtinSlot({ id: "spawn-another-object", objectClass: "Hero" }, "create-hierarchy", "x");
    assert.equal(type(slot), "boolean");
    assert.isUndefined(
      type(builtinSlot({ id: "spawn-another-object", objectClass: "Label" }, "create-hierarchy", "x")),
    );
  });

  it("I371-U8: a plugin condition on System is classified", () => {
    const slot = builtinSlot(
      { id: "pick-by-highest-lowest-value", objectClass: "System" },
      "pick-all-tied",
      "x",
      "condition",
    );
    assert.equal(type(slot), "boolean");
    assert.isUndefined(type({ ...slot, nodeKind: "action" }));
  });

  it("I371-U9: a behavior action resolves the behavior instance name to its behavior id", () => {
    // The instance name "Shot" differs from the behavior id "Bullet".
    const cls = classifySlot(
      builtinSlot({ id: "set-bounce-off-solids", objectClass: "Hero", behaviorType: "Shot" }, "state", "x"),
      sigs,
      owners,
    );
    assert.equal(cls?.type, "boolean");
    assert.isUndefined(
      type(builtinSlot({ id: "set-bounce-off-solids", objectClass: "Hero", behaviorType: "Bullet" }, "state", "x")),
    );
    assert.isUndefined(
      type(builtinSlot({ id: "set-bounce-off-solids", objectClass: "Hero", behaviorType: "Unknown" }, "state", "x")),
    );
  });

  it("I371-U10: a behavior instance on a family is found through the family of the object type", () => {
    const slot = builtinSlot({ id: "set-paused", objectClass: "Hero", behaviorType: "FamilyFollow" }, "is-paused", "x");
    assert.equal(type(slot), "boolean");
  });

  it("I371-U11: set-enabled is a boolean on Billboard and has no row on Bullet", () => {
    const board = builtinSlot({ id: "set-enabled", objectClass: "Hero", behaviorType: "Board" }, "state", "enabled");
    const shot = builtinSlot({ id: "set-enabled", objectClass: "Hero", behaviorType: "Shot" }, "state", "enabled");
    assert.equal(type(board), "boolean");
    assert.isUndefined(type(shot));
  });

  it("I371-U12: a common action applies to a known object type without a behavior", () => {
    const slot = builtinSlot({ id: "add-child", objectClass: "Hero" }, "transform-x", "x");
    assert.equal(type(slot), "boolean");
    const inst = builtinSlot({ id: "set-boolean-instvar", objectClass: "Hero" }, "value", true);
    assert.equal(type(inst), "combo-bool");
    assert.equal(classifySlot(inst, sigs, owners)?.initialValue, "true");
  });

  it("I371-U13: a common condition applies to a known object type", () => {
    const slot = builtinSlot({ id: "pick-highestlowest", objectClass: "Hero" }, "pick-all-tied", "x", "condition");
    assert.equal(type(slot), "boolean");
  });

  it("I371-U14: System takes only its own rows, and an unknown object class is skipped", () => {
    assert.equal(type(builtinSlot({ id: "create-object", objectClass: "System" }, "create-hierarchy", "x")), "boolean");
    assert.equal(type(builtinSlot({ id: "set-boolean-eventvar", objectClass: "System" }, "value", "x")), "combo-bool");
    assert.isUndefined(type(builtinSlot({ id: "add-child", objectClass: "System" }, "transform-x", "x")));
    assert.isUndefined(type(builtinSlot({ id: "add-child", objectClass: "Functions" }, "transform-x", "x")));
    assert.isUndefined(type(builtinSlot({ id: "add-child", objectClass: "Ghost" }, "transform-x", "x")));
  });

  it("I371-U15: a plugin combo-bool row wins over the common rows, keyed by plugin id", () => {
    const json = builtinSlot({ id: "set-boolean", objectClass: "Data" }, "value", true);
    assert.equal(type(json), "combo-bool");
  });
});

describe("written boolean slots", () => {
  const callAction = (sid: number, params: unknown[]): Json => ({ callFunction: "Unlock", sid, parameters: params });
  const setVar = (sid: number, value: unknown): Json => ({
    id: "set-boolean-eventvar",
    objectClass: "System",
    sid,
    parameters: { variable: "v", value },
  });

  it("I371-U16: every parameter of a node with a new SID is written, with its location and event number", () => {
    const original = sheetOf([block([], [], 10)]);
    const modified = sheetOf([
      { eventType: "comment", text: "c" },
      block([callAction(50, ["a", "b"])], [], 10),
      block([setVar(51, true)], [], 11, { children: [] }),
    ]);
    const slots = findWrittenSlots(original, modified);
    assert.deepEqual(
      slots.map((s) => [s.locator, s.key, s.value, s.eventNumber, s.sid]),
      [
        ["events[1].actions[0]", 0, "a", 1, 50],
        ["events[1].actions[0]", 1, "b", 1, 50],
        ["events[2].actions[0]", "variable", "v", 2, 51],
        ["events[2].actions[0]", "value", true, 2, 51],
      ],
    );
  });

  it("I371-U17: a node with an existing SID reports only the object keys that changed", () => {
    const original = sheetOf([block([setVar(51, "true")])]);
    const modified = sheetOf([block([setVar(51, "false")])]);
    const slots = findWrittenSlots(original, modified);
    assert.deepEqual(
      slots.map((s) => [s.key, s.value]),
      [["value", "false"]],
    );
  });

  it("I371-U18: a node with an existing SID reports only the positions that changed", () => {
    const original = sheetOf([block([callAction(50, ["a", "true"])])]);
    const modified = sheetOf([block([callAction(50, ["a", "isBulk", "extra"])])]);
    const slots = findWrittenSlots(original, modified);
    assert.deepEqual(
      slots.map((s) => [s.key, s.value]),
      [
        [1, "isBulk"],
        [2, "extra"],
      ],
    );
  });

  it("I371-U19: an unchanged node reports nothing, and a condition is walked like an action", () => {
    const sheet = sheetOf([block([setVar(51, "true")])]);
    assert.deepEqual(findWrittenSlots(sheet, structuredClone(sheet)), []);
    const cond: Json = {
      id: "pick-by-highest-lowest-value",
      objectClass: "System",
      sid: 60,
      parameters: { "pick-all-tied": "x" },
    };
    const withCond = sheetOf([block([], [cond])]);
    const slots = findWrittenSlots(sheetOf([block([])]), withCond);
    assert.deepEqual(
      slots.map((s) => [s.nodeKind, s.locator, s.key]),
      [["condition", "events[0].conditions[0]", "pick-all-tied"]],
    );
  });
});

describe("boolean slot rules and messages", () => {
  const sigs = buildSignatureIndex([sheetOf([fnBlock("Unlock", [["isBulk", "boolean"]])])]);
  const violations = (slot: WrittenSlot) => findBooleanSlotViolations("eventSheets/X.json", [slot], sigs, owners);
  const arg = (value: unknown): WrittenSlot => callSlot("Unlock", [value], 0);
  const combo = (value: unknown): WrittenSlot =>
    builtinSlot({ id: "set-boolean-eventvar", objectClass: "System" }, "value", value);

  it("I371-U20: a boolean slot accepts only a native boolean", () => {
    assert.lengthOf(violations(arg(true)), 0);
    assert.lengthOf(violations(arg(false)), 0);
    for (const bad of ["isBulk", "true", "false", 1, "1", null, "0"]) {
      assert.lengthOf(violations(arg(bad)), 1, JSON.stringify(bad));
    }
  });

  it("I371-U21: a combo-bool slot accepts only the strings true and false", () => {
    assert.lengthOf(violations(combo("true")), 0);
    assert.lengthOf(violations(combo("false")), 0);
    for (const bad of ["True", "1", "isOn", "", 1, null]) {
      assert.lengthOf(violations(combo(bad)), 1, JSON.stringify(bad));
    }
    // A native boolean left in a combo-bool slot is refused: normalization runs first.
    assert.lengthOf(violations(combo(true)), 1);
  });

  it("I371-U22: the expression message names the function parameter and the remedy", () => {
    const line = formatBooleanSlotFinding(violations(arg("isBulk"))[0]);
    assert.equal(
      line,
      'eventSheets/X.json events[0].actions[0] (event 1, sid 77): function "Unlock" parameter 1 "isBulk" is boolean, ' +
        'but the recipe writes "isBulk". C3 keeps only true or false here and loads any other value as true. ' +
        'Write a native true or false. For a computed value, branch with a condition and "else", pass a number ' +
        "and test it with != 0, or use a script block.",
    );
  });

  it("I371-U23: a string true or false in a boolean slot says to write the native boolean", () => {
    const f = formatBooleanSlotFinding(violations(arg("false"))[0]);
    assert.include(
      f,
      'the recipe writes the string "false", which C3 loads as true. Write the native boolean false (no quotes).',
    );
    assert.notInclude(f, "Write the native boolean true");
    const t = formatBooleanSlotFinding(violations(arg("true"))[0]);
    assert.include(
      t,
      'the recipe writes the string "true", which C3 loads as true. Write the native boolean true (no quotes).',
    );
    assert.notInclude(t, "Write the native boolean false");
  });

  it("I371-U24: a combo-bool message names the default, or says only its default when none is declared", () => {
    const withDefault = formatBooleanSlotFinding(violations(combo("isOn"))[0]);
    assert.include(
      withDefault,
      'action "set-boolean-eventvar" parameter "value" is a "true"/"false" choice, but the recipe writes "isOn".',
    );
    assert.include(
      withDefault,
      'accepts only the strings "true" or "false" here and replaces any other value with its default ("true") when the project loads.',
    );
    const noDefault = formatBooleanSlotFinding(
      violations(builtinSlot({ id: "set-boolean", objectClass: "Data" }, "value", "isOn"))[0],
    );
    assert.include(noDefault, "replaces any other value with its default when the project loads.");
    assert.notInclude(noDefault, "its default (");
  });

  it("I371-U25: built-in boolean, custom-action and condition slots render their own phrase", () => {
    const create = formatBooleanSlotFinding(
      violations(builtinSlot({ id: "create-object", objectClass: "System" }, "create-hierarchy", 1))[0],
    );
    assert.include(create, 'action "create-object" parameter "create-hierarchy" is boolean, but the recipe writes 1.');
    const cond = formatBooleanSlotFinding(
      violations(
        builtinSlot({ id: "pick-by-highest-lowest-value", objectClass: "System" }, "pick-all-tied", "x", "condition"),
      )[0],
    );
    assert.include(cond, 'condition "pick-by-highest-lowest-value" parameter "pick-all-tied"');
    const customSigs = buildSignatureIndex([sheetOf([aceBlock("Hero", "Boost", [["strong", "boolean"]])])]);
    const custom = findBooleanSlotViolations(
      "eventSheets/X.json",
      [slotOf({ customAction: "Boost", objectClass: "Hero", sid: 77, parameters: ["x"] }, 0)],
      customSigs,
      owners,
    );
    assert.include(formatBooleanSlotFinding(custom[0]), 'custom action "Boost" parameter 1 "strong"');
  });

  it("I371-U26: the failure is a header with one dash line per finding", () => {
    const findings = [...violations(arg("a")), ...violations(combo("b"))];
    const text = formatBooleanSlotFailure(findings);
    const lines = text.split("\n");
    assert.equal(lines[0], "Boolean-slot validation failed:");
    assert.lengthOf(lines, 3);
    assert.isTrue(lines.slice(1).every((l) => l.startsWith("  - eventSheets/X.json ")));
  });

  it("I371-U27: a skipped slot (unknown callee, no row) produces no finding", () => {
    assert.lengthOf(violations(callSlot("NoSuchFunction", ["x"], 0)), 0);
    assert.lengthOf(violations(builtinSlot({ id: "unknown-ace", objectClass: "System" }, "p", "x")), 0);
  });
});

describe("combo-bool normalization", () => {
  const setVar = (sid: number, value: unknown): Json => ({
    id: "set-boolean-eventvar",
    objectClass: "System",
    sid,
    parameters: { variable: "v", value },
  });
  const instVar = (sid: number, value: unknown): Json => ({
    id: "set-boolean-instvar",
    objectClass: "Hero",
    sid,
    parameters: { "instance-variable": "alive", value },
  });
  const flag = (sid: number, value: unknown): Json => ({
    id: "create-object",
    objectClass: "System",
    sid,
    parameters: { "create-hierarchy": value },
  });

  it("I371-U28: a written native boolean in a combo-bool slot becomes its item string, with one log line each", () => {
    const original = sheetOf([block([])]);
    const modified = sheetOf([block([setVar(51, true), instVar(52, false)])]);
    const log: string[] = [];
    const n = normalizeWrittenComboBools(original, modified, owners, (l) => log.push(l));
    assert.equal(n, 2);
    const actions = (modified.events[0] as unknown as { actions: Json[] }).actions;
    assert.equal((actions[0].parameters as Json).value, "true");
    assert.equal((actions[1].parameters as Json).value, "false");
    assert.deepEqual(log, [
      'normalized set-boolean-eventvar "value": true → "true" (C3 stores this choice as a string)',
      'normalized set-boolean-instvar "value": false → "false" (C3 stores this choice as a string)',
    ]);
  });

  it("I371-U29: native booleans in boolean slots and strings in combo-bool slots are left alone", () => {
    const original = sheetOf([block([])]);
    const modified = sheetOf([block([flag(53, true), setVar(51, "true"), setVar(54, "expr")])]);
    const before = structuredClone(modified);
    const log: string[] = [];
    assert.equal(
      normalizeWrittenComboBools(original, modified, owners, (l) => log.push(l)),
      0,
    );
    assert.deepEqual(modified, before);
    assert.deepEqual(log, []);
  });

  it("I371-U30: a native boolean already on disk in an unchanged slot is not normalized", () => {
    const original = sheetOf([block([setVar(51, true)])]);
    const modified = structuredClone(original);
    const log: string[] = [];
    assert.equal(
      normalizeWrittenComboBools(original, modified, owners, (l) => log.push(l)),
      0,
    );
    assert.deepEqual(modified, original);
    assert.deepEqual(log, []);
  });

  it("I371-U31: a normalized slot passes the combo-bool rule", () => {
    const original = sheetOf([block([])]);
    const modified = sheetOf([block([setVar(51, true)])]);
    normalizeWrittenComboBools(original, modified, owners, () => undefined);
    const sigs = buildSignatureIndex([modified]);
    assert.lengthOf(
      findBooleanSlotViolations("eventSheets/X.json", findWrittenSlots(original, modified), sigs, owners),
      0,
    );
  });
});
