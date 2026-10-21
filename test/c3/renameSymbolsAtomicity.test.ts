import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { renameSymbols } from "../../src/c3/recipeApplier.js";
import { copyFixture } from "../helpers/applyFixtures.js";
import { runCli } from "../helpers/runCli.js";

// These pin the pre-#283 success output of renameSymbols so the atomicity fix cannot drift it.
// "Scanning 3 eventSheet file(s)" is the canonical fixture's two sheets plus A_ok.json, so a fixture
// that gains or loses an event sheet moves that line.

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

describe("renameSymbols validates every sheet before the first write (#283)", () => {
  let tmp: string;
  let sheetA: string;
  let sheetB: string;
  const scriptEvent = {
    eventType: "block",
    conditions: [],
    actions: [{ type: "script", language: "typescript", script: ["zzProbe();"] }],
    sid: 100000000000001,
  };
  const BAD_LABEL = `Editor-validation failed for ${path.join("eventSheets", "B_bad.json")}:`;

  beforeEach(() => {
    tmp = copyFixture("c3chef-rename-validate-first-");
    sheetA = path.join(tmp, "eventSheets", "A_ok.json");
    sheetB = path.join(tmp, "eventSheets", "B_bad.json");
    writeFileSync(sheetA, JSON.stringify({ name: "A_ok", events: [scriptEvent], sid: 100000000000002 }, null, "\t"));
    // A variable event with no `comment` trips the eventvar-comment-required editor rule.
    const badVariable = {
      eventType: "variable",
      name: "v",
      type: "number",
      initialValue: "0",
      isStatic: false,
      isConstant: false,
      sid: 100000000000003,
    };
    const badEvent = { ...scriptEvent, sid: 100000000000004 };
    writeFileSync(
      sheetB,
      JSON.stringify({ name: "B_bad", events: [badVariable, badEvent], sid: 100000000000005 }, null, "\t"),
    );
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function attempt(dryRun: boolean, preview: boolean) {
    const aBefore = readFileSync(sheetA, "utf8");
    const bBefore = readFileSync(sheetB, "utf8");
    const lines: string[] = [];
    let message = "";
    try {
      renameSymbols(
        tmp,
        [{ from: "zzProbe", to: "zzRenamed" }],
        dryRun,
        preview,
        false,
        "extracted",
        (...a: unknown[]) => lines.push(a.join(" ")),
      );
    } catch (e) {
      message = (e as Error).message;
    }
    return {
      firstLine: message.split("\n")[0],
      aUnchanged: readFileSync(sheetA, "utf8") === aBefore,
      bUnchanged: readFileSync(sheetB, "utf8") === bBefore,
      lines,
    };
  }

  it("RN1: apply refuses with the relative sheet path and writes nothing", () => {
    const r = attempt(false, false);
    assert.deepEqual(
      { firstLine: r.firstLine, aUnchanged: r.aUnchanged, bUnchanged: r.bUnchanged },
      { firstLine: BAD_LABEL, aUnchanged: true, bUnchanged: true },
    );
  });

  it("RN2: --dry-run refuses like apply and never reports completion", () => {
    const r = attempt(true, false);
    assert.deepEqual(
      {
        firstLine: r.firstLine,
        aUnchanged: r.aUnchanged,
        bUnchanged: r.bUnchanged,
        dryRunLogged: r.lines.some((l) => l.includes("Dry run complete")),
      },
      { firstLine: BAD_LABEL, aUnchanged: true, bUnchanged: true, dryRunLogged: false },
    );
  });

  it("RN3: --preview refuses before printing any diff", () => {
    const r = attempt(false, true);
    assert.deepEqual(
      {
        firstLine: r.firstLine,
        headerLogged: r.lines.some((l) => l.includes("--- Preview (script diffs) ---")),
      },
      { firstLine: BAD_LABEL, headerLogged: false },
    );
  });

  it("RN6: the CLI --dry-run exits 1 with the editor-validation message", function () {
    this.timeout(120000);
    const r = runCli(["rename-symbol", "zzProbe", "zzRenamed", "--dry-run", "--project-dir", tmp]);
    assert.deepEqual(
      { exitCode: r.exitCode, named: (r.stdout + r.stderr).includes(BAD_LABEL) },
      { exitCode: 1, named: true },
    );
  });
});
