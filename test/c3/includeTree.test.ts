import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  buildSheetNameMap,
  extractFunctions,
  resolveIncludeTree,
  formatIncludeTree,
  flattenIncludeTree,
} from "../../src/c3/includeTree.js";

// ─── Test fixtures ───

let tmpDir: string;

function writeSheet(relPath: string, events: unknown[]): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify({ events }));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "includeTree-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── buildSheetNameMap ───

describe("buildSheetNameMap", () => {
  it("maps sheet names to relative paths", () => {
    writeSheet("eventSheets/Common/CommonEvents.json", []);
    writeSheet("eventSheets/GoalsEvents.json", []);

    const map = buildSheetNameMap(tmpDir);
    assert.equal(map.get("CommonEvents"), "eventSheets/Common/CommonEvents.json");
    assert.equal(map.get("GoalsEvents"), "eventSheets/GoalsEvents.json");
    assert.equal(map.size, 2);
  });

  it("handles nested subdirectories", () => {
    writeSheet("eventSheets/A/B/DeepSheet.json", []);
    const map = buildSheetNameMap(tmpDir);
    assert.equal(map.get("DeepSheet"), "eventSheets/A/B/DeepSheet.json");
  });

  // Editor-local exclusion is delegated to c3source (isEditorLocalPath), so the
  // next three tests MUST stay synthetic: the construct3-chef-sample fixture carries
  // zero editor-local files under eventSheets/, so a fixture-based version would pass
  // vacuously — asserting nothing about the exclusion. (That trap was live in this
  // repo until #149 closed it — see the K1-K3/L1-L3 seeded synthetic tests under
  // "list-event-sheets"/"list-layouts" in test/mcp/serverHandlers.test.ts, and ADR
  // wiki/decisions/0019.)
  //
  // One test per dimension, deliberately. EDITOR_LOCAL_EXCLUSIONS has three
  // independent mechanisms — fileSuffixes ([".uistate.json"]), dirs (["uistate",
  // "ts-defs"]) and exactNames (["tsconfig.json"]) — and a single combined test
  // could not say which one regressed. See ADR wiki/decisions/0016.
  it("excludes *.uistate.json siblings", () => {
    writeSheet("eventSheets/Real.json", []);
    writeSheet("eventSheets/Real.uistate.json", []);

    const map = buildSheetNameMap(tmpDir);
    assert.equal(map.get("Real"), "eventSheets/Real.json");
    assert.isFalse(map.has("Real.uistate"));
    assert.equal(map.size, 1);
  });

  it("does not descend into uistate/ subfolders", () => {
    writeSheet("eventSheets/Real.json", []);
    writeSheet("eventSheets/uistate/Hidden.json", []);

    const map = buildSheetNameMap(tmpDir);
    assert.isFalse(map.has("Hidden"));
    assert.equal(map.size, 1);
  });

  // The exactNames dimension is the non-obvious one, and it was LIVE here rather
  // than theoretical: tsconfig.json IS a .json file, so the hand-rolled walk this
  // replaced would have registered a sheet named "tsconfig". It is exactly what a
  // hand-written `.endsWith(".json")` predicate cannot express — the reason to use
  // c3source's named collector rather than the generic walk plus a local predicate.
  it("excludes the editor-owned tsconfig.json", () => {
    writeSheet("eventSheets/Real.json", []);
    writeSheet("eventSheets/tsconfig.json", []);

    const map = buildSheetNameMap(tmpDir);
    assert.isFalse(map.has("tsconfig"));
    assert.equal(map.size, 1);
  });

  // The map is keyed on the bare sheet name, so two sheets sharing a name in
  // different folders collide. The winner is simply the LAST one the walk visits
  // in its sorted depth-first order — not the shallowest and not the deepest.
  // Here the sorted eventSheets/ level is ["Dup.json", "Nested"]: "Dup.json" is
  // registered first, then "Nested" is recursed into and overwrites it. Rename
  // "Nested" to something sorting before "Dup.json" and the shallow one wins
  // instead. A duplicate sheet name is unreachable in a valid C3 project
  // (manifest names are unique project-wide), so this locks determinism only —
  // there is no semantic preference between the two paths.
  it("resolves a duplicate sheet name deterministically (last in the walk's sorted DFS order)", () => {
    writeSheet("eventSheets/Nested/Dup.json", []);
    writeSheet("eventSheets/Dup.json", []);

    const map = buildSheetNameMap(tmpDir);
    assert.equal(map.get("Dup"), "eventSheets/Nested/Dup.json");
  });
});

// ─── extractFunctions ───

describe("extractFunctions", () => {
  it("extracts function-block names with signatures", () => {
    const events = [
      { eventType: "function-block", functionName: "doStuff", functionParameters: [], isAsync: false },
      { eventType: "function-block", functionName: "loadData", functionParameters: [], isAsync: true },
    ];
    const fns = extractFunctions(events as never);
    assert.deepStrictEqual(fns, ["doStuff() -> none", "loadData() -> none"]);
  });

  it("renders params and return type", () => {
    const events = [
      {
        eventType: "function-block",
        functionName: "add",
        functionReturnType: "number",
        functionParameters: [
          { name: "a", type: "number" },
          { name: "b", type: "number" },
        ],
        isAsync: false,
      },
    ];
    const fns = extractFunctions(events as never);
    assert.deepStrictEqual(fns, ["add(a: number, b: number) -> number"]);
  });

  it("extracts custom-ace-block as Object.Name with signature", () => {
    const events = [
      { eventType: "custom-ace-block", objectClass: "CardScroller", aceName: "Initialize", functionParameters: [] },
    ];
    const fns = extractFunctions(events as never);
    assert.deepStrictEqual(fns, ["CardScroller.Initialize() -> none"]);
  });

  it("walks into groups", () => {
    const events = [
      {
        eventType: "group",
        title: "MyGroup",
        children: [{ eventType: "function-block", functionName: "nested", functionParameters: [], isAsync: false }],
      },
    ];
    const fns = extractFunctions(events as never);
    assert.deepStrictEqual(fns, ["nested() -> none"]);
  });

  it("returns empty for sheets with no functions", () => {
    const events = [
      { eventType: "block", conditions: [], actions: [] },
      { eventType: "comment", text: "just a comment" },
    ];
    const fns = extractFunctions(events as never);
    assert.deepStrictEqual(fns, []);
  });
});

// ─── resolveIncludeTree ───

describe("resolveIncludeTree", () => {
  it("resolves direct includes", () => {
    writeSheet("eventSheets/Root.json", [
      { eventType: "include", includeSheet: "ChildA" },
      { eventType: "include", includeSheet: "ChildB" },
    ]);
    writeSheet("eventSheets/ChildA.json", []);
    writeSheet("eventSheets/ChildB.json", []);

    const tree = resolveIncludeTree("Root", tmpDir);
    assert.equal(tree.name, "Root");
    assert.equal(tree.includes.length, 2);
    assert.equal(tree.includes[0].name, "ChildA");
    assert.equal(tree.includes[1].name, "ChildB");
  });

  it("resolves includes nested inside a group", () => {
    writeSheet("eventSheets/Root.json", [
      { eventType: "include", includeSheet: "TopLevel" },
      { eventType: "group", children: [{ eventType: "include", includeSheet: "Nested" }] },
    ]);
    writeSheet("eventSheets/TopLevel.json", []);
    writeSheet("eventSheets/Nested.json", []);

    const tree = resolveIncludeTree("Root", tmpDir);
    assert.deepEqual(
      tree.includes.map((c) => c.name),
      ["TopLevel", "Nested"],
    );
  });

  it("resolves transitive includes", () => {
    writeSheet("eventSheets/Root.json", [{ eventType: "include", includeSheet: "Mid" }]);
    writeSheet("eventSheets/Mid.json", [{ eventType: "include", includeSheet: "Leaf" }]);
    writeSheet("eventSheets/Leaf.json", []);

    const tree = resolveIncludeTree("Root", tmpDir);
    assert.equal(tree.includes.length, 1);
    assert.equal(tree.includes[0].name, "Mid");
    assert.equal(tree.includes[0].includes.length, 1);
    assert.equal(tree.includes[0].includes[0].name, "Leaf");
  });

  it("detects cycles", () => {
    writeSheet("eventSheets/A.json", [{ eventType: "include", includeSheet: "B" }]);
    writeSheet("eventSheets/B.json", [{ eventType: "include", includeSheet: "A" }]);

    const tree = resolveIncludeTree("A", tmpDir);
    assert.equal(tree.includes.length, 1);
    assert.equal(tree.includes[0].name, "B");
    // B includes A, but A is already visited — cycle marker
    assert.equal(tree.includes[0].includes.length, 1);
    assert.include(tree.includes[0].includes[0].path, "(already included)");
  });

  it("handles missing includes gracefully", () => {
    writeSheet("eventSheets/Root.json", [{ eventType: "include", includeSheet: "Missing" }]);

    const tree = resolveIncludeTree("Root", tmpDir);
    assert.equal(tree.includes.length, 1);
    assert.include(tree.includes[0].path, "(not found");
  });

  it("accepts full path format", () => {
    writeSheet("eventSheets/Goals/GoalsEvents.json", []);

    const tree = resolveIncludeTree("eventSheets/Goals/GoalsEvents.json", tmpDir);
    assert.equal(tree.name, "GoalsEvents");
    assert.equal(tree.path, "eventSheets/Goals/GoalsEvents.json");
  });

  it("includes functions when requested", () => {
    writeSheet("eventSheets/Root.json", [
      { eventType: "function-block", functionName: "myFunc", functionParameters: [], isAsync: false },
      { eventType: "include", includeSheet: "Child" },
    ]);
    writeSheet("eventSheets/Child.json", [
      { eventType: "function-block", functionName: "childFunc", functionParameters: [], isAsync: false },
    ]);

    const tree = resolveIncludeTree("Root", tmpDir, { includeFunctions: true });
    assert.deepStrictEqual(tree.functions, ["myFunc() -> none"]);
    assert.deepStrictEqual(tree.includes[0].functions, ["childFunc() -> none"]);
  });

  it("omits functions when not requested", () => {
    writeSheet("eventSheets/Root.json", [
      { eventType: "function-block", functionName: "myFunc", functionParameters: [], isAsync: false },
    ]);

    const tree = resolveIncludeTree("Root", tmpDir);
    assert.isUndefined(tree.functions);
  });

  it("deduplicates shared includes", () => {
    // A includes B and C; both B and C include Shared
    writeSheet("eventSheets/A.json", [
      { eventType: "include", includeSheet: "B" },
      { eventType: "include", includeSheet: "C" },
    ]);
    writeSheet("eventSheets/B.json", [{ eventType: "include", includeSheet: "Shared" }]);
    writeSheet("eventSheets/C.json", [{ eventType: "include", includeSheet: "Shared" }]);
    writeSheet("eventSheets/Shared.json", []);

    const tree = resolveIncludeTree("A", tmpDir);
    // B includes Shared (first visit)
    assert.equal(tree.includes[0].includes[0].name, "Shared");
    assert.equal(tree.includes[0].includes[0].includes.length, 0);
    // C includes Shared (already visited — cycle marker)
    assert.include(tree.includes[1].includes[0].path, "(already included)");
  });
});

// ─── formatIncludeTree ───

describe("formatIncludeTree", () => {
  it("formats a simple tree", () => {
    writeSheet("eventSheets/Root.json", [{ eventType: "include", includeSheet: "Child" }]);
    writeSheet("eventSheets/Child.json", []);

    const tree = resolveIncludeTree("Root", tmpDir);
    const formatted = formatIncludeTree(tree);
    assert.include(formatted, "# Include Tree: Root");
    assert.include(formatted, "Root");
    assert.include(formatted, "Child");
  });

  it("shows functions when present", () => {
    writeSheet("eventSheets/Root.json", [
      { eventType: "function-block", functionName: "doThing", functionParameters: [], isAsync: false },
    ]);

    const tree = resolveIncludeTree("Root", tmpDir, { includeFunctions: true });
    const formatted = formatIncludeTree(tree);
    assert.include(formatted, "fn doThing");
  });
});

// ─── flattenIncludeTree ───

describe("flattenIncludeTree", () => {
  it("flattens a tree to unique sheet names", () => {
    writeSheet("eventSheets/A.json", [{ eventType: "include", includeSheet: "B" }]);
    writeSheet("eventSheets/B.json", [{ eventType: "include", includeSheet: "C" }]);
    writeSheet("eventSheets/C.json", []);

    const tree = resolveIncludeTree("A", tmpDir);
    const flat = flattenIncludeTree(tree);
    assert.deepStrictEqual(flat, ["A", "B", "C"]);
  });

  it("deduplicates shared includes", () => {
    writeSheet("eventSheets/Root.json", [
      { eventType: "include", includeSheet: "Left" },
      { eventType: "include", includeSheet: "Right" },
    ]);
    writeSheet("eventSheets/Left.json", [{ eventType: "include", includeSheet: "Shared" }]);
    writeSheet("eventSheets/Right.json", [{ eventType: "include", includeSheet: "Shared" }]);
    writeSheet("eventSheets/Shared.json", []);

    const tree = resolveIncludeTree("Root", tmpDir);
    const flat = flattenIncludeTree(tree);
    // Shared appears only once
    assert.equal(flat.filter((n) => n === "Shared").length, 1);
  });
});
