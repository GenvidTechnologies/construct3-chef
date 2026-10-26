import { describe, it, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractScripts, generateDSL, generateLayoutSummaries } from "../../src/c3/generators.js";

/**
 * #309. The scripts, DSL and layout-summary generators compute every output in
 * memory before touching `extracted/`, so a run that fails partway (a malformed
 * sheet, layout or manifest) leaves the existing outputs exactly as they were.
 * Every seed here includes `scripts/importsForEvents.ts`, so a red result on a
 * tree that still cleans first is the deletion itself, not a missing input.
 */
describe("generators leave extracted/ untouched when a run fails (#309)", () => {
  const noop = () => {};
  const SEED = "SEED";
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedProject(): string {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-sl-"));
    tmpDirs.push(root);
    writeFileSync(
      path.join(root, "project.c3proj"),
      JSON.stringify({
        projectFormatVersion: 1,
        scriptsType: "module",
        rootFileFolders: { script: { items: [], subfolders: [] } },
      }),
    );
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "importsForEvents.ts"), "");
    mkdirSync(path.join(root, "layouts"), { recursive: true });
    writeFileSync(
      path.join(root, "layouts", "Main.json"),
      JSON.stringify({ name: "Main", eventSheet: "Main", layers: [] }),
    );
    mkdirSync(path.join(root, "objectTypes"), { recursive: true });
    writeFileSync(path.join(root, "objectTypes", "Hero.json"), JSON.stringify({ name: "Hero", "plugin-id": "Sprite" }));
    mkdirSync(path.join(root, "eventSheets"), { recursive: true });
    writeFileSync(
      path.join(root, "eventSheets", "Main.json"),
      JSON.stringify({
        name: "Main",
        events: [
          {
            eventType: "block",
            conditions: [],
            actions: [{ type: "script", language: "typescript", script: ["console.log(1);"] }],
            sid: 111111111111111,
          },
        ],
        sid: 222222222222222,
      }),
    );
    return root;
  }

  function seed(file: string, content = SEED): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function readOrNull(file: string): string | null {
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  }

  it("SL6: extractScripts keeps the previous .ts and tsconfig.json when a sheet is malformed", () => {
    const root = seedProject();
    const out = path.join(root, "extracted");
    seed(path.join(out, "eventSheets", "Main.ts"));
    seed(path.join(out, "tsconfig.json"));
    writeFileSync(path.join(root, "eventSheets", "Broken.json"), "{ not json");

    assert.throws(() => extractScripts(root, out, noop));

    assert.deepEqual(
      {
        ts: readOrNull(path.join(out, "eventSheets", "Main.ts")),
        tsconfig: readOrNull(path.join(out, "tsconfig.json")),
      },
      { ts: SEED, tsconfig: SEED },
    );
  });

  it("SL7: a successful extractScripts deletes orphan .ts, prunes emptied dirs, and leaves unowned files", () => {
    const root = seedProject();
    const out = path.join(root, "extracted");
    seed(path.join(out, "eventSheets", "Gone.ts"));
    seed(path.join(out, "eventSheets", "Old", "Gone.ts"));
    seed(path.join(out, "notes.txt"));

    extractScripts(root, out, noop);

    assert.deepEqual(
      {
        gone: existsSync(path.join(out, "eventSheets", "Gone.ts")),
        oldGone: existsSync(path.join(out, "eventSheets", "Old", "Gone.ts")),
        oldDir: existsSync(path.join(out, "eventSheets", "Old")),
        notes: readOrNull(path.join(out, "notes.txt")),
        main: existsSync(path.join(out, "eventSheets", "Main.ts")),
      },
      { gone: false, oldGone: false, oldDir: false, notes: SEED, main: true },
    );
  });

  it("SL8: generateDSL keeps the previous .dsl.txt and .dsl.idx.txt when a sheet is malformed", () => {
    const root = seedProject();
    const out = path.join(root, "extracted");
    seed(path.join(out, "eventSheets", "Main.dsl.txt"));
    seed(path.join(out, "eventSheets", "Main.dsl.idx.txt"));
    writeFileSync(path.join(root, "eventSheets", "Broken.json"), "{ not json");

    assert.throws(() => generateDSL(root, out, noop));

    assert.deepEqual(
      {
        dsl: readOrNull(path.join(out, "eventSheets", "Main.dsl.txt")),
        idx: readOrNull(path.join(out, "eventSheets", "Main.dsl.idx.txt")),
      },
      { dsl: SEED, idx: SEED },
    );
  });

  it("SL9: generateLayoutSummaries keeps the previous summary and containers.txt when a layout is malformed", () => {
    const root = seedProject();
    const out = path.join(root, "extracted");
    seed(path.join(out, "layouts", "Main.layout.txt"));
    seed(path.join(out, "containers.txt"));
    writeFileSync(path.join(root, "layouts", "Broken.json"), "{ not json");

    assert.throws(() => generateLayoutSummaries(root, out, noop));

    assert.deepEqual(
      {
        layout: readOrNull(path.join(out, "layouts", "Main.layout.txt")),
        containers: readOrNull(path.join(out, "containers.txt")),
      },
      { layout: SEED, containers: SEED },
    );
  });

  it("SL10: generateLayoutSummaries keeps the previous summary and containers.txt when project.c3proj is malformed", () => {
    const root = seedProject();
    const out = path.join(root, "extracted");
    seed(path.join(out, "layouts", "Main.layout.txt"));
    seed(path.join(out, "containers.txt"));
    writeFileSync(path.join(root, "project.c3proj"), "{ not json");

    assert.throws(() => generateLayoutSummaries(root, out, noop));

    assert.deepEqual(
      {
        layout: readOrNull(path.join(out, "layouts", "Main.layout.txt")),
        containers: readOrNull(path.join(out, "containers.txt")),
      },
      { layout: SEED, containers: SEED },
    );
  });
});
