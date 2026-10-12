import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";

// #253: a recipe path must use the on-disk spelling. The disk-aware check (checkKeySpelling) refuses a key that
// matches an existing file or folder only when letter case is ignored.
//
// HOST INDEPENDENCE: the project dir is a real temp dir with real, exact-case names. Every assertion is on the
// refusal text or on an exact-name readdirSync listing (readdirSync returns the on-disk spelling; existsSync folds
// case on Windows/macOS and would not), never on "the file was edited", which differs between a case-insensitive
// and a case-sensitive host. So each row holds on Windows, macOS and Linux alike once the check is wired.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj", "extracted"];

const REFUSAL =
  "recipe path refused: 1 path(s) match an existing file or folder only when letter case is ignored, and a recipe " +
  "path must use the on-disk spelling so it behaves the same on every filesystem. Nothing was written.";

const SHEET_REL = "eventSheets/Gameplay/Event sheet 1.json";
const LAYOUT_REL = "layouts/Gameplay/Main Layout.json";

/** Synthetic temp copy of the fixture; realpath'd because os.tmpdir() is an 8.3 short path on Windows. */
function copyFixture(): string {
  const tmpRoot = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-key-spelling-"));
  for (const entry of SOURCE_ENTRIES) {
    const src = path.join(FIXTURE_ROOT, entry);
    if (existsSync(src)) cpSync(src, path.join(tmpRoot, entry), { recursive: true });
  }
  return tmpRoot;
}

/** Every file under `dir` (recursive) -> bytes, keyed by POSIX path relative to `dir`. */
function snapshotTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(path.relative(dir, full).split(path.sep).join("/"), readFileSync(full));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function assertTreeUnchanged(dir: string, before: Map<string, Buffer>, label: string): void {
  const after = snapshotTree(dir);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: file set unchanged`);
  for (const [rel, bytes] of before) assert.isTrue(after.get(rel)!.equals(bytes), `${label}/${rel} bytes unchanged`);
}

function caught(fn: () => void): Error | undefined {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

const apply = (root: string, recipe: Recipe, regenerate = false): Error | undefined =>
  caught(() => applyParsed(root, recipe, { regenerate, log: () => {} }));

describe("case-only key-spelling refusal (#253)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = copyFixture();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("KS6: an ops-array files key in the wrong case is refused naming the on-disk spelling; sheet unchanged", () => {
    const before = readFileSync(path.join(tmp, SHEET_REL));
    const err = apply(tmp, {
      files: { "gameplay/EVENT SHEET 1": [{ op: "insert-event", comment: "MISCASED" }] },
    });
    assert.instanceOf(err, Error, "apply must throw");
    assert.include(err!.message, REFUSAL);
    assert.include(err!.message, `→ on disk: ${SHEET_REL}`);
    assert.isTrue(readFileSync(path.join(tmp, SHEET_REL)).equals(before), "sheet bytes unchanged");
  });

  it("KS7: a layout key in the wrong case is refused naming the on-disk spelling; layout unchanged", () => {
    const before = readFileSync(path.join(tmp, LAYOUT_REL));
    const err = apply(tmp, { layouts: { "gameplay/main layout": [{ op: "add-layer", name: "MISCASED" }] } });
    assert.instanceOf(err, Error, "apply must throw");
    assert.include(err!.message, REFUSAL);
    assert.include(err!.message, `→ on disk: ${LAYOUT_REL}`);
    assert.isTrue(readFileSync(path.join(tmp, LAYOUT_REL)).equals(before), "layout bytes unchanged");
  });

  it("KS8: a CREATE over an existing sheet under another case is the #249 refusal, naming the on-disk file", () => {
    const before = readFileSync(path.join(tmp, SHEET_REL));
    const err = apply(tmp, { files: { "gameplay/EVENT SHEET 1": { create: true, events: [] } } });
    assert.instanceOf(err, Error, "apply must throw");
    assert.include(err!.message, "files CREATE refused");
    // Today's guard (existsSync) may refuse on a case-insensitive host, but never says which spelling is on disk.
    assert.include(err!.message, `(on disk: ${SHEET_REL})`);
    assert.isTrue(readFileSync(path.join(tmp, SHEET_REL)).equals(before), "sheet bytes unchanged");
  });

  it("KS9: a CREATE whose folder differs only in case is refused; no new folder or file appears", () => {
    const sheetsBefore = readdirSync(path.join(tmp, "eventSheets")).sort();
    const gameplayBefore = readdirSync(path.join(tmp, "eventSheets", "Gameplay")).sort();
    const err = apply(tmp, { files: { "gameplay/New Sheet": { create: true, events: [] } } });
    assert.instanceOf(err, Error, "apply must throw");
    assert.include(err!.message, REFUSAL);
    // Exact-name listings: no `gameplay` directory was made, and `New Sheet.json` is nowhere.
    assert.deepEqual(readdirSync(path.join(tmp, "eventSheets")).sort(), sheetsBefore);
    assert.deepEqual(readdirSync(path.join(tmp, "eventSheets", "Gameplay")).sort(), gameplayBefore);
    assert.notInclude(readdirSync(path.join(tmp, "eventSheets", "Gameplay")), "New Sheet.json");
  });

  it("KS10: objectTypes + layouts + a miscased files key throws and writes nothing", () => {
    const layoutBefore = readFileSync(path.join(tmp, LAYOUT_REL));
    const sheetBefore = readFileSync(path.join(tmp, SHEET_REL));
    const extractedBefore = snapshotTree(path.join(tmp, "extracted"));
    assert.isAbove(extractedBefore.size, 0, "fixture extracted/ must be present");
    const objectTypesBefore = readdirSync(path.join(tmp, "objectTypes")).sort();

    const err = apply(
      tmp,
      {
        objectTypes: [{ name: "KeySpellingJson", plugin: "Json" }],
        layouts: { [LAYOUT_REL]: [{ op: "add-layer", name: "KeySpellingLayer" }] },
        files: { "gameplay/EVENT SHEET 1": [{ op: "insert-event", comment: "MISCASED" }] },
      },
      true,
    );

    assert.instanceOf(err, Error, "apply must throw");
    assert.include(err!.message, REFUSAL);
    assert.deepEqual(readdirSync(path.join(tmp, "objectTypes")).sort(), objectTypesBefore, "no objectType written");
    assert.isTrue(readFileSync(path.join(tmp, LAYOUT_REL)).equals(layoutBefore), "layout bytes unchanged");
    assert.isTrue(readFileSync(path.join(tmp, SHEET_REL)).equals(sheetBefore), "sheet bytes unchanged");
    assertTreeUnchanged(path.join(tmp, "extracted"), extractedBefore, "extracted");
  });

  it("KS12: a miscased templatesLayout in replace-instance-with-replica is the refusal, not a raw ENOENT", () => {
    const layoutBefore = readFileSync(path.join(tmp, LAYOUT_REL));
    const err = apply(tmp, {
      layouts: {
        [LAYOUT_REL]: [
          {
            op: "replace-instance-with-replica",
            type: "Sprite3",
            templatesLayout: "templates layout",
            templateName: "default",
          },
        ],
      },
    } as unknown as Recipe);
    assert.instanceOf(err, Error, "apply must throw");
    assert.notMatch(err!.message, /ENOENT/, "must not surface a raw ENOENT");
    assert.include(err!.message, REFUSAL);
    assert.include(err!.message, "→ on disk: layouts/Templates Layout.json");
    assert.isTrue(readFileSync(path.join(tmp, LAYOUT_REL)).equals(layoutBefore), "layout bytes unchanged");
  });
});
