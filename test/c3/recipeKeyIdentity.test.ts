import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import { normalizeRecipePaths, validateRecipe, type Recipe } from "../../src/c3/recipeInterpreter.js";
import { keyIssue } from "../../src/c3/recipeKeys.js";

// #252/#253/#273: recipe keys have one canonical, case-insensitive identity. Two keys that name the same file are a
// validateRecipe error (not a silent last-one-wins), and a key that escapes the project root is refused.
// Message texts are the approved design's (design-252-253.md "Group message"); recipes are the designer's probes.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj", "extracted"];

/** Synthetic temp copy of the fixture; realpath'd because os.tmpdir() is an 8.3 short path on Windows. */
function copyFixture(): string {
  const tmpRoot = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-key-identity-"));
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

function caught(fn: () => void): Error | undefined {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  return undefined;
}

const ins = (comment: string) => [{ op: "insert-event" as const, comment }];
const addLayer = (name: string) => [{ op: "add-layer" as const, name }];

/** r1: one sheet under two spellings. */
const r1 = (): Recipe => ({
  files: { "Gameplay/Event sheet 1": ins("FIRST-SPELLING"), "eventSheets/Gameplay/Event sheet 1.json": ins("SECOND") },
});

const R1_LINE =
  'files: 2 keys name the same event sheet eventSheets/Gameplay/Event sheet 1.json — "Gameplay/Event sheet 1", ' +
  '"eventSheets/Gameplay/Event sheet 1.json". Merge their entries under one key.';

describe("recipe key identity (#252/#253/#273)", () => {
  it("KI1: two spellings of one files key are exactly one validateRecipe error naming both", () => {
    const errors = validateRecipe(r1());
    assert.lengthOf(errors, 1, errors.join("\n"));
    assert.include(errors[0], "name the same event sheet");
    assert.include(errors[0], '"Gameplay/Event sheet 1"');
    assert.include(errors[0], '"eventSheets/Gameplay/Event sheet 1.json"');
    assert.include(errors[0], "Merge their entries under one key");
    assert.equal(errors[0], R1_LINE);
  });

  it("KI2: two spellings of one layouts key are exactly one error naming both", () => {
    const errors = validateRecipe({
      layouts: { "Gameplay/Main Layout": addLayer("FIRST_LAYER"), "layouts/Gameplay/Main Layout.json": addLayer("S") },
    });
    assert.lengthOf(errors, 1, errors.join("\n"));
    assert.include(errors[0], "name the same layout");
    assert.include(errors[0], '"Gameplay/Main Layout"');
    assert.include(errors[0], '"layouts/Gameplay/Main Layout.json"');
  });

  it("KI3: a case-variant double CREATE is one error that says letter case is ignored", () => {
    const errors = validateRecipe({
      files: {
        "eventSheets/Foo.json": { create: true, events: [{ comment: "UPPER-FOO" }] },
        "eventSheets/foo.json": { create: true, events: [{ comment: "LOWER-FOO" }] },
      },
    });
    assert.lengthOf(errors, 1, errors.join("\n"));
    assert.include(errors[0], "name the same event sheet");
    assert.include(errors[0], "(letter case is ignored)");
    assert.include(errors[0], '"eventSheets/Foo.json"');
    assert.include(errors[0], '"eventSheets/foo.json"');
  });

  it("KI4: `New/Bar` and `./New/Bar` CREATEs are one error", () => {
    const errors = validateRecipe({
      files: {
        "New/Bar": { create: true, events: [{ comment: "PLAIN" }] },
        "./New/Bar": { create: true, events: [{ comment: "DOTTED" }] },
      },
    });
    assert.lengthOf(errors, 1, errors.join("\n"));
    assert.include(errors[0], "name the same event sheet");
    assert.include(errors[0], '"New/Bar"');
    assert.include(errors[0], '"./New/Bar"');
  });

  it("KI5: an ops array plus a CREATE for the same sheet is one error", () => {
    const errors = validateRecipe({
      files: {
        "eventSheets/New/Sheet.json": ins("OPS-ON-NEW"),
        "New/Sheet": { create: true, events: [{ comment: "CREATED" }] },
      },
    });
    assert.lengthOf(errors, 1, errors.join("\n"));
    assert.include(errors[0], "name the same event sheet");
    assert.include(errors[0], '"eventSheets/New/Sheet.json"');
    assert.include(errors[0], '"New/Sheet"');
  });

  it("KI6: two ops keys that differ only in letter case are one case-group error", () => {
    const errors = validateRecipe({
      files: { "Gameplay/Event sheet 1": ins("MIXED-A"), "gameplay/event sheet 1": ins("MIXED-B") },
    });
    assert.lengthOf(errors, 1, errors.join("\n"));
    assert.include(errors[0], "name the same event sheet");
    assert.include(errors[0], "(letter case is ignored)");
    assert.include(errors[0], '"Gameplay/Event sheet 1"');
    assert.include(errors[0], '"gameplay/event sheet 1"');
  });

  it("KI7: two independent collision groups are two errors, one per group", () => {
    const errors = validateRecipe({
      files: { ...r1().files },
      layouts: { "Gameplay/Main Layout": addLayer("A"), "layouts/Gameplay/Main Layout.json": addLayer("B") },
    });
    assert.lengthOf(errors, 2, errors.join("\n"));
    assert.isTrue(errors.some((e) => e.includes("name the same event sheet")));
    assert.isTrue(errors.some((e) => e.includes("name the same layout")));
  });

  describe("apply", () => {
    let tmp: string;
    beforeEach(() => {
      tmp = copyFixture();
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("KI8: a colliding recipe with objectTypes + layouts + regenerate writes nothing", () => {
      const layoutRel = "layouts/Gameplay/Main Layout.json";
      const layoutBefore = readFileSync(path.join(tmp, layoutRel));
      const extractedBefore = snapshotTree(path.join(tmp, "extracted"));
      assert.isAbove(extractedBefore.size, 0, "fixture extracted/ must be present");
      const recipe: Recipe = {
        objectTypes: [{ name: "KeyIdJson", plugin: "Json" }],
        layouts: { [layoutRel]: addLayer("KeyIdLayer") },
        files: r1().files,
      };

      const err = caught(() => applyParsed(tmp, recipe, { regenerate: true, log: () => {} }));

      // Half 1: refused for the collision (not for some other reason).
      assert.instanceOf(err, Error, "apply must throw");
      assert.include(err!.message, R1_LINE);
      // Half 2: nothing from Steps 1-2 or regeneration landed.
      assert.isFalse(existsSync(path.join(tmp, "objectTypes", "KeyIdJson.json")), "objectType must not be written");
      assert.isTrue(readFileSync(path.join(tmp, layoutRel)).equals(layoutBefore), "layout bytes unchanged");
      const extractedAfter = snapshotTree(path.join(tmp, "extracted"));
      assert.deepEqual([...extractedAfter.keys()], [...extractedBefore.keys()], "extracted/ file set unchanged");
      for (const [rel, bytes] of extractedBefore) {
        assert.isTrue(extractedAfter.get(rel)!.equals(bytes), `extracted/${rel} bytes unchanged`);
      }
    });

    it("KI14: a '..' CREATE key is refused and nothing is written outside the project root", () => {
      const escaped = path.join(tmp, "..", "escape-probe.json");
      try {
        assert.isFalse(existsSync(escaped), "precondition: no stray file");
        const err = caught(() =>
          applyParsed(
            tmp,
            { files: { "../../escape-probe": { create: true, events: [{ comment: "ESCAPE" }] } } },
            { regenerate: false, log: () => {} },
          ),
        );
        assert.instanceOf(err, Error, "apply must throw");
        assert.include(err!.message, '"../../escape-probe"');
        assert.isFalse(existsSync(escaped), "escape-probe.json must not be written outside the root");
      } finally {
        rmSync(escaped, { force: true });
      }
    });
  });

  it("KI15: invalid keys name the original key; (b) a non-object files / non-array layouts value reports the guard", () => {
    const badKeys = ["../x", "a/../b", "/abs/path", "C:/x", "C:\\x", ""];
    for (const key of badKeys) {
      const fileErrors = validateRecipe({ files: { [key]: ins("c") } });
      assert.isTrue(
        fileErrors.some((e) => e.includes(JSON.stringify(key)) && e.includes(keyIssue(key, "eventSheets")!)),
        `files key ${JSON.stringify(key)}: ${JSON.stringify(fileErrors)}`,
      );
      const layoutErrors = validateRecipe({ layouts: { [key]: addLayer("L") } });
      assert.isTrue(
        layoutErrors.some((e) => e.includes(JSON.stringify(key)) && e.includes(keyIssue(key, "layouts")!)),
        `layouts key ${JSON.stringify(key)}: ${JSON.stringify(layoutErrors)}`,
      );
    }

    // (b) normalization must not paper over a wrongly-typed section: the existing guards must fire.
    const filesArray = validateRecipe({ files: [{ create: true, events: [{ comment: "ARRAY-CREATE" }] }] } as never);
    assert.isTrue(
      filesArray.some((e) => e.includes("recipe.files must be an object")),
      JSON.stringify(filesArray),
    );
    let layoutErrors: string[] = [];
    const threw = caught(() => {
      layoutErrors = validateRecipe({ layouts: { L: "notarray" } } as never);
    });
    assert.isUndefined(threw, `validateRecipe must not throw: ${threw?.message}`);
    assert.isTrue(
      layoutErrors.some((e) => e.includes("value must be an array of layout operations")),
      JSON.stringify(layoutErrors),
    );
  });

  it("KI16: extract-template whose sourceLayout is its own key under another spelling hits the self-check", () => {
    const errors = validateRecipe({
      layouts: {
        "Gameplay/Main Layout": [
          {
            op: "extract-template",
            sourceLayout: "./Gameplay/Main Layout",
            sourceType: "Text2",
            templateName: "T2",
            templatesLayer: "layer 0",
          },
        ],
      },
    });
    assert.isTrue(
      errors.some((e) => e.includes('"sourceLayout" must differ from the layouts key')),
      JSON.stringify(errors),
    );
  });

  it("KI17: clone-replica-to-layouts targets differing by case or `./` hit the duplicate-target error", () => {
    for (const second of ["gameplay/main layout", "./Gameplay/Main Layout"]) {
      const errors = validateRecipe({
        layouts: {
          "Templates Layout": [
            {
              op: "clone-replica-to-layouts",
              templateName: "default",
              sourceType: "Sprite3",
              targets: [
                { layout: "Gameplay/Main Layout", layer: "layer 0" },
                { layout: second, layer: "layer 0" },
              ],
            },
          ],
        },
      });
      assert.isTrue(
        errors.some((e) => e.includes("duplicate target layout")),
        `second target ${JSON.stringify(second)}: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("KI18: a cross-reference spelling split (key vs from / targets[].layout) is an error naming both", () => {
    const fromSplit = validateRecipe({
      layouts: {
        "Gameplay/Main Layout": addLayer("X"),
        "Gameplay/Other": [
          { op: "copy-instance", from: "gameplay/main layout", type: "Sprite3", targetLayer: "layer 0" },
        ],
      },
    });
    assert.isTrue(
      fromSplit.some((e) => e.includes('"Gameplay/Main Layout"') && e.includes('"gameplay/main layout"')),
      `from: ${JSON.stringify(fromSplit)}`,
    );

    const targetSplit = validateRecipe({
      layouts: {
        "Gameplay/Main Layout": addLayer("X"),
        "Templates Layout": [
          {
            op: "clone-replica-to-layouts",
            templateName: "default",
            sourceType: "Sprite3",
            targets: [{ layout: "gameplay/main layout", layer: "layer 0" }],
          },
        ],
      },
    });
    assert.isTrue(
      targetSplit.some((e) => e.includes('"Gameplay/Main Layout"') && e.includes('"gameplay/main layout"')),
      `targets: ${JSON.stringify(targetSplit)}`,
    );
  });

  it("KI19: validateRecipe canonicalizes keys once and is idempotent on a second call", () => {
    const recipe: Recipe = { files: { "./A": ins("a"), "B\\C": ins("bc") } };
    const first = validateRecipe(recipe);
    assert.deepEqual(first, []);
    assert.deepEqual(Object.keys(recipe.files!), ["eventSheets/A.json", "eventSheets/B/C.json"]);
    const second = validateRecipe(recipe);
    assert.deepEqual(second, []);
    assert.deepEqual(Object.keys(recipe.files!), ["eventSheets/A.json", "eventSheets/B/C.json"]);
  });

  it("KI20: the public normalizeRecipePaths throws on a collision instead of collapsing it", () => {
    const err = caught(() => normalizeRecipePaths(r1()));
    assert.instanceOf(err, Error, "normalizeRecipePaths must throw");
    assert.include(err!.message, "name the same event sheet");
  });
});
