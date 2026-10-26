import { describe, it, afterEach } from "mocha";
import { assert } from "chai";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractScripts, generateDSL, generateLayoutSummaries } from "../../src/c3/generators.js";
import { copyFixture } from "../helpers/applyFixtures.js";
import { runCli } from "../helpers/runCli.js";

/**
 * #309. The scripts, DSL and layout-summary generators compute every output in
 * memory before touching `extracted/`, so a run that fails partway (a malformed
 * sheet, layout or manifest) leaves the existing outputs exactly as they were.
 * `seedProject` includes `scripts/importsForEvents.ts`, so a red result on a
 * tree that still cleans first is the deletion itself, not a missing input.
 * SL1-SL5 and SL14 cover a project without that file or without `scripts/`.
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

  /** The seed project with `scripts/` removed entirely. */
  function seedScriptsLess(): string {
    const root = seedProject();
    rmSync(path.join(root, "scripts"), { recursive: true, force: true });
    return root;
  }

  function listRelative(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    };
    walk(dir);
    return out.sort();
  }

  const NINE_FILES = [
    "containers.txt",
    "eventSheets/Main.dsl.idx.txt",
    "eventSheets/Main.dsl.txt",
    "eventSheets/Main.ts",
    "global-layers.txt",
    "layouts/Main.layout.txt",
    "sid-registry.txt",
    "template-scope.txt",
    "tsconfig.json",
  ];

  it("SL1: CLI generate on a project with no scripts/ exits 0 and writes the nine outputs", function () {
    this.timeout(60000);
    const root = seedScriptsLess();
    const r = runCli(["generate", "--project-dir", root]);
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.deepEqual(listRelative(path.join(root, "extracted")), NINE_FILES);
  });

  it("SL2: generate --only scripts on a project with no scripts/ extracts without imports", function () {
    this.timeout(60000);
    const root = seedScriptsLess();
    const r = runCli(["generate", "--only", "scripts", "--project-dir", root]);
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.isTrue(existsSync(path.join(root, "extracted", "tsconfig.json")), "tsconfig.json");
    assert.isTrue(existsSync(path.join(root, "extracted", "eventSheets", "Main.ts")), "Main.ts");
    assert.include(r.stdout, "extracting without imports");
  });

  it("SL3: with no scripts/, Main.ts has no import line and tsconfig.json matches the golden", () => {
    const root = seedScriptsLess();
    const out = path.join(root, "extracted");
    extractScripts(root, out, noop);

    const main = readFileSync(path.join(out, "eventSheets", "Main.ts"), "utf-8");
    assert.deepEqual(
      {
        importLines: main.split(/\r?\n/).filter((l) => l.startsWith("import ")),
        globalVars: main.includes("declare const globalVars: IConstructProjectGlobalVariables;"),
        script: main.includes("console.log(1);"),
        tsconfigIsGolden: readFileSync(path.join(out, "tsconfig.json"), "utf-8"),
      },
      {
        importLines: [],
        globalVars: true,
        script: true,
        tsconfigIsGolden: readFileSync(
          path.resolve("test/fixtures/construct3-chef-sample/extracted/tsconfig.json"),
          "utf-8",
        ),
      },
    );
  });

  it("SL4: with scripts/ present but no importsForEvents.ts, extractScripts writes an import-less header", () => {
    const root = seedScriptsLess();
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "main.ts"), "");
    const out = path.join(root, "extracted");
    extractScripts(root, out, noop);

    const main = readFileSync(path.join(out, "eventSheets", "Main.ts"), "utf-8");
    assert.deepEqual(
      {
        importLines: main.split(/\r?\n/).filter((l) => l.startsWith("import ")),
        globalVars: main.includes("declare const globalVars: IConstructProjectGlobalVariables;"),
      },
      { importLines: [], globalVars: true },
    );
  });

  it("SL5: an import in scripts/importsForEvents.ts is still rewritten relative to the output", () => {
    const root = seedProject();
    writeFileSync(path.join(root, "scripts", "importsForEvents.ts"), 'import * as Utils from "./utils.js";\n');
    const out = path.join(root, "extracted");
    extractScripts(root, out, noop);

    const main = readFileSync(path.join(out, "eventSheets", "Main.ts"), "utf-8");
    assert.include(main.split(/\r?\n/), 'import * as Utils from "../../scripts/utils.js";');
  });

  it("SL14: CLI apply-recipe (regenerate on) on a fixture copy without scripts/ succeeds", function () {
    this.timeout(60000);
    const root = copyFixture("c3chef-sl14-");
    tmpDirs.push(root);
    rmSync(path.join(root, "scripts"), { recursive: true });
    const recipePath = path.join(root, "sl14-recipe.json");
    writeFileSync(
      recipePath,
      JSON.stringify({ files: { "eventSheets/SL14.json": { create: true, events: [{ comment: "SL14" }] } } }),
    );
    const r = runCli(["apply-recipe", recipePath, "--project-dir", root]);
    assert.equal(r.exitCode, 0, r.stderr + r.stdout);
    assert.notInclude(r.stdout + r.stderr, "failed after writing");
    const registry = readFileSync(path.join(root, "extracted", "sid-registry.txt"), "utf8");
    assert.isAtLeast(registry.split(/\r?\n/).filter((l) => l.includes("eventSheets/SL14.json")).length, 1);
  });

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
