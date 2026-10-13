import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GENERATORS } from "../../src/c3/generators.js";
import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
// Source dirs/files only: extracted/ is deliberately NOT copied (never mutate the golden fixture).
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"];

const noop = () => {};

/** Run every generator in the inventory into `outDir`. */
function runAllGenerators(root: string, outDir: string): void {
  for (const g of GENERATORS) g.run(root, outDir, noop);
}

/** Copy the fixture sources to a temp dir and generate a fresh `extracted/` there. */
function copyFixtureGenerated(): string {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c3chef-regenparity-"));
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(FIXTURE_ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(tmpRoot, entry), { recursive: true });
  }
  runAllGenerators(tmpRoot, path.join(tmpRoot, "extracted"));
  return tmpRoot;
}

/** Relative POSIX paths of every file under `dir` ([] if absent). */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Run every generator into a sibling directory and return the sorted relative POSIX paths whose bytes
 * differ from `<root>/extracted`, including files present on only one side.
 */
function diffAgainstFullRegen(root: string): string[] {
  const actualDir = path.join(root, "extracted");
  const fullDir = path.join(root, "__fullregen");
  try {
    runAllGenerators(root, fullDir);
    const names = new Set([...collectFiles(actualDir), ...collectFiles(fullDir)]);
    const differing: string[] = [];
    for (const rel of names) {
      const a = path.join(actualDir, rel);
      const b = path.join(fullDir, rel);
      if (!existsSync(a) || !existsSync(b) || !readFileSync(a).equals(readFileSync(b))) differing.push(rel);
    }
    return differing.sort();
  } finally {
    rmSync(fullDir, { recursive: true, force: true });
  }
}

/** Apply a recipe through the library with regeneration ON (the default) and a silent logger. */
function apply(root: string, recipe: Recipe): void {
  applyParsed(root, recipe, { log: noop });
}

describe("apply leaves extracted/ equal to a full regeneration (#256)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = copyFixtureGenerated();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("RG-M0: a fresh copy with no apply has no diff (comparator control)", () => {
    expect(diffAgainstFullRegen(tmp)).to.deep.equal([]);
  });

  it("RG-M1: overwriting template-scope.txt with sid-registry.txt is reported (comparator control)", () => {
    const dir = path.join(tmp, "extracted");
    writeFileSync(path.join(dir, "template-scope.txt"), readFileSync(path.join(dir, "sid-registry.txt")));
    expect(diffAgainstFullRegen(tmp)).to.deep.equal(["template-scope.txt"]);
  });

  it("RG-A: files-create with an event leaves extracted/ equal to a full regeneration", () => {
    apply(tmp, {
      files: { "eventSheets/Gameplay/RegenA.json": { create: true, events: [{ comment: "RG-A" }] } },
    } as Recipe);
    expect(diffAgainstFullRegen(tmp)).to.deep.equal([]);
  });

  it("RG-B: an addInstVars-only apply leaves extracted/ equal to a full regeneration", () => {
    apply(tmp, {
      addInstVars: [{ type: "Sprite3", instanceVariables: [{ name: "regenProbe", type: "number" }] }],
    } as Recipe);
    expect(diffAgainstFullRegen(tmp)).to.deep.equal([]);
  });

  it("RG-E: templatize-in-place on Sprite3 leaves extracted/ equal to a full regeneration", () => {
    apply(tmp, {
      layouts: {
        "layouts/Gameplay/Main Layout.json": [
          { op: "templatize-in-place", type: "Sprite3", templateName: "RegenTemplate" },
        ],
      },
    } as Recipe);
    expect(diffAgainstFullRegen(tmp)).to.deep.equal([]);
  });

  it("RG-F: remove-layer (cascade, removeInstances) of 'previously local' leaves extracted/ equal to a full regeneration", () => {
    apply(tmp, {
      layouts: {
        "layouts/Gameplay/Main Layout.json": [
          { op: "remove-layer", layer: "previously local", cascade: true, removeInstances: true },
        ],
      },
    } as Recipe);
    expect(diffAgainstFullRegen(tmp)).to.deep.equal([]);
  });
});
