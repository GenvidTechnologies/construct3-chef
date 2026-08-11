import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { search } from "../../src/c3/search.js";
import type { SearchConfig, SearchResult } from "../../src/c3/search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "search");

const config: SearchConfig = {
  projectRoot: path.join(FIXTURES_DIR, "project"),
  extractedDir: path.join(FIXTURES_DIR, "extracted"),
  maxMatches: 1000,
  maxPatternLength: 500,
};

describe("search", () => {
  // ── 1. Type filter ─────────────────────────────────────────────────────────

  it("default type 'dsl' searches only .dsl.txt files", () => {
    const result = search(config, { pattern: "heroAttack" });
    // Should find in TestSheet.dsl.txt and SubDir/Other.dsl.txt
    expect(result.lines.some((l) => l.includes(".dsl.txt"))).to.be.true;
    // Should NOT find .ts lines
    expect(result.lines.some((l) => l.includes(".ts:"))).to.be.false;
    expect(result.truncated).to.be.false;
    expect(result.isExtracted).to.be.true;
  });

  it("type 'ts' searches only .ts files", () => {
    const result = search(config, { pattern: "heroAttack", type: "ts" });
    expect(result.lines.some((l) => l.includes(".ts:"))).to.be.true;
    // Should NOT find .dsl.txt lines
    expect(result.lines.some((l) => l.includes(".dsl.txt"))).to.be.false;
    expect(result.isExtracted).to.be.true;
  });

  it("type 'layout' searches only .layout.txt files", () => {
    const result = search(config, { pattern: "HeroLayer", type: "layout" });
    expect(result.lines.some((l) => l.includes(".layout.txt"))).to.be.true;
    expect(result.isExtracted).to.be.true;
  });

  it("type 'md' searches only .md files", () => {
    const result = search(config, { pattern: "heroAttack", type: "md" });
    expect(result.lines.some((l) => l.includes(".md:"))).to.be.true;
    expect(result.isExtracted).to.be.true;
  });

  it("type 'idx' searches only .dsl.idx.txt files", () => {
    const result = search(config, { pattern: "heroAttack", type: "idx" });
    expect(result.lines.some((l) => l.includes(".dsl.idx.txt"))).to.be.true;
    expect(result.isExtracted).to.be.true;
  });

  // ── 2. Single-file path ────────────────────────────────────────────────────

  it("path 'TestSheet' + dsl type resolves to a single file", () => {
    const result = search(config, { pattern: "heroAttack", type: "dsl", path: "TestSheet" });
    // Only TestSheet.dsl.txt, not SubDir/Other.dsl.txt
    expect(result.lines.every((l) => l.includes("TestSheet.dsl.txt"))).to.be.true;
    expect(result.lines.some((l) => l.includes("SubDir"))).to.be.false;
  });

  it("path resolves to single file and returns its matches", () => {
    const result = search(config, { pattern: "Event", type: "dsl", path: "TestSheet" });
    expect(result.lines.length).to.be.greaterThan(0);
    expect(result.lines.every((l) => l.includes("TestSheet.dsl.txt"))).to.be.true;
  });

  // ── 3. Directory prefix path ───────────────────────────────────────────────

  it("no path walks all matching files of the type", () => {
    const result = search(config, { pattern: "heroAttack", type: "dsl" });
    // Should find matches in both TestSheet.dsl.txt and SubDir/Other.dsl.txt
    const hasTestSheet = result.lines.some((l) => l.includes("TestSheet.dsl.txt"));
    const hasSubDir = result.lines.some((l) => l.includes("SubDir"));
    expect(hasTestSheet).to.be.true;
    expect(hasSubDir).to.be.true;
  });

  it("path as directory prefix walks only files under that prefix", () => {
    const result = search(config, { pattern: "heroAttack", type: "dsl", path: "SubDir" });
    // Should only find SubDir/Other.dsl.txt
    expect(result.lines.some((l) => l.includes("SubDir"))).to.be.true;
    // Should not include TestSheet.dsl.txt (top-level file)
    const hasTopLevel = result.lines.some(
      (l) => l.includes("eventSheets/TestSheet.dsl.txt") || l.match(/eventSheets\/TestSheet\.dsl\.txt/),
    );
    expect(hasTopLevel).to.be.false;
  });

  // ── 4. Context lines ───────────────────────────────────────────────────────

  it("context: 2 returns 2 lines before and after each match", () => {
    // "heroAttack" appears at line 8 in TestSheet.dsl.txt
    // context 2 should include lines 6-10
    const result = search(config, { pattern: "heroAttack", type: "dsl", path: "TestSheet", context: 2 });
    // Should include line before and after the match
    expect(result.lines.length).to.be.greaterThan(1);
    // Lines should include context lines (not just the match lines)
    const hasMatch = result.lines.some((l) => l.includes("heroAttack"));
    expect(hasMatch).to.be.true;
  });

  it("context lines include line numbers in output", () => {
    const result = search(config, { pattern: "heroAttack", type: "dsl", path: "TestSheet", context: 1 });
    // Each context line should have format "file:linenum: content"
    expect(result.lines.some((l) => /:\d+: /.test(l))).to.be.true;
  });

  // ── 5. Context merge ───────────────────────────────────────────────────────

  it("overlapping context windows merge into one block (no duplicate lines)", () => {
    // Search for "alpha" which appears multiple times close together in TestSheet.dsl.txt
    // Lines 4 and 18 both contain "alpha"
    const result = search(config, { pattern: "alpha", type: "dsl", path: "TestSheet", context: 2 });
    // Check no duplicate line numbers by looking at the file path prefix lines
    const lineNumbers = result.lines
      .filter((l) => l.includes("TestSheet.dsl.txt:"))
      .map((l) => {
        const m = l.match(/:(\d+): /);
        return m ? parseInt(m[1], 10) : -1;
      })
      .filter((n) => n >= 0);
    // No duplicates
    const unique = new Set(lineNumbers);
    expect(lineNumbers.length).to.equal(unique.size);
  });

  // ── 6. Context separator ───────────────────────────────────────────────────

  it("non-adjacent context groups are separated by '--'", () => {
    // "heroAttack" (line 8) and "heroDefend" (line 14) are far enough apart with context:1
    // that they form separate groups separated by "--"
    const result = search(config, { pattern: "hero(Attack|Defend)", type: "dsl", path: "TestSheet", context: 1 });
    expect(result.lines.includes("--")).to.be.true;
  });

  // ── 7. json type requires eventSheets/ or layouts/ prefix ─────────────────

  it("json type without eventSheets/ or layouts/ prefix throws an error", () => {
    expect(() => search(config, { pattern: "name", type: "json" })).to.throw(/path.*required/i);
    expect(() => search(config, { pattern: "name", type: "json", path: "TestSheet" })).to.throw(/eventSheets|layouts/i);
  });

  // ── 8. json type with valid prefix works ──────────────────────────────────

  it("json type with 'eventSheets/' prefix works and isExtracted is false", () => {
    const result = search(config, {
      pattern: "name",
      type: "json",
      path: "eventSheets/TestSheet",
    });
    expect(result.lines.length).to.be.greaterThan(0);
    expect(result.isExtracted).to.be.false;
  });

  it("json type with 'layouts/' prefix works and isExtracted is false", () => {
    const result = search(config, {
      pattern: "BattleScreen",
      type: "json",
      path: "layouts/TestLayout",
    });
    expect(result.lines.length).to.be.greaterThan(0);
    expect(result.isExtracted).to.be.false;
  });

  // ── 9. Path traversal prevention ──────────────────────────────────────────

  it("path containing '..' is rejected", () => {
    expect(() => search(config, { pattern: "test", path: "../../etc" })).to.throw(/traversal|invalid|path/i);
  });

  it("path with '..' in middle segment is rejected", () => {
    expect(() => search(config, { pattern: "test", path: "eventSheets/../../../etc" })).to.throw(
      /traversal|invalid|path/i,
    );
  });

  // ── 10. Pattern length cap ─────────────────────────────────────────────────

  it("pattern longer than maxPatternLength throws an error", () => {
    const longPattern = "a".repeat(501);
    expect(() => search(config, { pattern: longPattern })).to.throw(/pattern.*long|too long/i);
  });

  it("pattern at exactly maxPatternLength is accepted", () => {
    const exactPattern = "a".repeat(500);
    // Should not throw — may return 0 matches but no error
    expect(() => search(config, { pattern: exactPattern })).to.not.throw();
  });

  // ── 11. Match truncation ───────────────────────────────────────────────────

  it("truncates results when maxMatches is exceeded, sets truncated: true", () => {
    const smallConfig: SearchConfig = {
      ...config,
      maxMatches: 3,
    };
    // "line" appears many times across multiple fixture files
    const result = search(smallConfig, { pattern: "." }); // dot matches any char
    expect(result.truncated).to.be.true;
    expect(result.lines.length).to.be.at.most(3 + 5); // some tolerance for separator lines
  });

  it("does not truncate when matches are within limit", () => {
    const result = search(config, { pattern: "heroDefend", type: "dsl" });
    expect(result.truncated).to.be.false;
  });

  // ── 12. isExtracted flag ───────────────────────────────────────────────────

  it("isExtracted is true for dsl type", () => {
    const result = search(config, { pattern: "heroAttack", type: "dsl" });
    expect(result.isExtracted).to.be.true;
  });

  it("isExtracted is true for ts type", () => {
    const result = search(config, { pattern: "heroAttack", type: "ts" });
    expect(result.isExtracted).to.be.true;
  });

  it("isExtracted is false for json type", () => {
    const result = search(config, {
      pattern: "name",
      type: "json",
      path: "eventSheets/TestSheet",
    });
    expect(result.isExtracted).to.be.false;
  });
});

// ── #159: editor-local filtering + EISDIR guard ────────────────────────────
//
// The fixture-backed suite above never seeds an editor-local path (uistate/,
// *.uistate.json, ts-defs/) or a dangling/junction entry, so it can't exercise
// either gap. These use synthetic mkdtempSync temp dirs — the canonical
// fixture tracks zero editor-local files at every tag, so an assertion
// against it would pass vacuously.
describe("search — editor-local filtering and dangling entries (#159)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeProject(): { config: SearchConfig; projectRoot: string; extractedDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chef-search-159-"));
    tmpDirs.push(root);
    const projectRoot = path.join(root, "project");
    const extractedDir = path.join(root, "extracted");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(extractedDir, { recursive: true });
    return { config: { projectRoot, extractedDir }, projectRoot, extractedDir };
  }

  // ── Group A: editor-local filtering — currently absent, must FAIL ─────────

  it("filters a *.uistate.json sibling file out of a layouts/ json search", () => {
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    fs.mkdirSync(layoutsDir, { recursive: true });
    fs.writeFileSync(path.join(layoutsDir, "Main.json"), '{"needle": true}', "utf-8");
    fs.writeFileSync(path.join(layoutsDir, "Main.uistate.json"), '{"needle": true}', "utf-8");

    const result = search(config, { pattern: "needle", type: "json", path: "layouts/" });

    expect(result.lines.some((l) => l.includes("Main.uistate.json"))).to.be.false;
    // Positive control: proves the walk had the opportunity to find both files.
    expect(result.lines.some((l) => l.includes("layouts/Main.json"))).to.be.true;
  });

  it("filters files under a layouts/uistate/ directory out of a layouts/ json search", () => {
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    const uistateDir = path.join(layoutsDir, "uistate");
    fs.mkdirSync(uistateDir, { recursive: true });
    fs.writeFileSync(path.join(uistateDir, "Main.json"), '{"needle": true}', "utf-8");
    // Positive control, co-located at the top level.
    fs.writeFileSync(path.join(layoutsDir, "Main.json"), '{"needle": true}', "utf-8");

    const result = search(config, { pattern: "needle", type: "json", path: "layouts/" });

    expect(result.lines.some((l) => l.includes("uistate/Main.json"))).to.be.false;
    expect(result.lines.some((l) => l.includes("layouts/Main.json"))).to.be.true;
  });

  it("filters a *.uistate.json sibling file out of an eventSheets/ json search", () => {
    const { config, projectRoot } = makeProject();
    const sheetsDir = path.join(projectRoot, "eventSheets");
    fs.mkdirSync(sheetsDir, { recursive: true });
    fs.writeFileSync(path.join(sheetsDir, "Sheet.json"), '{"needle": true}', "utf-8");
    fs.writeFileSync(path.join(sheetsDir, "Sheet.uistate.json"), '{"needle": true}', "utf-8");

    const result = search(config, { pattern: "needle", type: "json", path: "eventSheets/" });

    expect(result.lines.some((l) => l.includes("Sheet.uistate.json"))).to.be.false;
    // Positive control: proves the walk had the opportunity to find both files.
    expect(result.lines.some((l) => l.includes("eventSheets/Sheet.json"))).to.be.true;
  });

  it("returns no results when path targets an editor-local directory directly", () => {
    // A walked-dir-anchored filter would still recurse into a directory that
    // IS the walk root; only a baseRoot-anchored check catches this.
    const { config, projectRoot } = makeProject();
    const uistateDir = path.join(projectRoot, "layouts", "uistate");
    fs.mkdirSync(uistateDir, { recursive: true });
    fs.writeFileSync(path.join(uistateDir, "Main.json"), '{"needle": true}', "utf-8");

    const result = search(config, { pattern: "needle", type: "json", path: "layouts/uistate" });

    expect(result.lines.length).to.equal(0);
  });

  it("filters an editor-local file addressed by exact stem, not just via a directory walk", () => {
    // The single-file branch bypasses walkFiles entirely, so the predicate has
    // to be applied there too. Otherwise the SAME file is excluded when reached
    // via `path: "layouts/"` but returned when named directly.
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    fs.mkdirSync(layoutsDir, { recursive: true });
    fs.writeFileSync(path.join(layoutsDir, "Main.json"), '{"needle": true}', "utf-8");
    fs.writeFileSync(path.join(layoutsDir, "Main.uistate.json"), '{"needle": true}', "utf-8");

    const editorLocal = search(config, { pattern: "needle", type: "json", path: "layouts/Main.uistate" });
    expect(editorLocal.lines.length).to.equal(0);

    // Positive control: the same exact-stem addressing still works for a real
    // project file, so the assertion above is not passing because the branch
    // is simply broken.
    const real = search(config, { pattern: "needle", type: "json", path: "layouts/Main" });
    expect(real.lines.some((l) => l.includes("layouts/Main.json"))).to.be.true;
  });

  // ⚠️ THE test that keeps `keep`'s statSync clause honest after the
  // @genvidtech/mcp-utils 0.6.0 bump. Upstream now guarantees walkFiles returns
  // only regular files, which makes the clause redundant for the four walk
  // sites — but the two SINGLE-FILE branches never call walkFiles, so it stays
  // load-bearing there. Verified 2026-08-10: with 0.6.0 installed, deleting the
  // clause leaves every other test in this file green while this one fails with
  // EISDIR. Without it, ADR 0020's "becomes redundant and should be dropped"
  // would ship a regression through a fully green gate.
  it("does not throw EISDIR when an exact stem names a .json-suffixed directory", () => {
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    fs.mkdirSync(layoutsDir, { recursive: true });
    fs.writeFileSync(path.join(layoutsDir, "Real.json"), '{"needle": true}', "utf-8");
    // A real DIRECTORY whose name ends .json. existsSync() reports true for it,
    // so the single-file branch reaches it without ever consulting walkFiles.
    fs.mkdirSync(path.join(layoutsDir, "DirNamed.json"));

    let result: SearchResult | undefined;
    expect(() => {
      result = search(config, { pattern: "needle", type: "json", path: "layouts/DirNamed" });
    }).to.not.throw();
    expect(result!.lines.length).to.equal(0);

    // Positive control: exact-stem addressing still resolves a real file, so
    // the assertion above is not passing because the branch is simply broken.
    const real = search(config, { pattern: "needle", type: "json", path: "layouts/Real" });
    expect(real.lines.some((l) => l.includes("layouts/Real.json"))).to.be.true;
  });

  it("filters a file inside an editor-local directory when addressed by exact stem", () => {
    // Consistency with the directory case above: `path: "layouts/uistate"`
    // reports empty, so `path: "layouts/uistate/Deep"` must not return the file
    // living inside it.
    const { config, projectRoot } = makeProject();
    const uistateDir = path.join(projectRoot, "layouts", "uistate");
    fs.mkdirSync(uistateDir, { recursive: true });
    fs.writeFileSync(path.join(uistateDir, "Deep.json"), '{"needle": true}', "utf-8");

    const result = search(config, { pattern: "needle", type: "json", path: "layouts/uistate/Deep" });

    expect(result.lines.length).to.equal(0);
  });

  // ── Group B: unreachable dimensions — these already PASS. They document ──
  // the prefix rule's blast radius (ts-defs/ and root-level tsconfig.json are
  // unaddressable by json search at all), not filtering behavior.

  it("[documents unreachability] json path 'scripts/' is rejected by the eventSheets/layouts prefix guard", () => {
    expect(() => search(config, { pattern: "test", type: "json", path: "scripts/" })).to.throw(/eventSheets|layouts/i);
  });

  it("[documents unreachability] json search with no path is rejected, so root-level files (e.g. tsconfig.json) are unaddressable", () => {
    expect(() => search(config, { pattern: "test", type: "json" })).to.throw(/path.*required/i);
  });

  // ── Group C: EISDIR / dangling-entry guard — currently absent, must FAIL ──

  it("does not throw EISDIR when a directory junction sits under layouts/", () => {
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    fs.mkdirSync(layoutsDir, { recursive: true });
    fs.writeFileSync(path.join(layoutsDir, "Real.json"), '{"needle": true}', "utf-8");

    const realTargetDir = path.join(projectRoot, "real-target-dir");
    fs.mkdirSync(realTargetDir, { recursive: true });
    fs.symlinkSync(realTargetDir, path.join(layoutsDir, "JunctionDir.json"), "junction");

    let result: SearchResult | undefined;
    expect(() => {
      result = search(config, { pattern: "needle", type: "json", path: "layouts/" });
    }).to.not.throw();

    expect(result!.lines.some((l) => l.includes("JunctionDir.json"))).to.be.false;
    expect(result!.lines.some((l) => l.includes("Real.json"))).to.be.true;
  });

  it("skips a dangling directory junction under layouts/ without throwing", function () {
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    fs.mkdirSync(layoutsDir, { recursive: true });
    fs.writeFileSync(path.join(layoutsDir, "Real.json"), '{"needle": true}', "utf-8");

    const realTargetDir = path.join(projectRoot, "real-target-dir");
    fs.mkdirSync(realTargetDir, { recursive: true });
    const brokenLink = path.join(layoutsDir, "Broken.json");
    try {
      fs.symlinkSync(realTargetDir, brokenLink, "junction");
    } catch {
      this.skip();
    }
    fs.rmSync(realTargetDir, { recursive: true, force: true }); // dangle the link

    let result: SearchResult | undefined;
    expect(() => {
      result = search(config, { pattern: "needle", type: "json", path: "layouts/" });
    }).to.not.throw();

    expect(result!.lines.some((l) => l.includes("Broken.json"))).to.be.false;
    expect(result!.lines.some((l) => l.includes("Real.json"))).to.be.true;
  });

  it("still finds a file symlink pointing at a real .json (no regression)", function () {
    const { config, projectRoot } = makeProject();
    const layoutsDir = path.join(projectRoot, "layouts");
    fs.mkdirSync(layoutsDir, { recursive: true });
    const realPath = path.join(layoutsDir, "Real.json");
    fs.writeFileSync(realPath, '{"needle": true}', "utf-8");
    const linkPath = path.join(layoutsDir, "Linked.json");
    // File-type symlinks require elevation/Developer Mode on Windows; skip
    // rather than fail when the test environment can't create one.
    try {
      fs.symlinkSync(realPath, linkPath, "file");
    } catch {
      this.skip();
    }

    const result = search(config, { pattern: "needle", type: "json", path: "layouts/" });

    expect(result.lines.some((l) => l.includes("Real.json"))).to.be.true;
    expect(result.lines.some((l) => l.includes("Linked.json"))).to.be.true;
  });

  // ── Group D: no-op regression — extracted/-rooted types are unaffected ────

  it("extracted/-rooted dsl search is unaffected (no-op regression)", () => {
    const { config, extractedDir } = makeProject();
    const sheetsDir = path.join(extractedDir, "eventSheets");
    fs.mkdirSync(sheetsDir, { recursive: true });
    fs.writeFileSync(path.join(sheetsDir, "X.dsl.txt"), "needle line\n", "utf-8");

    const result = search(config, { pattern: "needle", type: "dsl" });

    expect(result.lines.some((l) => l.includes("X.dsl.txt"))).to.be.true;
  });

  it("is immune to an editor-local segment in an ANCESTOR of the base root", () => {
    // Locks the claim ADR 0020 makes for anchoring at baseRoot rather than the
    // project root: relativizing against baseRoot strips every segment above
    // it, so a project that merely LIVES under a directory named `uistate` (or
    // an extractedDir under one named `ts-defs`) is not self-filtering. A
    // project-root-anchored check would be fine here too; a naive
    // classification of the absolute path would wrongly return nothing.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "search-ancestor-"));
    try {
      const projectRoot = path.join(base, "uistate", "myproject");
      const extractedDir = path.join(projectRoot, "ts-defs", "extracted");
      fs.mkdirSync(path.join(extractedDir, "eventSheets"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "layouts"), { recursive: true });
      fs.writeFileSync(path.join(extractedDir, "eventSheets", "X.dsl.txt"), "needle line\n", "utf-8");
      fs.writeFileSync(path.join(projectRoot, "layouts", "Main.json"), '{"needle": true}', "utf-8");

      const config: SearchConfig = { projectRoot, extractedDir, maxMatches: 1000, maxPatternLength: 500 };

      expect(search(config, { pattern: "needle", type: "dsl" }).lines.length).to.be.greaterThan(0);
      expect(search(config, { pattern: "needle", type: "json", path: "layouts/" }).lines.length).to.be.greaterThan(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
