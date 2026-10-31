import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed, findObjectTypeFile } from "../../src/c3/recipeApplier.js";
import { validateRecipe } from "../../src/c3/recipeInterpreter.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { objectTypeEntryIssue } from "../../src/c3/recipeKeys.js";
import { decideObjectTypeCreate } from "../../src/c3/objectTypeIdentity.js";
import { snapshotTree } from "../helpers/applyFixtures.js";
import { runCli } from "../helpers/runCli.js";

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

// #330 helpers: superscripts are built from char codes; L-key / L-name are the two reserved-name wordings.
const SUP1 = String.fromCharCode(0xb9);
const NEAR_MISSES = ["CONSOLE", "NULL", "Con1", "COM0", "LPT0", "NUL_x"];
type Pair = [string, string];
const lKey = (seg: string, dev: string): string =>
  `must not contain a segment that is a Windows reserved device name: '${seg}' (${dev})`;
const lName = (seg: string, dev: string): string => `must not be a Windows reserved device name: '${seg}' (${dev})`;

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
      // An interior ".." inside one name is a filename, not a path segment, so it cannot escape (#274 R1 amendment).
      assert.isUndefined(objectTypeEntryIssue("Foo..Bar", undefined));
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

    it("DN330-R4: an objectType name that is a reserved device name is refused with the name wording", () => {
      const cases: Record<string, Pair> = {
        nul: ["nul", "NUL"],
        "Con.txt": ["Con.txt", "CON"],
        "NUL.": ["NUL.", "NUL"],
        CONIN$: ["CONIN$", "CONIN$"],
        ["COM" + SUP1]: ["COM" + SUP1, "COM" + SUP1],
      };
      const got: Record<string, string | undefined> = {};
      const want: Record<string, string | undefined> = {};
      for (const [n, [seg, dev]] of Object.entries(cases)) {
        got[n] = objectTypeEntryIssue(n, undefined);
        want[n] = `"name" ${lName(seg, dev)}`;
      }
      assert.deepEqual(got, want);
    });

    it("DN330-R5: an objectType folder with a reserved device name segment is refused naming that segment", () => {
      const cases: Record<string, Pair> = {
        CON: ["CON", "CON"],
        "a/NUL": ["NUL", "NUL"],
        "sub/com1.json": ["com1.json", "COM1"],
        "a/CONOUT$": ["CONOUT$", "CONOUT$"],
      };
      const got: Record<string, string | undefined> = {};
      const want: Record<string, string | undefined> = {};
      for (const [f, [seg, dev]] of Object.entries(cases)) {
        got[f] = objectTypeEntryIssue("Widget", f);
        want[f] = `"folder" ${lKey(seg, dev)}`;
      }
      assert.deepEqual(got, want);
    });

    it("DN330-R6: near-miss names and folders are accepted", () => {
      const asName: Record<string, string | undefined> = {};
      const asFolder: Record<string, string | undefined> = {};
      const want: Record<string, undefined> = {};
      for (const n of NEAR_MISSES) {
        asName[n] = objectTypeEntryIssue(n, undefined);
        asFolder[n] = objectTypeEntryIssue("Widget", n);
        want[n] = undefined;
      }
      assert.deepEqual({ asName, asFolder }, { asName: want, asFolder: want });
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

    it("DN330-R7: a reserved-name objectType CREATE is refused before any write", () => {
      assertRefused({ objectTypes: [{ name: "NUL", plugin: "Json" }] }, [
        `objectTypes[0]: "name" must not be a Windows reserved device name: 'NUL' (NUL)`,
      ]);
      assertRefused({ objectTypes: [{ name: "Widget", plugin: "Json", folder: "CON" }] }, [
        `objectTypes[0]: "folder" must not contain a segment that is a Windows reserved device name: 'CON' (CON)`,
      ]);
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

  describe("identity against disk", () => {
    function logsOf(recipe: unknown, dryRun: boolean): string[] {
      const lines: string[] = [];
      applyParsed(tmp, recipe as Recipe, { dryRun, regenerate: false, log: (m: string) => lines.push(m) });
      return lines;
    }

    it("OT274-R3: navbutton is refused against objectTypes/NavButton.json, in dry-run and apply, writing nothing", () => {
      const recipe = { objectTypes: [{ name: "navbutton", plugin: "Json" }] };
      assertRefused(recipe, [
        "objectTypes/navbutton.json",
        "on disk: objectTypes/NavButton.json",
        "Nothing was written",
      ]);
    });

    it("OT274-R4: Sprite (no folder) is refused against objectTypes/images/Sprite.json, writing nothing", () => {
      const recipe = { objectTypes: [{ name: "Sprite", plugin: "Json" }] };
      assertRefused(recipe, ["objectTypes/Sprite.json", "on disk: objectTypes/images/Sprite.json"]);
    });

    it("OT274-R4: every refused entry is reported, not just the first", () => {
      assertRefused(
        {
          objectTypes: [
            { name: "navbutton", plugin: "Json" },
            { name: "Fresh", plugin: "Json" },
            { name: "Sprite", plugin: "Json" },
          ],
        },
        ["2 entries", "objectTypes/NavButton.json", "objectTypes/images/Sprite.json"],
      );
    });

    it("OT274-R4: a name with two matches on disk is refused and shows both", () => {
      mkdirSync(path.join(tmp, "objectTypes", "extra"));
      cpSync(
        path.join(tmp, "objectTypes", "images", "Sprite.json"),
        path.join(tmp, "objectTypes", "extra", "Sprite.json"),
      );
      assertRefused({ objectTypes: [{ name: "Sprite", plugin: "Json", folder: "images" }] }, [
        "objectTypes/images/Sprite.json",
        "objectTypes/extra/Sprite.json",
      ]);
    });

    for (const dryRun of [true, false]) {
      const mode = dryRun ? "dry-run" : "apply";
      it(`OT274-R5: exact re-declarations are a SKIP and write nothing (${mode})`, () => {
        for (const entry of [
          { name: "NavButton", plugin: "Json" },
          { name: "Sprite", plugin: "Json", folder: "images" },
          { name: "Sprite", plugin: "Json", folder: "images/" },
          { name: "Sprite", plugin: "Json", folder: "images/." },
          { name: "Sprite", plugin: "Json", folder: "./images" },
          { name: "NavButton", plugin: "Json", folder: "." },
        ]) {
          const before = snapshotTree(tmp);
          const lines = logsOf({ objectTypes: [entry] }, dryRun);
          assert.isTrue(
            lines.some((l) => l.includes("SKIP") && l.includes("(already exists)")),
            `${JSON.stringify(entry)}: ${lines.join(" / ")}`,
          );
          assert.deepEqual(changedFiles(before, snapshotTree(tmp)), []);
        }
      });
    }

    it("OT274-R5: a folder-case variant (Images) is refused against objectTypes/images/Sprite.json", () => {
      assertRefused({ objectTypes: [{ name: "Sprite", plugin: "Json", folder: "Images" }] }, [
        "objectTypes/Images/Sprite.json",
        "on disk: objectTypes/images/Sprite.json",
      ]);
    });

    it("OT274-R5: a project without an objectTypes/ directory creates normally", () => {
      rmSync(path.join(tmp, "objectTypes"), { recursive: true, force: true });
      assert.isUndefined(run(tmp, { objectTypes: [{ name: "Fresh", plugin: "Json" }] }, true));
    });
  });

  describe("addInstVars lookup", () => {
    const ivs = [{ name: "r7Var", type: "number" }];

    it("OT274-R7: type navbutton is refused naming objectTypes/NavButton.json, not 'not found'", () => {
      assertRefused({ addInstVars: [{ type: "navbutton", instanceVariables: ivs }] }, [
        "objectTypes/NavButton.json",
        "letter case is ignored",
      ]);
      assert.notInclude(run(tmp, { addInstVars: [{ type: "navbutton", instanceVariables: ivs }] }, true), "not found");
    });

    it("OT274-R7: a type in two subfolders is refused with every match listed", () => {
      mkdirSync(path.join(tmp, "objectTypes", "extra"));
      cpSync(
        path.join(tmp, "objectTypes", "images", "Sprite.json"),
        path.join(tmp, "objectTypes", "extra", "Sprite.json"),
      );
      assertRefused({ addInstVars: [{ type: "Sprite", instanceVariables: ivs }] }, [
        "objectTypes/images/Sprite.json",
        "objectTypes/extra/Sprite.json",
        "ambiguous",
      ]);
    });

    it("OT274-R7: an exact type still resolves, and a missing type still says not found", () => {
      assert.isUndefined(run(tmp, { addInstVars: [{ type: "NavButton", instanceVariables: ivs }] }, true));
      assert.isUndefined(run(tmp, { addInstVars: [{ type: "NavButton", instanceVariables: ivs }] }, false));
      assert.include(
        run(tmp, { addInstVars: [{ type: "NoSuchType", instanceVariables: ivs }] }, true),
        'objectType "NoSuchType" not found under objectTypes/',
      );
    });

    it("OT274-R7: a type created earlier in the same recipe resolves in dry-run and apply", () => {
      const ok = {
        objectTypes: [{ name: "PendingJ", plugin: "Json" }],
        addInstVars: [{ type: "PendingJ", instanceVariables: ivs }],
      };
      assert.isUndefined(run(tmp, ok, true));
      assert.isUndefined(run(tmp, ok, false));
    });

    it("OT274-R7: a case variant of a type created earlier in the recipe is refused in both modes", () => {
      assertRefused(
        {
          objectTypes: [{ name: "PendingJ", plugin: "Json" }],
          addInstVars: [{ type: "pendingj", instanceVariables: ivs }],
        },
        ["objectTypes/PendingJ.json", "letter case is ignored"],
      );
    });

    it("OT274-R7: the public findObjectTypeFile is unchanged (exact match, case variant null, first listed)", () => {
      assert.equal(findObjectTypeFile(tmp, "NavButton"), path.join(tmp, "objectTypes", "NavButton.json"));
      assert.isNull(findObjectTypeFile(tmp, "navbutton"));
      mkdirSync(path.join(tmp, "objectTypes", "extra"));
      cpSync(
        path.join(tmp, "objectTypes", "images", "Sprite.json"),
        path.join(tmp, "objectTypes", "extra", "Sprite.json"),
      );
      const first = findObjectTypeFile(tmp, "Sprite");
      assert.isString(first);
      assert.equal(path.basename(first!), "Sprite.json");
    });
  });

  describe("a project without objectTypes/ (#328)", function () {
    this.timeout(30_000);
    const recipe = { addInstVars: [{ type: "NavButton", instanceVariables: [{ name: "w3probe", type: "number" }] }] };
    const notFound = 'addInstVars: objectType "NavButton" not found under objectTypes/';

    it("I328-R1: dry-run (validate-recipe's path) refuses with apply's not-found message, not ENOENT", () => {
      rmSync(path.join(tmp, "objectTypes"), { recursive: true, force: true });
      assert.deepEqual(
        { dry: run(tmp, recipe, true), applied: run(tmp, recipe, false) },
        { dry: notFound, applied: notFound },
      );
    });

    it("I328-R1: CLI apply-recipe --dry-run prints the same not-found line", () => {
      rmSync(path.join(tmp, "objectTypes"), { recursive: true, force: true });
      const recipePath = path.join(parent, "recipe.json");
      writeFileSync(recipePath, JSON.stringify(recipe));
      const r = runCli(["apply-recipe", recipePath, "--project-dir", tmp, "--no-regenerate", "--dry-run"]);
      assert.deepEqual(
        { exitCode: r.exitCode, stderr: r.stderr.trim() },
        { exitCode: 1, stderr: `Error: ${notFound}` },
      );
    });

    it("I328-R2: accept control: with objectTypes/ present the same recipe dry-runs clean", () => {
      assert.isUndefined(run(tmp, recipe, true));
    });

    it("I328-R3: the public findObjectTypeFile returns null instead of throwing", () => {
      rmSync(path.join(tmp, "objectTypes"), { recursive: true, force: true });
      assert.isNull(findObjectTypeFile(tmp, "NavButton"));
    });
  });

  describe("decideObjectTypeCreate", () => {
    const listing = ["objectTypes/NavButton.json", "objectTypes/images/Sprite.json", "objectTypes/tiles/Sprite.json"];

    it("OT274-R5: create, skip and refuse", () => {
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes/Fresh.json", "Fresh"), { kind: "create" });
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes/NavButton.json", "NavButton"), {
        kind: "skip",
        path: "objectTypes/NavButton.json",
      });
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes//NavButton.json", "NavButton").kind, "skip");
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes/navbutton.json", "navbutton"), {
        kind: "refuse",
        onDisk: ["objectTypes/NavButton.json"],
      });
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes/NAVBUTTON.json", "NAVBUTTON").kind, "refuse");
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes/Images/Sprite.json", "Sprite").kind, "refuse");
      // two matches: refused even though one equals the target
      assert.deepEqual(decideObjectTypeCreate(listing, "objectTypes/images/Sprite.json", "Sprite"), {
        kind: "refuse",
        onDisk: ["objectTypes/images/Sprite.json", "objectTypes/tiles/Sprite.json"],
      });
    });
  });
});
