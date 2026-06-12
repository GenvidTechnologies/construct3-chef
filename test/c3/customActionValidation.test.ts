import { describe, it, after, beforeEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyRecipeInner } from "../../src/c3/recipeApplier.js";
import { freshSidGen, type SidGenerator } from "../../src/c3/sidUtils.js";

// Integration tests for the custom-action validation hook in applyRecipeInner.
// Uses throwaway temp project dirs — never touches the golden fixture.
// Covers both the dry-run (validate-recipe) and apply paths, and both the
// file-create and file-modify entry points.

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const noop = () => {};

// ─── Project factory ───

interface ProjectOpts {
  // Event sheets to write under eventSheets/<name>.json
  sheets?: Record<string, unknown>;
  // Family JSON files to write under families/<name>.json
  families?: Record<string, unknown>;
}

/**
 * Build a minimal temp project with optional event sheets and families.
 * The directory is registered for cleanup after the suite.
 */
function makeProject(opts: ProjectOpts = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "c3-custom-action-validation-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
  for (const [name, json] of Object.entries(opts.sheets ?? {})) {
    writeFileSync(path.join(dir, "eventSheets", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
  }
  if (opts.families && Object.keys(opts.families).length > 0) {
    mkdirSync(path.join(dir, "families"), { recursive: true });
    for (const [name, json] of Object.entries(opts.families)) {
      writeFileSync(path.join(dir, "families", `${name}.json`), JSON.stringify(json, null, "\t") + "\n");
    }
  }
  return dir;
}

// ─── Fixture helpers ───

/**
 * An event sheet that DEFINES a custom action "Refresh" on family "WidgetFamily"
 * via a custom-ace-block (objectClass = "WidgetFamily").
 */
function sheetDefiningFamilyCustomAction() {
  return {
    name: "WidgetDefs",
    sid: 900000000000001,
    events: [
      {
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
      },
    ],
  };
}

/**
 * An event sheet that DEFINES a custom action "Init" DIRECTLY on "Widget"
 * (not via a family).
 */
function sheetDefiningDirectCustomAction() {
  return {
    name: "DirectDefs",
    sid: 900000000000002,
    events: [
      {
        eventType: "custom-ace-block",
        aceType: "action",
        aceName: "Init",
        objectClass: "Widget",
        functionDescription: "",
        functionCategory: "",
        functionReturnType: "none",
        functionCopyPicked: false,
        functionIsAsync: false,
        functionParameters: [],
        conditions: [],
        actions: [],
        sid: 100000000000002,
      },
    ],
  };
}

/** A target event sheet with a block that recipe ops can target. */
function targetSheet(blockSid = 200000000000001) {
  return {
    name: "Target",
    sid: 900000000000010,
    events: [
      {
        eventType: "block",
        sid: blockSid,
        conditions: [],
        actions: [],
        children: [],
      },
    ],
  };
}

/** WidgetFamily family JSON with "Widget" as member. */
function widgetFamily() {
  return { name: "WidgetFamily", members: ["Widget"] };
}

// ─── File-create recipe helpers ───

/**
 * A recipe that creates a new sheet containing a custom-action call.
 * Uses the `"custom-action"` shorthand key recognised by recipeInterpreter.
 * `family` is included only when provided.
 */
function createSheetRecipe(
  aceName: string,
  objectClass: string,
  opts: { family?: string } = {},
): Record<string, unknown> {
  const action: Record<string, unknown> = {
    "custom-action": aceName,
    object: objectClass,
    ...(opts.family ? { family: opts.family } : {}),
  };
  return {
    files: {
      // Bare key — recipeInterpreter normalises to "eventSheets/NewSheet.json"
      NewSheet: {
        create: true,
        events: [{ block: { conditions: [], actions: [action] } }],
      },
    },
  };
}

// ─── File-modify recipe helpers ───

const BLOCK_SID = 200000000000001;

/**
 * A recipe that inserts a custom-action into an existing "Target" sheet.
 * Uses the `"custom-action"` shorthand key recognised by recipeInterpreter.
 * `family` is included only when provided.
 */
function modifySheetRecipe(
  aceName: string,
  objectClass: string,
  opts: { family?: string } = {},
): Record<string, unknown> {
  const action: Record<string, unknown> = {
    "custom-action": aceName,
    object: objectClass,
    ...(opts.family ? { family: opts.family } : {}),
  };
  return {
    files: {
      // Bare key — recipeInterpreter normalises to "eventSheets/Target.json"
      Target: [
        {
          op: "insert-actions",
          in: `sid:${BLOCK_SID}`,
          after: -1,
          actions: [action],
        },
      ],
    },
  };
}

// ─── Tests ───

describe("custom-action validation in applyRecipeInner", () => {
  let sidGen: SidGenerator;
  beforeEach(() => {
    sidGen = freshSidGen();
  });

  // ─── File-create path ───

  describe("file-create path", () => {
    it("REJECTS: family-provided action inserted without family key (dry-run)", () => {
      const dir = makeProject({
        sheets: { WidgetDefs: sheetDefiningFamilyCustomAction() },
        families: { WidgetFamily: widgetFamily() },
      });
      const recipe = createSheetRecipe("Refresh", "Widget"); // no family key
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /Custom-action validation failed.*WidgetFamily.*family/s,
      );
    });

    it("PASSES: family-provided action with correct family key (dry-run)", () => {
      const dir = makeProject({
        sheets: { WidgetDefs: sheetDefiningFamilyCustomAction() },
        families: { WidgetFamily: widgetFamily() },
      });
      const recipe = createSheetRecipe("Refresh", "Widget", { family: "WidgetFamily" });
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }));
    });

    it("REJECTS: family key specifies wrong family (action not defined there)", () => {
      const dir = makeProject({
        sheets: {
          WidgetDefs: sheetDefiningFamilyCustomAction(),
          DirectDefs: sheetDefiningDirectCustomAction(),
        },
        families: {
          WidgetFamily: widgetFamily(),
          OtherFamily: { name: "OtherFamily", members: ["Widget"] },
        },
      });
      // "Refresh" is defined on WidgetFamily, not OtherFamily
      const recipe = createSheetRecipe("Refresh", "Widget", { family: "OtherFamily" });
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /Custom-action validation failed.*not defined on family "OtherFamily"/s,
      );
    });

    it("REJECTS: object is not a member of the specified family", () => {
      const dir = makeProject({
        sheets: { WidgetDefs: sheetDefiningFamilyCustomAction() },
        families: {
          WidgetFamily: { name: "WidgetFamily", members: ["SomeOtherWidget"] }, // Widget NOT a member
        },
      });
      const recipe = createSheetRecipe("Refresh", "Widget", { family: "WidgetFamily" });
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /Custom-action validation failed.*"Widget" is not a member of family "WidgetFamily"/s,
      );
    });

    it("PASSES: action defined directly on the objectClass, no family needed", () => {
      const dir = makeProject({
        sheets: { DirectDefs: sheetDefiningDirectCustomAction() },
      });
      // "Init" is defined directly on "Widget" — no family key needed
      const recipe = createSheetRecipe("Init", "Widget");
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }));
    });

    it("REJECTS and names WidgetFamily in the suggestion (apply path, no dry-run)", () => {
      const dir = makeProject({
        sheets: { WidgetDefs: sheetDefiningFamilyCustomAction() },
        families: { WidgetFamily: widgetFamily() },
      });
      const recipe = createSheetRecipe("Refresh", "Widget"); // no family key
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: false, regenerate: false, log: noop }),
        /Custom-action validation failed.*WidgetFamily.*family/s,
      );
      // The new sheet must NOT have been written to disk (bare key normalises to eventSheets/NewSheet.json)
      const newSheetPath = path.join(dir, "eventSheets", "NewSheet.json");
      assert.isFalse(
        (() => {
          try {
            readFileSync(newSheetPath, "utf-8");
            return true;
          } catch {
            return false;
          }
        })(),
        "NewSheet.json must not be created when validation fails",
      );
    });
  });

  // ─── File-modify path ───

  describe("file-modify path", () => {
    it("REJECTS: family-provided action inserted without family key (dry-run)", () => {
      const dir = makeProject({
        sheets: {
          WidgetDefs: sheetDefiningFamilyCustomAction(),
          Target: targetSheet(BLOCK_SID),
        },
        families: { WidgetFamily: widgetFamily() },
      });
      const recipe = modifySheetRecipe("Refresh", "Widget"); // no family key
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /Custom-action validation failed.*WidgetFamily.*family/s,
      );
    });

    it("PASSES: family-provided action with correct family key (dry-run)", () => {
      const dir = makeProject({
        sheets: {
          WidgetDefs: sheetDefiningFamilyCustomAction(),
          Target: targetSheet(BLOCK_SID),
        },
        families: { WidgetFamily: widgetFamily() },
      });
      const recipe = modifySheetRecipe("Refresh", "Widget", { family: "WidgetFamily" });
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }));
    });

    it("REJECTS and keeps Target.json unchanged on disk (apply path)", () => {
      const dir = makeProject({
        sheets: {
          WidgetDefs: sheetDefiningFamilyCustomAction(),
          Target: targetSheet(BLOCK_SID),
        },
        families: { WidgetFamily: widgetFamily() },
      });
      const targetPath = path.join(dir, "eventSheets", "Target.json");
      const contentBefore = readFileSync(targetPath, "utf-8");

      const recipe = modifySheetRecipe("Refresh", "Widget"); // no family key
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: false, regenerate: false, log: noop }),
        /Custom-action validation failed/,
      );

      assert.strictEqual(
        readFileSync(targetPath, "utf-8"),
        contentBefore,
        "Target.json must not be rewritten when validation fails",
      );
    });

    it("PASSES: action defined directly on objectClass (modify path, dry-run)", () => {
      const dir = makeProject({
        sheets: {
          DirectDefs: sheetDefiningDirectCustomAction(),
          Target: targetSheet(BLOCK_SID),
        },
      });
      const recipe = modifySheetRecipe("Init", "Widget"); // no family key — direct definition
      assert.doesNotThrow(() => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }));
    });

    it("REJECTS: wrong family on modify path (action not defined on that family)", () => {
      const dir = makeProject({
        sheets: {
          WidgetDefs: sheetDefiningFamilyCustomAction(),
          Target: targetSheet(BLOCK_SID),
        },
        families: {
          WidgetFamily: widgetFamily(),
          WrongFamily: { name: "WrongFamily", members: ["Widget"] },
        },
      });
      const recipe = modifySheetRecipe("Refresh", "Widget", { family: "WrongFamily" });
      assert.throws(
        () => applyRecipeInner(sidGen, dir, recipe, { dryRun: true, regenerate: false, log: noop }),
        /Custom-action validation failed.*not defined on family "WrongFamily"/s,
      );
    });
  });
});
