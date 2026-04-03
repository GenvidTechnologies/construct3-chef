import { describe, it, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findTemplates } from "../../src/c3/templateLister.js";

/** Write a minimal layout JSON file into `dir` with the given name and layers. */
function writeLayout(dir: string, name: string, layers: unknown[]): void {
  const json = JSON.stringify({ name, layers });
  writeFileSync(path.join(dir, `${name}.json`), json, "utf-8");
}

/** Build a minimal instance object. */
function makeInstance(type: string, opts?: { templateMode?: "template" | "replica" | null }): Record<string, unknown> {
  const inst: Record<string, unknown> = { type, uid: Math.floor(Math.random() * 1e9) };
  if (opts?.templateMode != null) {
    inst.template = { mode: opts.templateMode, templateName: "", sourceTemplateName: "" };
  }
  return inst;
}

/** Build a minimal layer object. */
function makeLayer(name: string, instances: unknown[] = [], subLayers: unknown[] = []): Record<string, unknown> {
  return { name, instances, subLayers };
}

describe("listTemplates / findTemplates", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "burbank-listTemplates-"));
    tmpDirs.push(dir);
    return dir;
  }

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("basic: layout with one template instance returns correct entry", () => {
    const dir = makeTmpDir();
    writeLayout(dir, "HeroLayout", [makeLayer("Layer 0", [makeInstance("HeroCard", { templateMode: "template" })])]);

    const results = findTemplates(dir);
    assert.deepEqual(results, [{ layout: "HeroLayout", type: "HeroCard" }]);
  });

  it("sublayers: template in a sublayer is found", () => {
    const dir = makeTmpDir();
    const subLayer = makeLayer("Sub Layer", [makeInstance("SubWidget", { templateMode: "template" })]);
    writeLayout(dir, "UILayout", [makeLayer("Layer 0", [], [subLayer])]);

    const results = findTemplates(dir);
    assert.deepEqual(results, [{ layout: "UILayout", type: "SubWidget" }]);
  });

  it("no templates: non-template instances are ignored", () => {
    const dir = makeTmpDir();
    writeLayout(dir, "GameLayout", [
      makeLayer("Layer 0", [makeInstance("Sprite"), makeInstance("Button", { templateMode: "replica" })]),
    ]);

    const results = findTemplates(dir);
    assert.deepEqual(results, []);
  });

  it("multiple layouts: results are sorted by layout then type", () => {
    const dir = makeTmpDir();

    writeLayout(dir, "ZebraLayout", [
      makeLayer("Layer 0", [
        makeInstance("Wildebeest", { templateMode: "template" }),
        makeInstance("Antelope", { templateMode: "template" }),
      ]),
    ]);

    writeLayout(dir, "AppleLayout", [
      makeLayer("Layer 0", [
        makeInstance("Seed", { templateMode: "template" }),
        makeInstance("Core", { templateMode: "template" }),
      ]),
    ]);

    const results = findTemplates(dir);

    // Sorted by layout name first (AppleLayout < ZebraLayout), then by type within layout
    assert.deepEqual(results, [
      { layout: "AppleLayout", type: "Core" },
      { layout: "AppleLayout", type: "Seed" },
      { layout: "ZebraLayout", type: "Antelope" },
      { layout: "ZebraLayout", type: "Wildebeest" },
    ]);
  });

  it("deep sublayers: template in nested sublayer is found", () => {
    const dir = makeTmpDir();
    const innerSub = makeLayer("Inner Sub", [makeInstance("DeepWidget", { templateMode: "template" })]);
    const outerSub = makeLayer("Outer Sub", [], [innerSub]);
    writeLayout(dir, "DeepLayout", [makeLayer("Layer 0", [], [outerSub])]);

    const results = findTemplates(dir);
    assert.deepEqual(results, [{ layout: "DeepLayout", type: "DeepWidget" }]);
  });

  it("mixed: template and non-template instances in same layer", () => {
    const dir = makeTmpDir();
    writeLayout(dir, "MixedLayout", [
      makeLayer("Layer 0", [
        makeInstance("Background"),
        makeInstance("CardTemplate", { templateMode: "template" }),
        makeInstance("Overlay", { templateMode: "replica" }),
        makeInstance("ButtonTemplate", { templateMode: "template" }),
      ]),
    ]);

    const results = findTemplates(dir);
    assert.deepEqual(results, [
      { layout: "MixedLayout", type: "ButtonTemplate" },
      { layout: "MixedLayout", type: "CardTemplate" },
    ]);
  });

  it("empty layout: no layers returns empty results", () => {
    const dir = makeTmpDir();
    writeLayout(dir, "EmptyLayout", []);

    const results = findTemplates(dir);
    assert.deepEqual(results, []);
  });

  it("subdirectory layouts: layouts in subdirectories are found", () => {
    const dir = makeTmpDir();
    const subDir = path.join(dir, "TemplateHolders");
    mkdirSync(subDir);
    writeLayout(subDir, "ComponentTemplates", [
      makeLayer("Layer 0", [makeInstance("ButtonComponent", { templateMode: "template" })]),
    ]);

    const results = findTemplates(dir);
    assert.deepEqual(results, [{ layout: "ComponentTemplates", type: "ButtonComponent" }]);
  });
});
