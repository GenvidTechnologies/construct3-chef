import { describe, it } from "mocha";
import { assert } from "chai";
import { rmSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed, applyRecipeInner, createObjectType, processAddInstVars } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { freshSidGen } from "../../src/c3/sidUtils.js";
import { copyFixture, snapshotTree } from "../helpers/applyFixtures.js";

// Pins that dry-run, preview and apply agree (#280). Expected values are the behaviour after the
// one-compute-pass change; R3, R9, R10 and R12 also held before it, the other rows were red then.

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

// Second is read as a `from:` source before it is mutated; Templates then copies the 9patch Second gained.
const P3 = {
  layouts: {
    "layouts/Gameplay/Main Layout.json": [
      { op: "copy-instance", type: "Text", from: "layouts/UI/Second Layout.json", targetLayer: "layer 0" },
    ],
    "layouts/UI/Second Layout.json": [
      { op: "copy-instance", type: "9patch", from: "layouts/Gameplay/Main Layout.json", targetLayer: "layer 0" },
    ],
    "layouts/Templates Layout.json": [
      { op: "copy-instance", type: "9patch", from: "layouts/UI/Second Layout.json", targetLayer: "Layer 0" },
    ],
  },
};

const PV = [{ name: "pv", type: "number" }];
// Text exists on disk, so the second entry has nothing left to add.
const P1 = {
  addInstVars: [
    { type: "Text", instanceVariables: PV },
    { type: "Text", instanceVariables: PV },
  ],
};
// Re-declares an existing objectType (a SKIP), then adds an instance variable to it.
const P2 = { objectTypes: [{ name: "Text", plugin: "Json" }], addInstVars: [{ type: "Text", instanceVariables: PV }] };
const SIDMIX = {
  objectTypes: [{ name: "NewJ", plugin: "Json" }],
  addInstVars: [
    { type: "NewJ", instanceVariables: [{ name: "v", type: "number" }] },
    { type: "Text", instanceVariables: PV },
    { type: "Text", instanceVariables: PV },
  ],
  layouts: {
    "layouts/Templates Layout.json": [
      { op: "copy-instance", type: "Text", from: "layouts/UI/Second Layout.json", targetLayer: "Layer 0" },
    ],
  },
};

/** The lines of the addInstVars section: from its header to the next blank line or `\n`-led line. */
function addInstVarsLines(lines: string[]): string[] {
  const at = lines.findIndex((l) => l.endsWith("addInstVars:"));
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => l === "" || l.startsWith("\n"));
  return end < 0 ? rest : rest.slice(0, end);
}

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

  it("UP280-R1: a CREATEd sheet failing both checks gives the same first error in both modes, editor-load first", () => {
    const { dry, apply } = runBoth(C5);
    assert.deepEqual(
      { dry: dry.err, apply: apply.err },
      {
        dry: "Editor-validation failed for eventSheets/NewE2/Both.json:",
        apply: "Editor-validation failed for eventSheets/NewE2/Both.json:",
      },
    );
  });

  it("UP280-R2: a modified sheet failing both checks gives the same first error in both modes", () => {
    // The variable lacks `comment` (editor-load) and the family custom-action lacks `family` (runtime-resolution).
    const recipe = {
      files: {
        Target: [
          {
            op: "insert-actions",
            in: "sid:200000000000001",
            after: -1,
            actions: [{ "custom-action": "Refresh", object: "Widget" }],
          },
        ],
      },
    };
    const drive = (root: string, r: Recipe, o: object) => applyRecipeInner(freshSidGen(), root, r, o);
    const mk = () => targetProject({});
    const dry = runIn(mk, drive, recipe, { dryRun: true });
    const apply = runIn(mk, drive, recipe, {});
    assert.deepEqual(
      { dry: dry.err, apply: apply.err },
      {
        dry: "Editor-validation failed for eventSheets/Target.json:",
        apply: "Editor-validation failed for eventSheets/Target.json:",
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

  it("UP280-R7: a layout read as a copy source then mutated is not served stale to later layouts", () => {
    const { dry, apply } = runBoth(P3);
    assert.deepEqual(
      {
        dryErr: dry.err,
        applyErr: apply.err,
        templates9patch: apply.read("layouts/Templates Layout.json").includes('"type": "9patch"'),
      },
      { dryErr: undefined, applyErr: undefined, templates9patch: true },
    );
  });

  it("UP280-R4: the all-sections recipe's dry-run output keeps its rendering and real addInstVars lines", () => {
    const { dry } = runBoth(ALL4);
    assert.deepEqual(dry.lines, [
      "Recipe: 1 objectType(s), 1 addInstVars type(s), 2 eventSheet file(s), 1 layout file(s), 3 operation(s)",
      BANNER,
      "objectTypes:",
      "  CREATE objectTypes/WfJ.json (plugin: Json)",
      "  UPDATE scripts/ts-defs/instanceTypes.d.ts",
      "  UPDATE scripts/ts-defs/objects.d.ts",
      "",
      "addInstVars:",
      "  UPDATE objectTypes/WfJ.json (+v)",
      "  No layout instances found for WfJ",
      "  UPDATE scripts/ts-defs/instanceTypes.d.ts (+v)",
      "",
      "layouts:",
      "  MODIFY layouts/Templates Layout.json (1 ops)",
      '    - add-layer name="WF"',
      "",
      "files:",
      "  MODIFY eventSheets/Gameplay/Event sheet 1.json (1 ops)",
      "    - insert-event",
      "  CREATE eventSheets/WfFolder/Fresh.json (0 events)",
      "",
      "\nValidation passed. Run without --dry-run to apply.",
    ]);
  });

  it("UP280-R5: addInstVars on a type the recipe re-declares prints apply's lines in dry tense", () => {
    const { dry, apply } = runBoth(P2);
    assert.deepEqual(
      { dry: addInstVarsLines(dry.lines), apply: addInstVarsLines(apply.lines) },
      {
        dry: [
          "  UPDATE objectTypes/Text.json (+pv)",
          "  UPDATE layouts/UI/Second Layout.json (1 instance(s))",
          "  UPDATE scripts/ts-defs/instanceTypes.d.ts (+pv)",
        ],
        apply: [
          "  UPDATED objectTypes/Text.json (+pv)",
          "  UPDATED layouts/UI/Second Layout.json (1 instance(s))",
          "  UPDATED scripts/ts-defs/instanceTypes.d.ts (+pv)",
        ],
      },
    );
  });

  it("UP280-R6: a repeated addInstVars entry SKIPs in dry-run, as in apply", () => {
    const { dry, apply } = runBoth(P1);
    const triple = (tense: string) => [
      `  ${tense} objectTypes/Text.json (+pv)`,
      `  ${tense} layouts/UI/Second Layout.json (1 instance(s))`,
      `  ${tense} scripts/ts-defs/instanceTypes.d.ts (+pv)`,
    ];
    const tail = ["  SKIP objectTypes/Text.json (all instVars already exist)", "  No layout instances found for Text"];
    assert.deepEqual(
      { dry: addInstVarsLines(dry.lines), apply: addInstVarsLines(apply.lines) },
      { dry: [...triple("UPDATE"), ...tail], apply: [...triple("UPDATED"), ...tail] },
    );
  });

  it("UP280-R8: dry-run and apply mint SIDs equally on one recipe-wide generator", () => {
    const count = (flags: Flags): number => {
      let n = 0;
      let next = 500000000000000;
      const drive = (root: string, r: Recipe, o: object) =>
        applyRecipeInner(
          () => {
            n++;
            return next++;
          },
          root,
          r,
          o,
        );
      const mode = runIn(() => copyFixture("c3chef-parity-"), drive, SIDMIX, flags);
      assert.isUndefined(mode.err);
      return n;
    };
    assert.deepEqual({ dry: count({ dryRun: true }), apply: count({}) }, { dry: 4, apply: 4 });
  });

  it("UP280-R11: the public wrappers in dry-run print the real lines and leave the tree unchanged", () => {
    const root = copyFixture("c3chef-parity-");
    try {
      const before = snapshotTree(root);
      const lines: string[] = [];
      const log = (...a: unknown[]) => lines.push(a.join(" "));
      const sg = freshSidGen();
      const pv = [{ name: "pv", type: "number" as const }];
      createObjectType(sg, root, { name: "NewJ", plugin: "Json" }, true, log);
      processAddInstVars(sg, root, [{ type: "NewJ", instanceVariables: [{ name: "v", type: "number" }] }], true, log, [
        { name: "NewJ", plugin: "Json" },
      ]);
      processAddInstVars(
        sg,
        root,
        [
          { type: "Text", instanceVariables: pv },
          { type: "Text", instanceVariables: pv },
        ],
        true,
        log,
      );
      assert.deepEqual(
        { lines, changed: diffTrees(before, snapshotTree(root)) },
        {
          lines: [
            "  CREATE objectTypes/NewJ.json (plugin: Json)",
            "  UPDATE objectTypes/NewJ.json (+v)",
            "  No layout instances found for NewJ",
            "  UPDATE scripts/ts-defs/instanceTypes.d.ts (+v)",
            "  UPDATE objectTypes/Text.json (+pv)",
            "  UPDATE layouts/UI/Second Layout.json (1 instance(s))",
            "  UPDATE scripts/ts-defs/instanceTypes.d.ts (+pv)",
            "  SKIP objectTypes/Text.json (all instVars already exist)",
            "  No layout instances found for Text",
          ],
          changed: [],
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
