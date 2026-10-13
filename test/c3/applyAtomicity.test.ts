import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { rmSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { copyFixture } from "../helpers/applyFixtures.js";

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
