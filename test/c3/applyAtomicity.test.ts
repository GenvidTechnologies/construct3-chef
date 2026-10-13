import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { copyFixture, snapshotTree } from "../helpers/applyFixtures.js";
import { runCli } from "../helpers/runCli.js";

// Pins current recipe-apply behaviour (green at 703c1bf) so the later apply refactor cannot drift it silently.
// Expected log arrays were derived by running the designer's probes against the current tree.

const REMINDER =
  "\nReminder: run sync-project (CLI: `construct3-chef sync-project`, or the `sync-project` MCP tool) to register new files with Construct 3.";

function run(root: string, recipe: unknown, dryRun = false): { lines: string[]; err?: Error } {
  const lines: string[] = [];
  try {
    applyParsed(root, recipe as Recipe, {
      dryRun,
      regenerate: false,
      log: (...a: unknown[]) => lines.push(a.join(" ")),
    });
    return { lines };
  } catch (e) {
    return { lines, err: e as Error };
  }
}

describe("recipe apply behaviour pins (#255)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = copyFixture("c3chef-apply-atomicity-");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("B3: a mixed recipe logs its steps in order", () => {
    const { lines, err } = run(tmp, {
      objectTypes: [{ name: "ProbeJson", plugin: "Json" }],
      layouts: { "layouts/Templates Layout.json": [{ op: "add-layer", name: "P" }] },
      files: {
        "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", comment: "MIXED" }],
        "eventSheets/NewFolderOK/Fresh.json": { create: true, events: [] },
      },
    });
    assert.isUndefined(err);
    assert.deepEqual(lines, [
      "Recipe: 1 objectType(s), 2 eventSheet file(s), 1 layout file(s), 3 operation(s)",
      "\nobjectTypes:",
      "  CREATED objectTypes/ProbeJson.json",
      "  UPDATED scripts/ts-defs/instanceTypes.d.ts",
      "  UPDATED scripts/ts-defs/objects.d.ts",
      "\nlayouts:",
      '  MODIFIED layouts/Templates Layout.json (+layer "P")',
      "\nfiles:",
      "  MODIFIED eventSheets/Gameplay/Event sheet 1.json",
      "  CREATED eventSheets/NewFolderOK/Fresh.json",
      "\nDone.",
      REMINDER,
    ]);
  });

  it("C1: a cross-layout copy-instance chain reads the earlier op's result", () => {
    const { lines, err } = run(tmp, {
      layouts: {
        "layouts/Templates Layout.json": [
          { op: "copy-instance", type: "Text", from: "layouts/UI/Second Layout.json", targetLayer: "Layer 0" },
        ],
        "layouts/Gameplay/Main Layout.json": [
          { op: "copy-instance", type: "Text", from: "layouts/Templates Layout.json", targetLayer: "layer 0" },
        ],
      },
    });
    assert.isUndefined(err);
    assert.include(readFileSync(path.join(tmp, "layouts/Gameplay/Main Layout.json"), "utf8"), '"type": "Text"');
    assert.deepEqual(lines, [
      "Recipe: 2 layout file(s), 2 operation(s)",
      "\nlayouts:",
      "  MODIFIED layouts/Templates Layout.json (+copy Text from layouts/UI/Second Layout.json)",
      "  MODIFIED layouts/Gameplay/Main Layout.json (+copy Text from layouts/Templates Layout.json)",
      "\nDone.",
    ]);
  });

  it("C2: addInstVars then a layout op on the same layout both land", () => {
    const { lines, err } = run(tmp, {
      addInstVars: [{ type: "Text", instanceVariables: [{ name: "probeIv", type: "number" }] }],
      layouts: { "layouts/UI/Second Layout.json": [{ op: "add-layer", name: "PIV" }] },
    });
    assert.isUndefined(err);
    const s = readFileSync(path.join(tmp, "layouts/UI/Second Layout.json"), "utf8");
    assert.include(s, '"name": "PIV"');
    assert.include(s, '"probeIv"');
    assert.deepEqual(lines, [
      "Recipe: 1 addInstVars type(s), 1 layout file(s), 1 operation(s)",
      "\naddInstVars:",
      "  UPDATED objectTypes/Text.json (+probeIv)",
      "  UPDATED layouts/UI/Second Layout.json (1 instance(s))",
      "  UPDATED scripts/ts-defs/instanceTypes.d.ts (+probeIv)",
      "\nlayouts:",
      '  MODIFIED layouts/UI/Second Layout.json (+layer "PIV")',
      "\nDone.",
    ]);
  });

  const E5 = {
    objectTypes: [{ name: "NewJ", plugin: "Json" }],
    addInstVars: [{ type: "NewJ", instanceVariables: [{ name: "v", type: "number" }] }],
  };

  it("C3: create objectType then addInstVars on it in one recipe (apply)", () => {
    const { lines, err } = run(tmp, E5);
    assert.isUndefined(err);
    assert.include(readFileSync(path.join(tmp, "objectTypes/NewJ.json"), "utf8"), '"name": "v"');
    const dts = readFileSync(path.join(tmp, "scripts/ts-defs/instanceTypes.d.ts"), "utf8");
    const at = dts.indexOf("class NewJ");
    assert.isAbove(at, -1);
    const body = dts.slice(at);
    assert.match(body.slice(0, body.indexOf("}")), /\bv\b/);
    assert.deepEqual(lines, [
      "Recipe: 1 objectType(s), 1 addInstVars type(s), 0 operation(s)",
      "\nobjectTypes:",
      "  CREATED objectTypes/NewJ.json",
      "  UPDATED scripts/ts-defs/instanceTypes.d.ts",
      "  UPDATED scripts/ts-defs/objects.d.ts",
      "\naddInstVars:",
      "  UPDATED objectTypes/NewJ.json (+v)",
      "  No layout instances found for NewJ",
      "  UPDATED scripts/ts-defs/instanceTypes.d.ts (+v)",
      "\nDone.",
      REMINDER,
    ]);
  });

  it("C4: dry-run logs for E4 and E5 are pinned", () => {
    const e4 = run(tmp, { objectTypes: [{ name: "Text", plugin: "Json" }] }, true);
    assert.isUndefined(e4.err);
    assert.deepEqual(e4.lines, [
      "Recipe: 1 objectType(s), 0 operation(s)",
      "\n--- Dry run (no files written) ---\n",
      "objectTypes:",
      "  SKIP objectTypes/Text.json (already exists)",
      "  UPDATE scripts/ts-defs/instanceTypes.d.ts",
      "  UPDATE scripts/ts-defs/objects.d.ts",
      "",
      "\nValidation passed. Run without --dry-run to apply.",
    ]);
    const e5 = run(tmp, E5, true);
    assert.isUndefined(e5.err);
    assert.deepEqual(e5.lines, [
      "Recipe: 1 objectType(s), 1 addInstVars type(s), 0 operation(s)",
      "\n--- Dry run (no files written) ---\n",
      "objectTypes:",
      "  CREATE objectTypes/NewJ.json (plugin: Json)",
      "  UPDATE scripts/ts-defs/instanceTypes.d.ts",
      "  UPDATE scripts/ts-defs/objects.d.ts",
      "",
      "addInstVars:",
      '  UPDATE pending objectType "NewJ" (+v)',
      "",
      "\nValidation passed. Run without --dry-run to apply.",
    ]);
  });

  it("C5: apply and dry-run check a CREATEd sheet in different orders", () => {
    const recipe = {
      files: {
        "eventSheets/NewE2/Both.json": {
          create: true,
          events: [
            { "custom-ace-block": { object: "Text", aceType: "action" } },
            { block: { actions: [{ "custom-action": "OnClickAction", object: "NavButton", family: "TextFamily" }] } },
          ],
        },
      },
    };
    const dry = run(tmp, recipe, true);
    assert.isDefined(dry.err);
    assert.equal(dry.err!.message.split("\n")[0], "Editor-validation failed for eventSheets/NewE2/Both.json:");
    assert.deepEqual(dry.lines, [
      "Recipe: 1 eventSheet file(s), 1 operation(s)",
      "\n--- Dry run (no files written) ---\n",
      "files:",
      "  CREATE eventSheets/NewE2/Both.json (2 events)",
    ]);
    const applied = run(tmp, recipe, false);
    assert.isDefined(applied.err);
    assert.equal(
      applied.err!.message.split("\n")[0],
      "Custom-action validation failed for eventSheets/NewE2/Both.json:",
    );
    assert.deepEqual(applied.lines, ["Recipe: 1 eventSheet file(s), 1 operation(s)", "\nfiles:"]);
  });
});

// Each row asserts the refusal (error text, exit code) FIRST and the file state LAST, so a red run
// names which half failed.
describe("a refused apply writes nothing (#279)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = copyFixture("c3chef-apply-refused-");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const a2 = {
    layouts: { "layouts/Templates Layout.json": [{ op: "add-layer", name: "P" }] },
    files: { "eventSheets/Gameplay/Event sheet 1.json": [{ op: "remove-event", path: "sid:123456789012345" }] },
  };

  function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
    return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
  }

  it("B1: an editor-invalid CREATE (#278) is refused and leaves no empty directory behind", () => {
    const { err } = run(tmp, {
      files: {
        "eventSheets/NewFolder278/Bad.json": {
          create: true,
          events: [{ "custom-ace-block": { object: "Text", aceType: "action" } }],
        },
      },
    });
    assert.isDefined(err);
    assert.equal(
      err!.message,
      `Editor-validation failed for ${path.join(tmp, "eventSheets", "NewFolder278", "Bad.json")}:\n` +
        "  - events[0] [custom-ace-name-required]: CustomAceBlockEvent.aceName must be a string (C3 editor refuses to open the project)",
    );
    assert.isFalse(existsSync(path.join(tmp, "eventSheets", "NewFolder278", "Bad.json")), "Bad.json written");
    assert.isFalse(existsSync(path.join(tmp, "eventSheets", "NewFolder278")), "empty NewFolder278 left behind");
  });

  // Runtime: each CLI spawn takes a few seconds under tsx (measured ~3-5 s here); the 60 s ceiling is for slow CI.
  it("B2: the CLI refuses A2 with one error, prints no layout MODIFIED line and leaves the layout unchanged", function () {
    this.timeout(60000);
    const recipePath = path.join(tmp, "a2.json");
    writeFileSync(recipePath, JSON.stringify(a2));
    const layoutPath = path.join(tmp, "layouts", "Templates Layout.json");
    const layoutBefore = readFileSync(layoutPath);
    const r = runCli(["apply-recipe", recipePath, "--project-dir", tmp, "--no-regenerate"]);
    assert.equal(r.exitCode, 1);
    const msg =
      'Error: Cannot split node path "sid:123456789012345" — expected format like "events[N]" or "events[N].children[M]"';
    assert.equal(r.stderr.split(msg).length - 1, 1, "error text count in stderr");
    const outLines = r.stdout.split(/\r?\n/);
    assert.equal(
      outLines.filter((l) => l.includes("MODIFIED layouts/Templates Layout.json")).length,
      0,
      "MODIFIED layout lines in stdout",
    );
    assert.equal(outLines.filter((l) => l === "files:").length, 0, "files: header lines in stdout");
    assert.isTrue(readFileSync(layoutPath).equals(layoutBefore), "layout file changed");
  });

  it("B4: a layout failure and a files failure in one recipe refuse identically for apply and dry-run, writing nothing", () => {
    const recipe = {
      layouts: {
        "layouts/Templates Layout.json": [{ op: "add-layer", name: "P" }],
        "layouts/UI/Second Layout.json": [{ op: "rename-layer", currentName: "NoSuchLayer", newName: "X" }],
      },
      files: { "eventSheets/Gameplay/Event sheet 1.json": [{ op: "remove-event", path: "sid:123456789012345" }] },
    };
    const before = snapshotTree(tmp);
    const applied = run(tmp, recipe);
    const dry = run(tmp, recipe, true);
    const expected = 'renameLayer: layer "NoSuchLayer" not found in layout';
    assert.isDefined(applied.err);
    assert.include(applied.err!.message, expected);
    assert.isDefined(dry.err);
    assert.include(dry.err!.message, expected);
    assert.deepEqual(changedFiles(before, snapshotTree(tmp)), []);
  });

  it("C6: an addInstVars failure after a new objectType leaves the objectType and ts-defs unwritten", () => {
    const dts = path.join(tmp, "scripts", "ts-defs", "instanceTypes.d.ts");
    const dtsBefore = readFileSync(dts, "utf8");
    const { err } = run(tmp, {
      objectTypes: [{ name: "GoodJ", plugin: "Json" }],
      addInstVars: [{ type: "NoSuchType", instanceVariables: [{ name: "v", type: "number" }] }],
    });
    assert.isDefined(err);
    assert.include(err!.message, 'addInstVars: objectType "NoSuchType" not found under objectTypes/');
    assert.isFalse(existsSync(path.join(tmp, "objectTypes", "GoodJ.json")), "GoodJ.json written");
    assert.equal(readFileSync(dts, "utf8"), dtsBefore, "instanceTypes.d.ts changed");
  });
});
