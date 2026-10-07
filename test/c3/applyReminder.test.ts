import { describe, it, before, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";

// #245: the post-apply "run sync-project" reminder must print only when the apply
// created a NEW file that sync-project would register (a new objectType, or a
// files CREATE at a path that did not exist before).

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"];
const REMINDER = "Reminder: run sync-project";

const EXISTING_SHEET = "eventSheets/Gameplay/Event sheet 1.json";

function copyFixture(): string {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c3chef-reminder-"));
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(FIXTURE_ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(tmpRoot, entry), { recursive: true });
  }
  // extracted/ carries sid-registry.txt, which applyParsed seeds its SID generator from.
  const extracted = path.join(FIXTURE_ROOT, "extracted");
  if (existsSync(extracted)) cpSync(extracted, path.join(tmpRoot, "extracted"), { recursive: true });
  return tmpRoot;
}

describe("apply reminder only when a new file is created (#245)", () => {
  let tmp: string;
  let lines: string[];

  before(function () {
    expect(existsSync(FIXTURE_ROOT), "fixture must be materialized (npm run fixture:prep)").to.be.true;
  });

  beforeEach(() => {
    tmp = copyFixture();
    lines = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function apply(recipe: Recipe): string {
    applyParsed(tmp, recipe, { regenerate: false, log: (m: string) => lines.push(m) });
    return lines.join("\n");
  }

  it("R1: addInstVars-only recipe prints no reminder", () => {
    const out = apply({
      addInstVars: [{ type: "Text", instanceVariables: [{ name: "reminderTest", type: "number" }] }],
    });
    expect(out).to.not.include(REMINDER);
  });

  it("R1: files ops-array-only recipe prints no reminder", () => {
    const out = apply({
      files: { [EXISTING_SHEET]: [{ op: "insert-event", index: -1, comment: "reminder test" }] },
    });
    expect(out).to.not.include(REMINDER);
  });

  it("R1: layout-ops-only recipe prints no reminder", () => {
    const out = apply({
      layouts: { "layouts/Gameplay/Main Layout.json": [{ op: "add-layer", name: "ReminderLayer" }] },
    });
    expect(out).to.not.include(REMINDER);
  });

  it("R3: a brand-new objectType prints the reminder", () => {
    expect(existsSync(path.join(tmp, "objectTypes", "ReminderJson.json"))).to.be.false;
    const out = apply({ objectTypes: [{ name: "ReminderJson", plugin: "Json" }] });
    expect(existsSync(path.join(tmp, "objectTypes", "ReminderJson.json"))).to.be.true;
    expect(out).to.include(REMINDER);
  });

  it("R4: files CREATE at a new event sheet path prints the reminder", () => {
    const rel = "eventSheets/Gameplay/ReminderNew.json";
    expect(existsSync(path.join(tmp, rel))).to.be.false;
    const out = apply({ files: { [rel]: { create: true, events: [] } } });
    expect(existsSync(path.join(tmp, rel))).to.be.true;
    expect(out).to.include(REMINDER);
  });

  it("R5: an objectType entry for an already-existing type (SKIP) prints no reminder", () => {
    expect(existsSync(path.join(tmp, "objectTypes", "Text.json"))).to.be.true;
    const out = apply({ objectTypes: [{ name: "Text", plugin: "Json" }] });
    expect(out).to.not.include(REMINDER);
  });

  it("R10: files CREATE at an already-existing sheet path prints no reminder", () => {
    expect(existsSync(path.join(tmp, EXISTING_SHEET))).to.be.true;
    const out = apply({ files: { [EXISTING_SHEET]: { create: true, events: [] } } });
    expect(out).to.not.include(REMINDER);
  });
});
