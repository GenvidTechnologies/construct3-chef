import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import { validateRecipe } from "../../src/c3/recipeInterpreter.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { objectTypeEntryIssue } from "../../src/c3/recipeKeys.js";
import { snapshotTree } from "../helpers/applyFixtures.js";

// A throwaway copy of the canonical fixture, one dedicated parent dir per test so "outside the copy" is listable.
const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

function run(root: string, recipe: unknown, dryRun: boolean): string | undefined {
  try {
    applyParsed(root, recipe as Recipe, { dryRun, regenerate: false, log: () => undefined });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(k);
  for (const k of before.keys()) if (!after.has(k)) out.push(k);
  return out;
}

describe("objectType create identity (#274)", () => {
  let parent: string;
  let tmp: string;
  beforeEach(() => {
    parent = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-ot274-"));
    tmp = path.join(parent, "proj");
    mkdirSync(tmp);
    cpSync(FIXTURE_ROOT, tmp, { recursive: true });
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  /** Dry-run and apply must refuse with the same message naming `expected`, writing nothing in or outside the copy. */
  function assertRefused(recipe: unknown, expected: string[]): void {
    const before = snapshotTree(tmp);
    const parentBefore = readdirSync(parent).sort();
    const dry = run(tmp, recipe, true);
    const applied = run(tmp, recipe, false);
    assert.isDefined(dry, "dry-run did not refuse");
    assert.isDefined(applied, "apply did not refuse");
    assert.equal(dry, applied, "dry-run and apply disagree");
    for (const e of expected) assert.include(applied, e);
    assert.deepEqual(changedFiles(before, snapshotTree(tmp)), []);
    assert.deepEqual(readdirSync(parent).sort(), parentBefore, "something was created outside the project copy");
  }

  describe("objectTypeEntryIssue", () => {
    it("OT274-R1: accepts ordinary names and folders", () => {
      assert.isUndefined(objectTypeEntryIssue("Widget", undefined));
      assert.isUndefined(objectTypeEntryIssue("Widget", "sub"));
      assert.isUndefined(objectTypeEntryIssue("Widget", "a/b c/d"));
      assert.isUndefined(objectTypeEntryIssue("Widget", "sub/"), "a trailing slash is tolerated");
      assert.isUndefined(objectTypeEntryIssue("Widget", "a//b"), "an interior // is tolerated");
      assert.isUndefined(objectTypeEntryIssue("My.Widget v2", "a.b"));
    });

    it("OT274-R1: refuses bad names", () => {
      for (const name of ["", "a/b", "a\\b", ".", "..", "a:b", "...", " . ", "../EscapedN"]) {
        assert.isString(objectTypeEntryIssue(name, undefined), `name ${JSON.stringify(name)}`);
      }
    });

    it("OT274-R1: refuses bad folders", () => {
      for (const folder of [
        "../..",
        "..",
        "a/../b",
        "a\\..\\b",
        "/abs",
        "\\abs",
        "C:\\x",
        "C:/x",
        "C:x",
        "a:b",
        "a/b:c",
        "a/.../b",
        "a/ /b",
        "",
      ]) {
        assert.isString(objectTypeEntryIssue("Widget", folder), `folder ${JSON.stringify(folder)}`);
      }
    });
  });

  describe("validateRecipe / apply containment", () => {
    it("OT274-R1: refuses folder ../.. (the literal probe input) at objectTypes[0], dry-run and apply alike", () => {
      const recipe = { objectTypes: [{ name: "EscapedF", plugin: "Json", folder: "../.." }] };
      const errors = validateRecipe(recipe as Recipe);
      assert.lengthOf(errors, 1);
      assert.match(errors[0]!, /^objectTypes\[0\]: /);
      assertRefused(recipe, ["objectTypes[0]:", "'..'"]);
    });

    it("OT274-R1: refuses name ../EscapedN at objectTypes[0], dry-run and apply alike", () => {
      assertRefused({ objectTypes: [{ name: "../EscapedN", plugin: "Json" }] }, ["objectTypes[0]:", '"name"']);
    });

    it("OT274-R1: refuses each escaping folder and each bad name, reported at its own index", () => {
      const bad: Array<Record<string, unknown>> = [
        { name: "A1", plugin: "Json", folder: "/abs" },
        { name: "A2", plugin: "Json", folder: "C:\\evil" },
        { name: "A3", plugin: "Json", folder: "a:b" },
        { name: "A4", plugin: "Json", folder: "..." },
        { name: "A5", plugin: "Json", folder: "" },
        { name: "a\\b", plugin: "Json" },
        { name: "a/b", plugin: "Json" },
        { name: "..", plugin: "Json" },
        { name: "a:b", plugin: "Json" },
        { name: " . ", plugin: "Json" },
      ];
      const errors = validateRecipe({ objectTypes: bad } as unknown as Recipe);
      for (let i = 0; i < bad.length; i++) {
        assert.isTrue(
          errors.some((e) => e.startsWith(`objectTypes[${i}]: `)),
          `entry ${i} not refused`,
        );
      }
      assertRefused(
        { objectTypes: bad },
        bad.map((_, i) => `objectTypes[${i}]:`),
      );
    });

    it("OT274-R1: an empty name is refused at its index", () => {
      const errors = validateRecipe({ objectTypes: [{ name: "", plugin: "Json" }] } as unknown as Recipe);
      assert.lengthOf(errors, 1);
      assert.match(errors[0]!, /^objectTypes\[0\]: /);
    });
  });

  describe("in-recipe identity", () => {
    it("OT274-R2: Widget + widget yield ONE error naming both spellings, identical in dry-run and apply", () => {
      const recipe = {
        objectTypes: [
          { name: "Widget", plugin: "Json" },
          { name: "widget", plugin: "Json" },
        ],
      };
      const errors = validateRecipe(recipe as Recipe);
      assert.lengthOf(errors, 1);
      assert.include(errors[0]!, "2 entries name the same objectType");
      assert.include(errors[0]!, "(letter case is ignored)");
      assert.include(errors[0]!, '"Widget", "widget"');
      assertRefused(recipe, ['"Widget", "widget"']);
    });

    it("OT274-R2: Widget + {Widget, folder: sub} collide across folders and show each folder", () => {
      const recipe = {
        objectTypes: [
          { name: "Widget", plugin: "Json" },
          { name: "Widget", plugin: "Json", folder: "sub" },
        ],
      };
      const errors = validateRecipe(recipe as Recipe);
      assert.lengthOf(errors, 1);
      assert.include(errors[0]!, '"Widget", "sub/Widget"');
      assert.notInclude(errors[0]!, "letter case is ignored");
      assertRefused(recipe, ['"Widget", "sub/Widget"']);
    });

    it("OT274-R2: three spellings across folders are one group, in recipe order", () => {
      const errors = validateRecipe({
        objectTypes: [
          { name: "Widget", plugin: "Json", folder: "a" },
          { name: "other", plugin: "Json" },
          { name: "WIDGET", plugin: "Json" },
          { name: "widget", plugin: "Dictionary", folder: "b" },
        ],
      } as Recipe);
      assert.lengthOf(errors, 1);
      assert.include(errors[0]!, "3 entries");
      assert.include(errors[0]!, '"a/Widget", "WIDGET", "b/widget"');
    });

    it("OT274-R2: distinct names do not collide, and an invalid entry is not also reported as a collision", () => {
      assert.deepEqual(
        validateRecipe({
          objectTypes: [
            { name: "A", plugin: "Json" },
            { name: "B", plugin: "Json", folder: "sub" },
          ],
        } as Recipe),
        [],
      );
      const errors = validateRecipe({
        objectTypes: [
          { name: "Widget", plugin: "Json" },
          { name: "Widget", plugin: "Json", folder: "../x" },
        ],
      } as Recipe);
      assert.lengthOf(errors, 1);
      assert.match(errors[0]!, /^objectTypes\[1\]: /);
    });
  });
});
