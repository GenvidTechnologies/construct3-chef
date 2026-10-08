import { describe, it, before, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed, applyRecipeInner } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { freshSidGen } from "../../src/c3/sidUtils.js";

// #249: a files CREATE ({ create: true }) must refuse an already-existing target. The
// refusal runs before any dry-run output or write, so apply, --dry-run and --preview
// all report the same error and nothing from Steps 1-2 (objectTypes/layouts) lands.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"];

const EXISTING = "eventSheets/Gameplay/Event sheet 1.json";
const EXISTING_2 = "eventSheets/UI/Event sheet 2.json";

function copyFixture(): string {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c3chef-create-guard-"));
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(FIXTURE_ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(tmpRoot, entry), { recursive: true });
  }
  // extracted/ carries sid-registry.txt, which applyParsed seeds its SID generator from.
  const extracted = path.join(FIXTURE_ROOT, "extracted");
  if (existsSync(extracted)) cpSync(extracted, path.join(tmpRoot, "extracted"), { recursive: true });
  return tmpRoot;
}

/** Read each path (relative to root) to a Buffer; a missing file is null so "absent" is assertable. */
function snapshot(root: string, rels: string[]): Map<string, Buffer | null> {
  const snap = new Map<string, Buffer | null>();
  for (const rel of rels) {
    const full = path.join(root, rel);
    snap.set(rel, existsSync(full) ? readFileSync(full) : null);
  }
  return snap;
}

function expectSameBytes(root: string, before: Map<string, Buffer | null>): void {
  for (const [rel, bytes] of before) {
    const now = snapshot(root, [rel]).get(rel) ?? null;
    if (bytes === null) {
      expect(now, `${rel} must still be absent`).to.equal(null);
    } else {
      expect(now, `${rel} must still exist`).to.not.equal(null);
      expect(now!.equals(bytes), `${rel} bytes must be unchanged`).to.be.true;
    }
  }
}

/** Run fn and return what it threw (undefined if it returned normally). */
function caught(fn: () => void): Error | undefined {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

const createExisting = (): Recipe => ({ files: { [EXISTING]: { create: true, events: [] } } });

describe("files CREATE refuses an existing target (#249)", () => {
  let tmp: string;
  let lines: string[];
  const log = (m: string) => lines.push(m);

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

  it("R1: apply refuses a CREATE over an existing sheet, naming the path and the ops array", () => {
    expect(existsSync(path.join(tmp, EXISTING))).to.be.true;
    const before = snapshot(tmp, [EXISTING]);

    const err = caught(() => applyParsed(tmp, createExisting(), { regenerate: false, log }));

    expect(err, "apply must throw").to.be.instanceOf(Error);
    expect(err!.message).to.match(/already exist on disk/);
    expect(err!.message).to.include(EXISTING);
    expect(err!.message).to.match(/ops array/);
    expectSameBytes(tmp, before);
  });

  it("R2: the refusal comes before any objectType or layout write", () => {
    const touched = [
      EXISTING,
      "objectTypes/GuardJson.json",
      "layouts/Gameplay/Main Layout.json",
      "scripts/ts-defs/instanceTypes.d.ts",
      "scripts/ts-defs/objects.d.ts",
    ];
    expect(existsSync(path.join(tmp, "layouts/Gameplay/Main Layout.json"))).to.be.true;
    expect(existsSync(path.join(tmp, "scripts/ts-defs/instanceTypes.d.ts"))).to.be.true;
    expect(existsSync(path.join(tmp, "scripts/ts-defs/objects.d.ts"))).to.be.true;
    const before = snapshot(tmp, touched);
    expect(before.get("objectTypes/GuardJson.json")).to.equal(null);

    const recipe: Recipe = {
      objectTypes: [{ name: "GuardJson", plugin: "Json" }],
      layouts: { "layouts/Gameplay/Main Layout.json": [{ op: "add-layer", name: "GuardLayer" }] },
      files: { [EXISTING]: { create: true, events: [] } },
    };
    const err = caught(() => applyParsed(tmp, recipe, { regenerate: false, log }));

    // Half 1: the recipe was refused (and not for a recipe-validation reason).
    expect(err, "apply must throw").to.be.instanceOf(Error);
    expect(err!.message).to.match(/already exist on disk/);
    // Half 2: nothing from Steps 1-2 landed.
    expect(existsSync(path.join(tmp, "objectTypes/GuardJson.json")), "GuardJson objectType must not be written").to.be
      .false;
    expectSameBytes(tmp, before);
  });

  it("R3: dry-run refuses with the same message as apply, before any dry-run output", () => {
    const applyErr = caught(() => applyParsed(tmp, createExisting(), { regenerate: false, log }));
    expect(applyErr, "apply must throw").to.be.instanceOf(Error);
    lines = [];

    const dryErr = caught(() =>
      applyRecipeInner(freshSidGen(), tmp, createExisting(), { dryRun: true, regenerate: false, log }),
    );

    expect(dryErr, "dry-run must throw").to.be.instanceOf(Error);
    expect(dryErr!.message).to.equal(applyErr!.message);
    expect(lines.join("\n")).to.not.include("--- Dry run");
  });

  it("R4: --preview refuses and prints no new-file preview", () => {
    const err = caught(() =>
      applyRecipeInner(freshSidGen(), tmp, createExisting(), { dryRun: true, preview: true, regenerate: false, log }),
    );

    expect(err, "preview must throw").to.be.instanceOf(Error);
    expect(lines.join("\n")).to.not.include("new file with");
  });

  it("R5: every offending path is reported, a bare key is resolved, a new path is not listed", () => {
    const newRel = "eventSheets/Gameplay/GuardNew.json";
    const recipe: Recipe = {
      files: {
        [EXISTING]: { create: true, events: [] },
        "UI/Event sheet 2": { create: true, events: [] },
        [newRel]: { create: true, events: [] },
      },
    };

    const err = caught(() => applyParsed(tmp, recipe, { regenerate: false, log }));

    expect(err, "apply must throw").to.be.instanceOf(Error);
    expect(err!.message).to.include(EXISTING);
    expect(err!.message).to.include(EXISTING_2);
    expect(err!.message).to.include("2 target(s)");
    expect(err!.message).to.not.include("GuardNew");
    expect(existsSync(path.join(tmp, newRel)), "GuardNew.json must not be written").to.be.false;
  });
});
