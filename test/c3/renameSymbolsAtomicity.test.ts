import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { renameSymbols } from "../../src/c3/recipeApplier.js";
import { copyFixture } from "../helpers/applyFixtures.js";

// These pin the pre-#283 success output of renameSymbols so the atomicity fix cannot drift it.

const SHEET_REL = path.join("eventSheets", "A_ok.json");

function run(root: string, dryRun: boolean, preview: boolean): string[] {
  const lines: string[] = [];
  renameSymbols(root, [{ from: "zzProbe", to: "zzRenamed" }], dryRun, preview, false, "extracted", (...a: unknown[]) =>
    lines.push(a.join(" ")),
  );
  return lines;
}

describe("renameSymbols success output pins (#283)", () => {
  let tmp: string;
  let sheet: string;
  beforeEach(() => {
    tmp = copyFixture("c3chef-rename-atomicity-");
    sheet = path.join(tmp, "eventSheets", "A_ok.json");
    const doc = {
      name: "A_ok",
      events: [
        {
          eventType: "block",
          conditions: [],
          actions: [{ type: "script", language: "typescript", script: ["zzProbe();"] }],
          sid: 100000000000001,
        },
      ],
      sid: 100000000000002,
    };
    writeFileSync(sheet, JSON.stringify(doc, null, "\t"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("RN4: a valid rename logs the same lines in apply mode", () => {
    const lines = run(tmp, false, false);
    assert.deepEqual(lines, [
      "Replacements (1):",
      '  "zzProbe" → "zzRenamed"',
      "\nScanning 3 eventSheet file(s)...\n",
      "Found 1 modified script action(s) across 1 file(s):",
      `  ${SHEET_REL} (1 action(s))`,
      `  MODIFIED ${SHEET_REL}`,
      "\nDone. 1 file(s) modified, 1 script action(s) updated.",
    ]);
    assert.include(readFileSync(sheet, "utf8"), "zzRenamed");
  });

  it("RN4: a valid rename logs the same lines in dry-run mode", () => {
    assert.deepEqual(run(tmp, true, false), [
      "Replacements (1):",
      '  "zzProbe" → "zzRenamed"',
      "\nScanning 3 eventSheet file(s)...\n",
      "Found 1 modified script action(s) across 1 file(s):",
      `  ${SHEET_REL} (1 action(s))`,
      "\nDry run complete. Run without --dry-run to apply.",
    ]);
  });

  it("RN4: a valid rename logs the same lines in preview mode", () => {
    assert.deepEqual(run(tmp, false, true), [
      "Replacements (1):",
      '  "zzProbe" → "zzRenamed"',
      "\nScanning 3 eventSheet file(s)...\n",
      "Found 1 modified script action(s) across 1 file(s):",
      `  ${SHEET_REL} (1 action(s))`,
      "\n--- Preview (script diffs) ---\n",
      `  ${SHEET_REL}:`,
      "    events[0] action[0]:",
      "      - zzProbe();",
      "      + zzRenamed();",
      "\nDry run complete. Run without --dry-run to apply.",
    ]);
  });
});
