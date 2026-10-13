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
    // A refused apply prints only the lines logged before the in-memory compute pass (#279):
    // the "\nfiles:" header is journaled and discarded with the rest of the failed pass.
    assert.deepEqual(applied.lines, ["Recipe: 1 eventSheet file(s), 1 operation(s)"]);
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

  // R3 (#256): the CLI path with regeneration ON must refresh sid-registry.txt, not just DSL/scripts.
  it("R3: the CLI apply-recipe (regenerate on) registers a created sheet in sid-registry.txt", function () {
    this.timeout(60000);
    const recipePath = path.join(tmp, "r3.json");
    writeFileSync(
      recipePath,
      JSON.stringify({ files: { "eventSheets/R3Probe.json": { create: true, events: [{ comment: "R3" }] } } }),
    );
    const r = runCli(["apply-recipe", recipePath, "--project-dir", tmp]);
    assert.equal(r.exitCode, 0, r.stderr);
    const registry = readFileSync(path.join(tmp, "extracted", "sid-registry.txt"), "utf8");
    const hits = registry.split(/\r?\n/).filter((l) => l.includes("eventSheets/R3Probe.json"));
    assert.isAtLeast(hits.length, 1);
  });

  // R14/R31 (#256 D2): a regeneration failure AFTER the source write names what was written. The trigger is
  // deleting scripts/importsForEvents.ts, which extractScripts reads unguarded.
  function breakRegeneration(): void {
    const g = runCli(["generate", "--project-dir", tmp]);
    assert.equal(g.exitCode, 0, g.stderr);
    rmSync(path.join(tmp, "scripts", "importsForEvents.ts"));
  }

  it("R14: apply-recipe names the written source when regeneration fails after the write", function () {
    this.timeout(120000);
    breakRegeneration();
    const recipePath = path.join(tmp, "r14.json");
    writeFileSync(
      recipePath,
      JSON.stringify({ files: { "eventSheets/R14.json": { create: true, events: [{ comment: "R14" }] } } }),
    );
    const r = runCli(["apply-recipe", recipePath, "--project-dir", tmp]);
    assert.equal(r.exitCode, 1);
    assert.include(r.stdout + r.stderr, "failed after writing");
    assert.include(r.stdout + r.stderr, "Regenerating extracted/ failed after writing 1 source file(s)");
    assert.include(r.stdout + r.stderr, "Run `construct3-chef generate` once the cause is fixed.");
    assert.isTrue(existsSync(path.join(tmp, "eventSheets", "R14.json")), "new sheet missing");
  });

  it("R31: rename-symbol names the written source when regeneration fails after the write", function () {
    this.timeout(120000);
    const seedPath = path.join(tmp, "r31seed.json");
    writeFileSync(
      seedPath,
      JSON.stringify({
        files: {
          "eventSheets/R14.json": {
            create: true,
            events: [{ block: { conditions: [], actions: [{ script: ["d2Probe();"] }] } }],
          },
        },
      }),
    );
    const seed = runCli(["apply-recipe", seedPath, "--project-dir", tmp]);
    assert.equal(seed.exitCode, 0, seed.stderr);
    breakRegeneration();
    const r = runCli(["rename-symbol", "d2Probe", "d2Renamed", "--project-dir", tmp]);
    assert.equal(r.exitCode, 1);
    assert.include(r.stdout + r.stderr, "failed after writing");
    assert.include(r.stdout + r.stderr, "Regenerating extracted/ failed after writing 1 source file(s)");
    const sheet = readFileSync(path.join(tmp, "eventSheets", "R14.json"), "utf8");
    assert.equal(sheet.split("d2Renamed").length - 1, 1, "d2Renamed count in R14.json");
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

  it("a second objectType differing only in letter case does what the filesystem does (review of #279)", () => {
    // The overlay must match paths the way the disk it stands in front of does. Before the overlay, the
    // second CREATE saw the first one's file on disk: SKIP on a case-insensitive filesystem, a second file
    // on a case-sensitive one. Matching case-sensitively on Windows let it CREATE and then overwrite.
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
    const r = run(tmp, {
      objectTypes: [
        { name: "ProbeCase", plugin: "Json" },
        { name: "probecase", plugin: "Json" },
      ],
    });
    assert.isUndefined(r.err);
    const first = JSON.parse(readFileSync(path.join(tmp, "objectTypes", "ProbeCase.json"), "utf-8")) as {
      name: string;
    };
    if (caseInsensitive) {
      assert.include(r.lines, "  SKIP objectTypes/probecase.json (already exists)");
      assert.equal(first.name, "ProbeCase", "the first objectType must not be overwritten");
    } else {
      assert.notInclude(r.lines, "  SKIP objectTypes/probecase.json (already exists)");
      assert.equal(first.name, "ProbeCase");
      assert.isTrue(existsSync(path.join(tmp, "objectTypes", "probecase.json")));
    }
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
