import { describe, it } from "mocha";
import { assert } from "chai";
import { rmSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed, applyRecipeInner } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { freshSidGen } from "../../src/c3/sidUtils.js";
import { copyFixture, snapshotTree } from "../helpers/applyFixtures.js";

// Pins that dry-run, preview and apply agree (#280), green before the one-compute-pass refactor.
// Expected values were measured by hand-written probes against 4b22079, then confirmed here.

interface Mode {
  lines: string[];
  err: string | undefined;
  changed: string[];
  calls: number;
  exists: (rel: string) => boolean;
  read: (rel: string) => string;
}

/** Paths whose existence a row asserts; `Mode.exists` answers only for these. */
const PROBES = ["eventSheets/WfFolder"];

type Flags = { dryRun?: boolean; preview?: boolean };

function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
}

/** Run one recipe on a fresh copy of `makeRoot()`; the copy is read through the returned accessors, then removed. */
function runIn(
  makeRoot: () => string,
  drive: (root: string, recipe: Recipe, o: object) => void,
  recipe: unknown,
  flags: Flags,
): Mode {
  const root = makeRoot();
  const before = snapshotTree(root);
  const lines: string[] = [];
  let calls = 0;
  let err: string | undefined;
  try {
    drive(root, JSON.parse(JSON.stringify(recipe)) as Recipe, {
      ...flags,
      regenerate: false,
      log: (...a: unknown[]) => lines.push(a.join(" ")),
      beforeSourceWrite: () => {
        calls++;
      },
    });
  } catch (e) {
    err = (e as Error).message.split("\n")[0];
  }
  const changed = diffTrees(before, snapshotTree(root));
  const contents = new Map<string, string>();
  for (const rel of changed) {
    const abs = path.join(root, rel);
    if (existsSync(abs)) contents.set(rel, readFileSync(abs, "utf8"));
  }
  // Existence is probed before the copy is removed; a lazy check after rmSync would always read false.
  const probed = new Map(PROBES.map((rel) => [rel, existsSync(path.join(root, rel))]));
  rmSync(root, { recursive: true, force: true });
  return {
    lines,
    err,
    changed,
    calls,
    exists: (rel) => probed.get(rel) ?? false,
    read: (rel) => contents.get(rel) ?? "",
  };
}

/** Dry-run and apply of one recipe, each on its own fresh fixture copy. */
function runBoth(recipe: unknown): { dry: Mode; apply: Mode } {
  const drive = (root: string, r: Recipe, o: object) => applyParsed(root, r, o);
  const mk = () => copyFixture("c3chef-parity-");
  return { dry: runIn(mk, drive, recipe, { dryRun: true }), apply: runIn(mk, drive, recipe, {}) };
}

const BANNER = "\n--- Dry run (no files written) ---\n";

const CAB = { object: "Text", aceType: "action" };
const BADCA = { actions: [{ "custom-action": "OnClickAction", object: "NavButton", family: "TextFamily" }] };
// A custom action inserted next to its own definition, so the refusal fires at the pre-write chokepoint.
const C5 = {
  files: { "eventSheets/NewE2/Both.json": { create: true, events: [{ "custom-ace-block": CAB }, { block: BADCA }] } },
};

const ALL4 = {
  objectTypes: [{ name: "WfJ", plugin: "Json" }],
  addInstVars: [{ type: "WfJ", instanceVariables: [{ name: "v", type: "number" }] }],
  layouts: { "layouts/Templates Layout.json": [{ op: "add-layer", name: "WF" }] },
  files: {
    "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", index: 0, comment: "WF" }],
    "eventSheets/WfFolder/Fresh.json": { create: true, events: [] },
  },
};

const PATCH = {
  files: {
    "eventSheets/Gameplay/Event sheet 1.json": [
      { op: "insert-event", id: "$s", index: 0, block: { actions: [{ script: ["const x = 1;"] }] } },
      { op: "patch-script", in: "$s", actionIndex: 0, find: "const x = 1;", replace: "const x = 2;" },
    ],
  },
};

// Modify-path project: a family-provided custom action whose definition lives in another sheet.
const WIDGET_CAB = {
  eventType: "custom-ace-block",
  aceType: "action",
  aceName: "Refresh",
  objectClass: "WidgetFamily",
  functionDescription: "",
  functionCategory: "",
  functionReturnType: "none",
  functionCopyPicked: false,
  functionIsAsync: false,
  functionParameters: [],
  conditions: [],
  actions: [],
  sid: 100000000000001,
};

function targetProject(variableExtras: object): string {
  const dir = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-parity-target-"));
  mkdirSync(path.join(dir, "eventSheets"));
  mkdirSync(path.join(dir, "families"));
  writeFileSync(
    path.join(dir, "eventSheets", "WidgetDefs.json"),
    JSON.stringify({ name: "WidgetDefs", sid: 900000000000001, events: [WIDGET_CAB] }),
  );
  writeFileSync(
    path.join(dir, "eventSheets", "Target.json"),
    JSON.stringify({
      name: "Target",
      sid: 900000000000010,
      events: [
        { eventType: "block", sid: 200000000000001, conditions: [], actions: [], children: [] },
        {
          eventType: "variable",
          sid: 200000000000002,
          name: "myVar",
          type: "number",
          initialValue: "0",
          isStatic: false,
          isConstant: false,
          ...variableExtras,
        },
      ],
    }),
  );
  writeFileSync(
    path.join(dir, "families", "WidgetFamily.json"),
    JSON.stringify({ name: "WidgetFamily", members: ["Widget"] }),
  );
  return dir;
}

describe("dry-run / preview / apply parity pins (#280)", function () {
  // Each row copies the whole fixture two or three times; the 5s default is too close on a loaded machine.
  this.timeout(30_000);

  it("UP280-R3: the accept control passes both modes and apply writes customActionObjectClass", () => {
    const recipe = {
      files: {
        Target: [
          {
            op: "insert-actions",
            in: "sid:200000000000001",
            after: -1,
            actions: [{ "custom-action": "Refresh", object: "Widget", family: "WidgetFamily" }],
          },
        ],
      },
    };
    const drive = (root: string, r: Recipe, o: object) => applyRecipeInner(freshSidGen(), root, r, o);
    const mk = () => targetProject({ comment: "" });
    const dry = runIn(mk, drive, recipe, { dryRun: true });
    const apply = runIn(mk, drive, recipe, {});
    assert.deepEqual(
      {
        dryErr: dry.err,
        applyErr: apply.err,
        dryChanged: dry.changed,
        applyChanged: apply.changed,
        applyCarriesClass: /"customActionObjectClass":\s*"WidgetFamily"/.test(apply.read("eventSheets/Target.json")),
      },
      {
        dryErr: undefined,
        applyErr: undefined,
        dryChanged: [],
        applyChanged: ["eventSheets/Target.json"],
        applyCarriesClass: true,
      },
    );
  });

  it("UP280-R9: on refusal dry-run narrates the plan and apply logs only the summary", () => {
    const { dry, apply } = runBoth(C5);
    const summary = "Recipe: 1 eventSheet file(s), 1 operation(s)";
    assert.deepEqual(
      { dryLines: dry.lines, applyLines: apply.lines, dryRefused: Boolean(dry.err), applyRefused: Boolean(apply.err) },
      {
        dryLines: [summary, BANNER, "files:", "  CREATE eventSheets/NewE2/Both.json (2 events)"],
        applyLines: [summary],
        dryRefused: true,
        applyRefused: true,
      },
    );
  });

  it("UP280-R10: dry-run and preview are write-free and fire no beforeSourceWrite", () => {
    const drive = (root: string, r: Recipe, o: object) => applyParsed(root, r, o);
    const mk = () => copyFixture("c3chef-parity-");
    const dry = runIn(mk, drive, ALL4, { dryRun: true });
    const preview = runIn(mk, drive, ALL4, { preview: true });
    const apply = runIn(mk, drive, ALL4, {});
    assert.deepEqual(
      {
        dry: { changed: dry.changed, calls: dry.calls, wfFolder: dry.exists("eventSheets/WfFolder") },
        preview: { changed: preview.changed, calls: preview.calls, wfFolder: preview.exists("eventSheets/WfFolder") },
        apply: { changedCount: apply.changed.length, calls: apply.calls },
      },
      {
        dry: { changed: [], calls: 0, wfFolder: false },
        preview: { changed: [], calls: 0, wfFolder: false },
        apply: { changedCount: 6, calls: 8 },
      },
    );
  });

  it("UP280-R12: patch-script find/replace and the preview diff section keep rendering", () => {
    const drive = (root: string, r: Recipe, o: object) => applyParsed(root, r, o);
    const mk = () => copyFixture("c3chef-parity-");
    const patchDry = runIn(mk, drive, PATCH, { dryRun: true });
    const allPreview = runIn(mk, drive, ALL4, { preview: true });
    const patchLines = patchDry.lines.filter((l) => l.includes("find:") || l.includes("replace:"));
    const at = allPreview.lines.indexOf("--- Preview (script diffs) ---\n");
    assert.deepEqual(
      { patchLines, previewTail: at < 0 ? allPreview.lines : allPreview.lines.slice(at) },
      {
        patchLines: ['      find:    "const x = 1;"', '      replace: "const x = 2;"'],
        previewTail: [
          "--- Preview (script diffs) ---\n",
          "  eventSheets/Gameplay/Event sheet 1.json — no script changes",
          "  CREATE eventSheets/WfFolder/Fresh.json — new file with 0 event(s)",
          "\nValidation passed. Run without --dry-run to apply.",
        ],
      },
    );
  });
});
