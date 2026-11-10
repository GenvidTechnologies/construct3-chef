import { describe, it, after, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyRecipeInner } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { OpDefinitionSchema, substituteOp } from "../../src/c3/opTemplate.js";
import {
  __getHandler,
  __setExtractedDirty,
  __setProjectRoot,
  __setTestWatcher,
  __resetTestState,
} from "../../src/mcp/server.js";
import type { SidGenerator } from "../../src/c3/sidUtils.js";

// Integration tests for the boolean-slot chokepoint in applyRecipeInner (#371): a value written into a
// boolean or "true"/"false" choice slot is refused, a native boolean in a choice slot is normalized, and
// every write path reaches the check. Throwaway temp projects only; nothing under test/fixtures/ is touched.

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const noop = () => {};
const HEADER = "Boolean-slot validation failed:";
const UNLOCK_PHRASE = 'function "Unlock" parameter 1 "isBulk"';

/** A deterministic SID generator, so two runs of one recipe render identical messages. */
function seqGen(): SidGenerator {
  let n = 700000000000000;
  return (() => ++n) as unknown as SidGenerator;
}

// ─── Project factory ───

let diskSid = 300000000000000;
const nextSid = (): number => ++diskSid;

interface ProjectOpts {
  sheets?: Record<string, unknown>;
  /** Extra objectTypes/<name>.json files, on top of the defaults. */
  objectTypes?: Record<string, unknown>;
}

const DEFAULT_OBJECT_TYPES: Record<string, unknown> = {
  Hero: { name: "Hero", "plugin-id": "Sprite", behaviorTypes: [], instanceVariables: [] },
  Cfg: { name: "Cfg", "plugin-id": "Json", behaviorTypes: [], instanceVariables: [] },
  // The behavior INSTANCE is named "Billboard" but its behaviorId is "Sin": a lookup keyed on the instance
  // name would find Billboard's `set-enabled` row.
  Wobbler: {
    name: "Wobbler",
    "plugin-id": "Sprite",
    behaviorTypes: [{ behaviorId: "Sin", name: "Billboard", sid: 111 }],
    instanceVariables: [],
  },
};

function makeProject(opts: ProjectOpts = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "c3-boolean-slot-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
  mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
  for (const [name, json] of Object.entries(opts.sheets ?? {})) {
    writeFileSync(path.join(dir, "eventSheets", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  for (const [name, json] of Object.entries({ ...DEFAULT_OBJECT_TYPES, ...(opts.objectTypes ?? {}) })) {
    writeFileSync(path.join(dir, "objectTypes", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  return dir;
}

// ─── On-disk sheet builders ───

const BLOCK = 200000000000001;

function sheet(name: string, events: unknown[]) {
  return { name, sid: nextSid(), events };
}

function block(actions: unknown[] = [], sid = BLOCK, children: unknown[] = []) {
  return { eventType: "block", sid, conditions: [], actions, children };
}

function fnBlock(name: string, params: { name: string; type: "string" | "number" | "boolean" }[]) {
  return {
    eventType: "function-block",
    functionName: name,
    functionDescription: "",
    functionCategory: "",
    functionReturnType: "none",
    functionCopyPicked: false,
    functionIsAsync: false,
    functionParameters: params.map((p) => ({
      name: p.name,
      type: p.type,
      initialValue: p.type === "boolean" ? "false" : p.type === "number" ? "0" : "",
      comment: "",
      sid: nextSid(),
    })),
    conditions: [],
    actions: [],
    sid: nextSid(),
  };
}

/** A sheet defining `Unlock(isBulk: boolean)`. */
function defsSheet(name = "Defs") {
  return sheet(name, [fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])]);
}

/** A sheet with one empty block, `BLOCK`, that recipe ops can target. */
function targetSheet(extraEvents: unknown[] = [], actions: unknown[] = []) {
  return sheet("Target", [block(actions), ...extraEvents]);
}

// ─── Recipe builders ───

const TARGET = "eventSheets/Target.json";

const callAction = (name: string, params: unknown[]) => ({ call: name, params });
const eventVarAction = (value: unknown) => ({
  id: "set-boolean-eventvar",
  object: "System",
  params: { variable: "isActive", value },
});
const instVarAction = (value: unknown) => ({
  id: "set-boolean-instvar",
  object: "Hero",
  params: { "instance-variable": "flag", value },
});

function insertInto(file: string, actions: unknown[]): Record<string, unknown> {
  return { files: { [file]: [{ op: "insert-actions", in: `sid:${BLOCK}`, after: -1, actions }] } };
}

// ─── Runners ───

function asRecipe(r: unknown): Recipe {
  return r as Recipe;
}

function dry(dir: string, recipe: unknown, log: (...a: unknown[]) => void = noop): void {
  applyRecipeInner(seqGen(), dir, asRecipe(recipe), { dryRun: true, regenerate: false, log });
}

function apply(dir: string, recipe: unknown, log: (...a: unknown[]) => void = noop): void {
  applyRecipeInner(seqGen(), dir, asRecipe(recipe), { dryRun: false, regenerate: false, log });
}

function refusalOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return assert.fail("expected the recipe to be refused, but it passed");
}

function readSheet(dir: string, name: string): { events: any[] } {
  return JSON.parse(readFileSync(path.join(dir, "eventSheets", `${name}.json`), "utf-8"));
}

/** Every action in an event tree, in document order. */
function allActions(events: any[]): any[] {
  const out: any[] = [];
  for (const e of events) {
    if (Array.isArray(e.actions)) out.push(...e.actions);
    if (Array.isArray(e.children)) out.push(...allActions(e.children));
  }
  return out;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = readFileSync(full).toString("hex");
    }
  };
  walk(dir);
  return out;
}

function findingLines(message: string): string[] {
  return message.split("\n").filter((l) => l.startsWith("  - "));
}

function assertRefusedBoolean(message: string, slotPhrase: string): void {
  assert.isTrue(message.startsWith(HEADER), `message starts with the header: ${message}`);
  assert.include(message, slotPhrase);
}

// ─── Tests ───

describe("boolean-slot validation in applyRecipeInner (#371)", () => {
  // ─── R1: the reproduced case ───

  describe("reproduced case", () => {
    const reproduced = {
      files: {
        "eventSheets/NewSheet.json": {
          create: true,
          events: [
            { "function-block": { name: "Unlock", params: [{ name: "isBulk", type: "boolean" }] } },
            {
              block: {
                conditions: [],
                actions: [callAction("Unlock", ["isBulk"]), eventVarAction("isBulk"), instVarAction("isBulk")],
              },
            },
          ],
        },
      },
    };

    it('I371-R1: dry-run refuses a call argument and both set-boolean-* values naming "isBulk"', () => {
      const dir = makeProject();
      const message = refusalOf(() => dry(dir, reproduced));
      assert.isTrue(message.startsWith(HEADER), message);
      const lines = findingLines(message);
      assert.lengthOf(lines, 3, message);
      for (const line of lines) assert.include(line, "eventSheets/NewSheet.json");
      assert.match(lines[0], /\.actions\[0\]/);
      assert.include(lines[0], 'function "Unlock" parameter 1 "isBulk"');
      assert.include(lines[1], '"set-boolean-eventvar" parameter "value"');
      assert.include(lines[2], '"set-boolean-instvar" parameter "value"');
      assert.isFalse(existsSync(path.join(dir, "eventSheets", "NewSheet.json")));
    });

    describe("MCP validate-recipe", () => {
      afterEach(() => {
        __resetTestState();
      });

      it("I371-R1: MCP validate-recipe returns an error carrying the same three lines", async () => {
        const dir = makeProject();
        // The MCP tool seeds its SID generator from the registry; an empty one is enough here.
        mkdirSync(path.join(dir, "extracted"), { recursive: true });
        writeFileSync(path.join(dir, "extracted", "sid-registry.txt"), "");
        const watcher = {
          txId: 5,
          bump() {},
          async suppress<T>(fn: () => Promise<T>): Promise<T> {
            return fn();
          },
          expect() {},
        };
        __setProjectRoot(dir);
        __setTestWatcher(watcher as any);
        __setExtractedDirty(true); // skip the registry freshness scan

        // The two runs mint different SIDs for the recipe's new actions; the mask is the only difference allowed.
        const maskSids = (line: string): string => line.replace(/sid \d+/g, "sid <SID>");
        const expected = findingLines(refusalOf(() => dry(dir, reproduced))).map(maskSids);
        const result = (await __getHandler("validate-recipe")!({ recipe: JSON.stringify(reproduced) }, {
          signal: new AbortController().signal,
        } as any)) as any;

        assert.isTrue(result.isError, JSON.stringify(result));
        const text = result.content.map((b: any) => b.text).join("\n");
        assert.include(text, HEADER);
        assert.lengthOf(expected, 3);
        assert.deepEqual(findingLines(text).map(maskSids), expected);
      });
    });
  });

  // ─── R2: every write path ───

  describe("every write path is refused", () => {
    const UNLOCK = 'function "Unlock" parameter 1 "isBulk"';

    it("I371-R2: insert-actions with `in` is refused", () => {
      const dir = makeProject({
        sheets: { Target: targetSheet([fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])]) },
      });
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [callAction("Unlock", ["isBulk"])])));
      assertRefusedBoolean(message, UNLOCK);
    });

    it("I371-R2: insert-actions with `path` is refused", () => {
      const dir = makeProject({
        sheets: { Target: targetSheet([fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])]) },
      });
      const recipe = {
        files: {
          [TARGET]: [
            { op: "insert-actions", path: "events[0]", after: -1, actions: [callAction("Unlock", ["isBulk"])] },
          ],
        },
      };
      assertRefusedBoolean(
        refusalOf(() => dry(dir, recipe)),
        UNLOCK,
      );
    });

    it("I371-R2: replace-action is refused", () => {
      const existing = { callFunction: "Unlock", sid: nextSid(), parameters: [true] };
      const dir = makeProject({
        sheets: { Target: targetSheet([fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])], [existing]) },
      });
      const recipe = {
        files: {
          [TARGET]: [{ op: "replace-action", in: `sid:${BLOCK}`, index: 0, action: callAction("Unlock", ["isBulk"]) }],
        },
      };
      assertRefusedBoolean(
        refusalOf(() => dry(dir, recipe)),
        UNLOCK,
      );
    });

    it("I371-R2: an inline event with nested children is refused", () => {
      const dir = makeProject({
        sheets: { Target: targetSheet([fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])]) },
      });
      const recipe = {
        files: {
          [TARGET]: [
            {
              op: "insert-event",
              after: `sid:${BLOCK}`,
              block: {
                conditions: [],
                actions: [],
                children: [{ block: { conditions: [], actions: [callAction("Unlock", ["isBulk"])] } }],
              },
            },
          ],
        },
      };
      const message = refusalOf(() => dry(dir, recipe));
      assertRefusedBoolean(message, UNLOCK);
      assert.match(message, /children\[0\]/);
    });

    it("I371-R2: a files CREATE calling a function defined on disk is refused", () => {
      const dir = makeProject({ sheets: { Defs: defsSheet() } });
      const recipe = {
        files: {
          "eventSheets/Created.json": {
            create: true,
            events: [{ block: { conditions: [], actions: [callAction("Unlock", ["isBulk"])] } }],
          },
        },
      };
      assertRefusedBoolean(
        refusalOf(() => dry(dir, recipe)),
        UNLOCK,
      );
    });

    it("I371-R2: patch-action-param changing an on-disk call's boolean argument to an expression is refused", () => {
      const existing = { callFunction: "Unlock", sid: nextSid(), parameters: [true] };
      const dir = makeProject({
        sheets: { Target: targetSheet([fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])], [existing]) },
      });
      const recipe = {
        files: {
          [TARGET]: [{ op: "patch-action-param", in: `sid:${BLOCK}`, actionIndex: 0, param: "0", value: "isBulk" }],
        },
      };
      const message = refusalOf(() => dry(dir, recipe));
      assertRefusedBoolean(message, UNLOCK);
      assert.include(message, `sid ${existing.sid}`);
    });

    it("I371-R2: a user-defined op interpolating {{X}} into a boolean argument is refused", () => {
      const dir = makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });
      const def = OpDefinitionSchema.parse({
        description: "unlock",
        params: [{ name: "X", type: "string" }],
        recipe: insertInto(TARGET, [callAction("Unlock", ["is{{X}}"])]),
      });
      const recipe = substituteOp(def, { X: "Bulk" });
      assert.deepEqual((recipe as any).files[TARGET][0].actions[0].params, ["isBulk"]);
      assertRefusedBoolean(
        refusalOf(() => dry(dir, recipe)),
        UNLOCK,
      );
    });

    it("I371-R2: a callee defined on disk in another sheet is found and the call is refused", () => {
      const dir = makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });
      assertRefusedBoolean(
        refusalOf(() => dry(dir, insertInto(TARGET, [callAction("Unlock", ["isBulk"])]))),
        UNLOCK,
      );
    });

    it("I371-R2: a callee defined in a later recipe key than the call is found and the call is refused", () => {
      const dir = makeProject({
        sheets: { A: sheet("A", [block()]), B: sheet("B", [block()]) },
      });
      const recipe = {
        files: {
          "eventSheets/A.json": [
            { op: "insert-actions", in: `sid:${BLOCK}`, after: -1, actions: [callAction("Later", ["flag"])] },
          ],
          "eventSheets/B.json": [
            {
              op: "insert-event",
              after: `sid:${BLOCK}`,
              "function-block": { name: "Later", params: [{ name: "flag", type: "boolean" }] },
            },
          ],
        },
      };
      assertRefusedBoolean(
        refusalOf(() => dry(dir, recipe)),
        'function "Later" parameter 1 "flag"',
      );
    });

    it("I371-R2: a call whose name differs from the definition only in letter case is refused", () => {
      const dir = makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [callAction("unlock", ["isBulk"])])));
      assertRefusedBoolean(message, 'function "unlock" parameter 1 "isBulk"');
    });
  });

  // ─── R3: combo-bool non-item ───

  describe("a non-item in a true/false choice is refused", () => {
    const ITEMS = 'accepts only the strings "true" or "false"';

    it("I371-R3: an expression in set-boolean-eventvar (System) is refused", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [eventVarAction("isBulk")])));
      assertRefusedBoolean(message, '"set-boolean-eventvar" parameter "value"');
      assert.include(message, ITEMS);
    });

    it("I371-R3: an expression in set-boolean-instvar on a Sprite object type is refused", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [instVarAction("isBulk")])));
      assertRefusedBoolean(message, '"set-boolean-instvar" parameter "value"');
      assert.include(message, ITEMS);
    });

    it("I371-R3: an expression in Json set-boolean on a Json object type is refused", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const action = { id: "set-boolean", object: "Cfg", params: { path: '"a"', value: "isBulk" } };
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [action])));
      assertRefusedBoolean(message, '"set-boolean" parameter "value"');
      assert.include(message, ITEMS);
    });
  });

  // ─── R4: "true"/"false" strings in a boolean slot ───

  describe('a "true"/"false" string in a boolean slot is refused', () => {
    it('I371-R4: the call argument "false" is refused with the native-false remedy', () => {
      const dir = makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [callAction("Unlock", ["false"])])));
      assertRefusedBoolean(message, UNLOCK_PHRASE);
      assert.include(message, "Write the native boolean false");
      assert.notInclude(message, "Write the native boolean true");
    });

    it('I371-R4: System create-object create-hierarchy "true" is refused with the native-true remedy', () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const action = {
        id: "create-object",
        object: "System",
        params: { "object-to-create": "Hero", layer: "0", x: "0", y: "0", "create-hierarchy": "true" },
      };
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [action])));
      assertRefusedBoolean(message, '"create-object" parameter "create-hierarchy"');
      assert.include(message, "Write the native boolean true");
      assert.notInclude(message, "Write the native boolean false");
    });
  });

  // ─── R5: accept controls ───

  describe("accept controls", () => {
    const withDefs = () => makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });

    it("I371-R5: a native true in a boolean function argument passes", () => {
      assert.doesNotThrow(() => dry(withDefs(), insertInto(TARGET, [callAction("Unlock", [true])])));
    });

    it("I371-R5: a native false in a boolean function argument passes", () => {
      assert.doesNotThrow(() => dry(withDefs(), insertInto(TARGET, [callAction("Unlock", [false])])));
    });

    it('I371-R5: "true" and "false" in set-boolean-eventvar pass', () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [eventVarAction("true"), eventVarAction("false")])));
    });

    it('I371-R5: "true" and "false" in set-boolean-instvar pass', () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [instVarAction("true"), instVarAction("false")])));
    });

    it("I371-R5: expressions in number and string function arguments pass", () => {
      const dir = makeProject({
        sheets: {
          Target: targetSheet(),
          Defs: sheet("Defs", [
            fnBlock("Move", [
              { name: "speed", type: "number" },
              { name: "label", type: "string" },
            ]),
          ]),
        },
      });
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [callAction("Move", ["Hero.X + 1", '"fast" & 1'])])));
    });

    it("I371-R5: expressions in create-object's other parameters pass", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const action = {
        id: "create-object",
        object: "System",
        params: { "object-to-create": "Hero", layer: '"Main"', x: "Hero.X + 1", y: "Hero.Y * 2" },
      };
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [action])));
    });

    it('I371-R5: set-enabled with state "enabled" on a behavior instance whose behaviorId has no such row passes', () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const action = {
        id: "set-enabled",
        object: "Wobbler",
        behavior: "Billboard",
        params: { state: "enabled" },
      };
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [action])));
    });

    it("I371-R5: an untouched on-disk call with an expression in a boolean argument is not refused", () => {
      const defective = { callFunction: "Unlock", sid: nextSid(), parameters: ["isBulk"] };
      const other = {
        id: "set-boolean-eventvar",
        objectClass: "System",
        sid: nextSid(),
        parameters: { variable: "isActive", value: "true" },
      };
      const dir = makeProject({
        sheets: {
          Target: sheet("Target", [
            block([defective, other]),
            fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }]),
          ]),
        },
      });
      const recipe = {
        files: {
          [TARGET]: [
            { op: "patch-action-param", in: `sid:${BLOCK}`, actionIndex: 1, param: "variable", value: "otherVar" },
          ],
        },
      };
      assert.doesNotThrow(() => dry(dir, recipe));
    });

    it("I371-R5: a call to a function defined nowhere is skipped", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [callAction("Nowhere", ["isBulk"])])));
    });

    it("I371-R5: two same-named definitions that disagree on the argument's type are skipped", () => {
      const dir = makeProject({
        sheets: {
          Target: targetSheet(),
          DefsA: sheet("DefsA", [fnBlock("Dual", [{ name: "v", type: "boolean" }])]),
          DefsB: sheet("DefsB", [fnBlock("Dual", [{ name: "v", type: "number" }])]),
        },
      });
      assert.doesNotThrow(() => dry(dir, insertInto(TARGET, [callAction("Dual", ["isBulk"])])));
    });
  });

  // ─── R6: native boolean in a true/false choice is normalized ───

  describe("a native boolean in a true/false choice is normalized", () => {
    it('I371-R6: set-boolean-eventvar value true is stored as "true"', () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      apply(dir, insertInto(TARGET, [eventVarAction(true)]));
      const [action] = allActions(readSheet(dir, "Target").events);
      assert.strictEqual(action.parameters.value, "true");
    });

    it('I371-R6: set-boolean-instvar value false is stored as "false"', () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      apply(dir, insertInto(TARGET, [instVarAction(false)]));
      const [action] = allActions(readSheet(dir, "Target").events);
      assert.strictEqual(action.parameters.value, "false");
    });

    it('I371-R6: patch-action-param of a native true onto an on-disk set-boolean-eventvar is stored as "true"', () => {
      const existing = {
        id: "set-boolean-eventvar",
        objectClass: "System",
        sid: nextSid(),
        parameters: { variable: "isActive", value: "false" },
      };
      const dir = makeProject({ sheets: { Target: targetSheet([], [existing]) } });
      const recipe = {
        files: {
          [TARGET]: [{ op: "patch-action-param", in: `sid:${BLOCK}`, actionIndex: 0, param: "value", value: true }],
        },
      };
      apply(dir, recipe);
      const [action] = allActions(readSheet(dir, "Target").events);
      assert.strictEqual(action.parameters.value, "true");
    });

    it("I371-R6: a typed boolean {{FLAG}} substituted as the whole value lands as a string", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const def = OpDefinitionSchema.parse({
        description: "set the flag",
        params: [{ name: "FLAG", type: "boolean" }],
        recipe: insertInto(TARGET, [eventVarAction("{{FLAG}}")]),
      });
      const recipe = substituteOp(def, { FLAG: true });
      assert.strictEqual((recipe as any).files[TARGET][0].actions[0].params.value, true);
      apply(dir, recipe);
      const [action] = allActions(readSheet(dir, "Target").events);
      assert.strictEqual(action.parameters.value, "true");
    });

    it("I371-R6: the dry-run narration names the normalization", () => {
      const dir = makeProject({ sheets: { Target: targetSheet() } });
      const lines: string[] = [];
      dry(dir, insertInto(TARGET, [eventVarAction(true)]), (...a) => lines.push(a.join(" ")));
      assert.isTrue(
        lines.some((l) => l.includes('normalized set-boolean-eventvar "value": true → "true"')),
        lines.join("\n"),
      );
    });

    it("I371-R6: a pre-existing native boolean in an untouched choice slot is left as it was", () => {
      const seed = {
        id: "set-boolean-eventvar",
        objectClass: "System",
        sid: nextSid(),
        parameters: { variable: "isActive", value: true },
      };
      const other = block([], 200000000000002);
      const dir = makeProject({ sheets: { Target: sheet("Target", [block(), { ...other, actions: [seed] }]) } });
      const recipe = insertInto(TARGET, [{ script: ["// touch"] }]);
      apply(dir, recipe);
      const actions = allActions(readSheet(dir, "Target").events);
      assert.deepEqual(
        actions.find((a) => a.sid === seed.sid),
        seed,
      );
    });
  });

  // ─── R9: dry-run = apply, nothing written, order ───

  describe("dry-run and apply agree, and a refusal writes nothing", () => {
    const refusedRecipe = () => ({
      files: {
        "eventSheets/Created.json": { create: true, events: [{ block: { conditions: [], actions: [] } }] },
        [TARGET]: [
          { op: "insert-actions", in: `sid:${BLOCK}`, after: -1, actions: [callAction("Unlock", ["isBulk"])] },
        ],
      },
    });

    it("I371-R9: dry-run and apply give the same error message", () => {
      const dir = makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });
      const dryMessage = refusalOf(() => dry(dir, refusedRecipe()));
      const applyMessage = refusalOf(() => apply(dir, refusedRecipe()));
      assert.isTrue(dryMessage.startsWith(HEADER), dryMessage);
      assert.strictEqual(applyMessage, dryMessage);
    });

    it("I371-R9: after an apply refusal every source file is byte-identical and no CREATE target exists", () => {
      const dir = makeProject({ sheets: { Target: targetSheet(), Defs: defsSheet() } });
      const before = snapshot(dir);
      const message = refusalOf(() => apply(dir, refusedRecipe()));
      assert.isTrue(message.startsWith(HEADER), message);
      assert.deepEqual(snapshot(dir), before);
      assert.isFalse(existsSync(path.join(dir, "eventSheets", "Created.json")));
    });

    it("I371-R9: a sheet failing both editor-load and boolean-slot validation reports the editor-load failure", () => {
      // The group omits `description`, which validateForEditor rejects.
      const badGroup = {
        eventType: "group",
        sid: nextSid(),
        title: "G",
        disabled: false,
        isActiveOnStart: true,
        children: [],
      };
      const dir = makeProject({
        sheets: {
          Target: sheet("Target", [block(), badGroup, fnBlock("Unlock", [{ name: "isBulk", type: "boolean" }])]),
        },
      });
      const message = refusalOf(() => dry(dir, insertInto(TARGET, [callAction("Unlock", ["isBulk"])])));
      assert.include(message, "Editor-validation failed");
      assert.notInclude(message, HEADER);
    });
  });
});
