import { describe, it, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildLayoutEventSheetMap,
  findGoToLayoutCalls,
  generatePlantUML,
  type NavEntry,
} from "../../src/c3/navigationGraph.js";

/** Write a minimal layout JSON file into `dir` with the given name and eventSheet. */
function writeLayout(dir: string, name: string, eventSheet: string): void {
  const json = JSON.stringify({ name, eventSheet, layers: [] });
  writeFileSync(path.join(dir, `${name}.json`), json, "utf-8");
}

/** Write a DSL text file into `dir` with the given filename and content. */
function writeDsl(dir: string, filename: string, content: string): void {
  writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("navigationGraph", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "burbank-navgraph-"));
    tmpDirs.push(dir);
    return dir;
  }

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────
  // buildLayoutEventSheetMap
  // ────────────────────────────────────────────────────────────

  describe("buildLayoutEventSheetMap", () => {
    it("reads multiple layout files and returns correct map", () => {
      const dir = makeTmpDir();
      writeLayout(dir, "WatchLayout", "WatchEvents");
      writeLayout(dir, "HeroLayout", "HeroEvents");
      writeLayout(dir, "LoginLayout", "LoginFunctionsEvents");

      const map = buildLayoutEventSheetMap(dir);

      assert.deepEqual(map, {
        WatchLayout: "WatchEvents",
        HeroLayout: "HeroEvents",
        LoginLayout: "LoginFunctionsEvents",
      });
    });

    it("ignores .uistate.json files", () => {
      const dir = makeTmpDir();
      writeLayout(dir, "WatchLayout", "WatchEvents");
      // Write a .uistate.json file that should be excluded
      writeFileSync(
        path.join(dir, "WatchLayout.uistate.json"),
        JSON.stringify({ name: "Bad", eventSheet: "BadEvents" }),
        "utf-8",
      );

      const map = buildLayoutEventSheetMap(dir);

      assert.deepEqual(map, { WatchLayout: "WatchEvents" });
    });

    it("returns empty map when no layout files exist", () => {
      const dir = makeTmpDir();
      const map = buildLayoutEventSheetMap(dir);
      assert.deepEqual(map, {});
    });
  });

  // ────────────────────────────────────────────────────────────
  // findGoToLayoutCalls
  // ────────────────────────────────────────────────────────────

  describe("findGoToLayoutCalls", () => {
    it('call pattern: finds `do: call GoToLayout("TargetLayout", ...)` entries', () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "WatchEvents.dsl.txt",
        [
          "# WatchEvents",
          "# Source: eventSheets/Watch/WatchEvents.json",
          "",
          "block",
          '      do: call GoToLayout("DecisionsLayout", preload, 0)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      assert.deepEqual(entries, [
        {
          fromSheet: "WatchEvents",
          targetLayout: "DecisionsLayout",
          lineNumber: 5,
        },
      ] satisfies NavEntry[]);
    });

    it('script pattern: finds `GoToLayout("TargetLayout", ...)` in script context', () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "CustomEvents.dsl.txt",
        [
          "# CustomEvents",
          "# Source: eventSheets/CustomEvents.json",
          "",
          "  do: script { // → CustomEvents_Event1_Act1",
          '    GoToLayout("BattleLayout", 0, 0);',
          "  }",
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      assert.deepEqual(entries, [
        {
          fromSheet: "CustomEvents",
          targetLayout: "BattleLayout",
          lineNumber: 5,
        },
      ] satisfies NavEntry[]);
    });

    it("skips function definition: `async function GoToLayout(...)` is NOT treated as a navigation call", () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "RUMEvents.dsl.txt",
        [
          "# RUMEvents",
          "# Source: eventSheets/Common/RUMEvents.json",
          "",
          "  async function GoToLayout(name: string = , preload: number = 0, snapshot: number = 0) -> none [category: RUM Utils] -- Wrapper for GoToLayout",
          '      do: call GoToLayout("ActualLayout", 0, 0)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      // Only the call on line 5 should be found, not the function definition on line 4
      assert.lengthOf(entries, 1);
      assert.equal(entries[0].lineNumber, 5);
      assert.equal(entries[0].targetLayout, "ActualLayout");
    });

    it("skips function definition: `function GoToLayout(...)` (non-async) is NOT treated as a navigation call", () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "NavEvents.dsl.txt",
        [
          "# NavEvents",
          "# Source: eventSheets/NavEvents.json",
          "",
          "  function GoToLayout(name: string = ) -> none",
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      assert.deepEqual(entries, []);
    });

    it("skips variable targets: `call GoToLayout(someVar, ...)` (no quotes) is NOT included", () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "LoadingEvents.dsl.txt",
        [
          "# LoadingEvents",
          "# Source: eventSheets/LoadingEvents.json",
          "",
          "    do: call GoToLayout(levelLayoutName, 0, 0)",
          '    do: call GoToLayout("BattleLayout", 0, 0)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      // Only the quoted-string call should be included
      assert.deepEqual(entries, [
        {
          fromSheet: "LoadingEvents",
          targetLayout: "BattleLayout",
          lineNumber: 5,
        },
      ] satisfies NavEntry[]);
    });

    it("line numbers: returned lineNumber is 1-indexed and correct", () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "HeaderEvents.dsl.txt",
        [
          "# HeaderEvents",
          "# Source: eventSheets/HeaderEvents.json",
          "",
          'group "Header" (active)',
          "  block",
          '    do: call GoToLayout("ProfileModalLayout", 0, 1)',
          "  block",
          '    do: call GoToLayout("ProfileModalLayout", 0, 1)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      assert.lengthOf(entries, 2);
      assert.equal(entries[0].lineNumber, 6);
      assert.equal(entries[1].lineNumber, 8);
    });

    it("recursive scan: finds DSL files in subdirectories", () => {
      const dir = makeTmpDir();
      const subDir = path.join(dir, "Watch");
      mkdirSync(subDir);

      writeDsl(
        dir,
        "TopLevelEvents.dsl.txt",
        [
          "# TopLevelEvents",
          "# Source: eventSheets/TopLevelEvents.json",
          "",
          '  do: call GoToLayout("LoginLayout", 0, 0)',
        ].join("\n"),
      );

      writeDsl(
        subDir,
        "WatchEvents.dsl.txt",
        [
          "# WatchEvents",
          "# Source: eventSheets/Watch/WatchEvents.json",
          "",
          '  do: call GoToLayout("DecisionsLayout", 0, 0)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      // Should find entries from both files
      const fromSheets = entries.map((e) => e.fromSheet).sort();
      assert.deepEqual(fromSheets, ["TopLevelEvents", "WatchEvents"]);

      const targets = entries.map((e) => e.targetLayout).sort();
      assert.deepEqual(targets, ["DecisionsLayout", "LoginLayout"]);
    });

    it("DSL header parsing: fromSheet is taken from the `# SheetName` header line", () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "SomeFile.dsl.txt",
        [
          "# ActualSheetName",
          "# Source: eventSheets/SomeFile.json",
          "",
          '  do: call GoToLayout("TargetLayout", 0, 0)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      assert.lengthOf(entries, 1);
      assert.equal(entries[0].fromSheet, "ActualSheetName");
    });

    it("multiple calls in one file: all are found and ordered by line number", () => {
      const dir = makeTmpDir();
      writeDsl(
        dir,
        "MainMenuEvents.dsl.txt",
        [
          "# MainMenuEvents",
          "# Source: eventSheets/MainMenuEvents.json",
          "",
          '  do: call GoToLayout("ShopLayout", 0, 0)',
          "  // some comment",
          '  do: call GoToLayout("BattleLayout", 0, 0)',
          "  do: call GoToLayout(dynamicVar, 0, 0)",
          '  do: call GoToLayout("HeroesLayout", 0, 0)',
        ].join("\n"),
      );

      const entries = findGoToLayoutCalls(dir);

      assert.deepEqual(entries, [
        { fromSheet: "MainMenuEvents", targetLayout: "ShopLayout", lineNumber: 4 },
        { fromSheet: "MainMenuEvents", targetLayout: "BattleLayout", lineNumber: 6 },
        { fromSheet: "MainMenuEvents", targetLayout: "HeroesLayout", lineNumber: 8 },
      ] satisfies NavEntry[]);
    });

    it("ignores non-.dsl.txt files", () => {
      const dir = makeTmpDir();
      writeFileSync(
        path.join(dir, "SomeEvents.ts"),
        ["// WatchEvents", 'GoToLayout("ShouldNotAppear", 0, 0)'].join("\n"),
        "utf-8",
      );

      const entries = findGoToLayoutCalls(dir);
      assert.deepEqual(entries, []);
    });
  });

  // ────────────────────────────────────────────────────────────
  // generatePlantUML
  // ────────────────────────────────────────────────────────────

  describe("generatePlantUML", () => {
    it("returns a @startuml/@enduml block with no edges for empty entries", () => {
      const result = generatePlantUML([], {});
      assert.match(result, /^@startuml/);
      assert.match(result, /@enduml\s*$/);
      assert.notInclude(result, "-->");
    });

    it("resolves fromSheet to its owning layout when available", () => {
      const entries: NavEntry[] = [{ fromSheet: "ShopEvents", targetLayout: "BattleLayout", lineNumber: 10 }];
      const sheetToLayout: Record<string, string> = { ShopEvents: "ShopLayout" };
      const result = generatePlantUML(entries, sheetToLayout);
      assert.include(result, "[ShopLayout] --> [BattleLayout]");
      assert.notInclude(result, "ShopEvents");
    });

    it("uses sheet name directly when fromSheet has no owning layout", () => {
      const entries: NavEntry[] = [{ fromSheet: "GenericFunctionsEvents", targetLayout: "ShopLayout", lineNumber: 42 }];
      const result = generatePlantUML(entries, {});
      assert.include(result, "[GenericFunctionsEvents] --> [ShopLayout]");
    });

    it("deduplicates multiple GoToLayout calls from the same source to the same target", () => {
      const entries: NavEntry[] = [
        { fromSheet: "GoalsGoBtnEvents", targetLayout: "BattleLayout", lineNumber: 10 },
        { fromSheet: "GoalsGoBtnEvents", targetLayout: "BattleLayout", lineNumber: 44 },
      ];
      const result = generatePlantUML(entries, {});
      const matches = result.match(/\[GoalsGoBtnEvents\] --> \[BattleLayout\]/g) ?? [];
      assert.strictEqual(matches.length, 1, "duplicate edge should appear only once");
    });

    it("emits one edge per unique source→target pair", () => {
      const entries: NavEntry[] = [
        { fromSheet: "ShopEvents", targetLayout: "BattleLayout", lineNumber: 1 },
        { fromSheet: "ShopEvents", targetLayout: "HeroSelectLayout", lineNumber: 2 },
      ];
      const sheetToLayout: Record<string, string> = { ShopEvents: "ShopLayout" };
      const result = generatePlantUML(entries, sheetToLayout);
      assert.include(result, "[ShopLayout] --> [BattleLayout]");
      assert.include(result, "[ShopLayout] --> [HeroSelectLayout]");
    });

    it("sorts edges alphabetically by source then target for stable output", () => {
      const entries: NavEntry[] = [
        { fromSheet: "ZEvents", targetLayout: "ZLayout", lineNumber: 1 },
        { fromSheet: "AEvents", targetLayout: "BLayout", lineNumber: 2 },
        { fromSheet: "AEvents", targetLayout: "ALayout", lineNumber: 3 },
      ];
      const result = generatePlantUML(entries, {});
      const lines = result.split("\n").filter((l) => l.includes("-->"));
      assert.strictEqual(lines[0].trim(), "[AEvents] --> [ALayout]");
      assert.strictEqual(lines[1].trim(), "[AEvents] --> [BLayout]");
      assert.strictEqual(lines[2].trim(), "[ZEvents] --> [ZLayout]");
    });

    it("defaults to 'NavigationGraph' as the diagram name", () => {
      const result = generatePlantUML([], {});
      assert.match(result, /@startuml\s+NavigationGraph/);
    });

    it("uses the provided name as the diagram name", () => {
      const result = generatePlantUML([], {}, "navigation-graph");
      assert.match(result, /@startuml\s+navigation-graph/);
    });
  });
});
