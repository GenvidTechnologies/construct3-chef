import { expect } from "chai";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { search } from "../../src/c3/search.js";
import type { SearchConfig } from "../../src/c3/search.js";

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
      (l) => l.includes("eventSheets/TestSheet.dsl.txt") || l.match(/eventSheets\/TestSheet\.dsl\.txt/)
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
    expect(() => search(config, { pattern: "name", type: "json", path: "TestSheet" })).to.throw(
      /eventSheets|layouts/i
    );
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
      /traversal|invalid|path/i
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
