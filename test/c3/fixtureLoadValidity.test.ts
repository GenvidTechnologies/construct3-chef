import { describe, it } from "mocha";
import { assert } from "chai";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { find_all_eventsheets_path, validateForEditor } from "@genvidtech/c3source";
import type { EventSheet } from "@genvidtech/c3source";

/**
 * Validates that every fixture event sheet in test/fixtures/ is editor-valid
 * (i.e. passes the same checks the C3 editor runs on import). This guards
 * against hand-authored fixtures that pass the golden/extraction tests but
 * would fail to load in the actual C3 editor with "expected string" errors.
 *
 * Closes #61. Unblocked by c3source 1.4.0's validateForEditor.
 */

const FIXTURES_ROOT = path.resolve("test/fixtures");

/**
 * Walk `dir` recursively and collect all subdirectories named `eventSheets`
 * that are NOT inside an `extracted/` parent segment. This intentionally
 * excludes the generated read-surface directories (extracted/eventSheets/)
 * which contain .dsl.txt files rather than source JSON.
 */
function findEventSheetDirs(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string, insideExtracted: boolean): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const isExtracted = entry === "extracted";
      if (insideExtracted) {
        // Don't descend into extracted/ subtrees at all — they hold generated
        // read-surface files, not source JSON event sheets.
        continue;
      }
      if (entry === "eventSheets") {
        results.push(full);
        // Don't recurse further into eventSheets/ — the source JSON files live
        // at the top level of each eventSheets/ dir (or in subfolders), and
        // find_all_eventsheets_path handles the internal walk.
      } else {
        walk(full, isExtracted);
      }
    }
  }

  walk(dir, false);
  return results;
}

const eventSheetDirs = findEventSheetDirs(FIXTURES_ROOT);

// Collect all (dir, sheetPath) pairs so per-sheet `it`s can be generated.
const allSheets: Array<{ sheetPath: string; relPath: string }> = [];
for (const dir of eventSheetDirs) {
  const sheets = find_all_eventsheets_path(dir);
  for (const sheetPath of sheets) {
    const relPath = path.relative(FIXTURES_ROOT, sheetPath).replace(/\\/g, "/");
    allSheets.push({ sheetPath, relPath });
  }
}

describe("fixture event sheets are C3-editor-valid", () => {
  it("discovers at least one event sheet under test/fixtures/", () => {
    assert.isAbove(
      allSheets.length,
      0,
      `Expected to find at least one event sheet under ${FIXTURES_ROOT}. ` +
        `eventSheetDirs found: ${JSON.stringify(eventSheetDirs)}`,
    );
  });

  for (const { sheetPath, relPath } of allSheets) {
    it(`${relPath} is C3-editor-valid`, () => {
      const sheet = JSON.parse(readFileSync(sheetPath, "utf-8")) as EventSheet;
      const issues = validateForEditor(sheet);
      assert.deepEqual(
        issues,
        [],
        `${relPath} is not C3-editor-valid:\n` + issues.map((i) => `  ${i.path} [${i.rule}]: ${i.message}`).join("\n"),
      );
    });
  }
});
