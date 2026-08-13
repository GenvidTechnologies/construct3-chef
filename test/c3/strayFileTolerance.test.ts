import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openProject } from "@genvidtech/c3source";
import { generateLayoutSummaries, generateTemplateScope, generateGlobalLayers } from "../../src/c3/generators.js";
import { readProjectObjects, readLayoutEffects } from "../../src/c3/projectObjects.js";
import { findTemplates } from "../../src/c3/templateLister.js";
import { buildLayoutEventSheetMap } from "../../src/c3/navigationGraph.js";
import { collectAllUids } from "../../src/c3/layoutScaffold.js";

/**
 * #175 (RED step). `@genvidtech/c3source@1.9.0`'s `find_all_layouts_path` /
 * `find_all_objectTypes_path` return every non-editor-local file, not just
 * `.json` ones — so a stray file sitting under `layouts/` or `objectTypes/`
 * reaches one of chef's several unguarded `JSON.parse` call sites and throws
 * a `SyntaxError`. `@genvidtech/c3source@2.0.0` narrows both finders to
 * `.json`-only, which fixes every site below with NO code change here.
 *
 * This test is deliberately written and committed BEFORE the bump (task 2 of
 * the #175 plan), so its red state — a `SyntaxError` — is the structural
 * revert-confirm: proof that the fix is real, not a coincidental green.
 *
 * Each `it` below drives one of chef's real consuming entry points (not the
 * upstream finder itself, which c3source's own suite already covers) against
 * a seeded temp-dir project containing:
 *   - a valid `layouts/MainLayout.json`
 *   - a stray, non-JSON `layouts/notes.txt`
 *   - a valid `objectTypes/Hero.json`
 *   - a stray, non-JSON `objectTypes/README.md`
 *
 * DELIBERATELY EXCLUDED: `src/c3/recipeApplier.ts:331`. Its
 * `findObjectTypeFile` (`:283-288`) filters candidates with
 * `path.basename(p, ".json") === typeName`, so a stray `README.md` yields
 * basename `README.md`, never matches `typeName`, and is silently skipped —
 * it only crashes on a stray file named *exactly* `<TypeName>` with no
 * extension at all (e.g. a stray literally named `Hero`). That is a
 * genuinely different and much rarer shape than "any non-JSON file in the
 * directory"; folding it into this test would make the failure mode
 * ambiguous about which guard is being proven. Do not add it here.
 */
describe("stray-file tolerance in chef's consumers (#175)", () => {
  const noop = () => {};
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /**
   * Seed a throwaway C3 project root with one valid layout, one valid
   * objectType, a minimal `project.c3proj`, and a stray non-JSON file in
   * each of `layouts/` and `objectTypes/`.
   */
  function seedProject(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "c3chef-stray-"));

    writeFileSync(path.join(root, "project.c3proj"), JSON.stringify({}, null, "\t"));

    const layoutsDir = path.join(root, "layouts");
    mkdirSync(layoutsDir, { recursive: true });
    writeFileSync(
      path.join(layoutsDir, "MainLayout.json"),
      JSON.stringify({ name: "MainLayout", eventSheet: "MainEvents", layers: [] }),
    );
    writeFileSync(path.join(layoutsDir, "notes.txt"), "This is a stray note, not JSON.\n");

    const objectTypesDir = path.join(root, "objectTypes");
    mkdirSync(objectTypesDir, { recursive: true });
    writeFileSync(path.join(objectTypesDir, "Hero.json"), JSON.stringify({ name: "Hero", "plugin-id": "Sprite" }));
    writeFileSync(path.join(objectTypesDir, "README.md"), "# Notes\nThis is a stray readme, not JSON.\n");

    return root;
  }

  // ─── generators.ts layout passes ───

  it("generators.ts: generateLayoutSummaries tolerates a stray non-JSON file under layouts/ (:357)", () => {
    tmpDir = seedProject();
    const outDir = path.join(tmpDir, "extracted");
    generateLayoutSummaries(tmpDir, outDir, noop);
  });

  it("generators.ts: generateTemplateScope tolerates a stray non-JSON file under layouts/ (:426)", () => {
    tmpDir = seedProject();
    const outDir = path.join(tmpDir, "extracted");
    generateTemplateScope(tmpDir, outDir, noop);
  });

  it("generators.ts: generateGlobalLayers tolerates a stray non-JSON file under layouts/ (:472)", () => {
    tmpDir = seedProject();
    const outDir = path.join(tmpDir, "extracted");
    generateGlobalLayers(tmpDir, outDir, noop);
  });

  // ─── projectObjects.ts ───

  it("projectObjects.ts: readProjectObjects tolerates a stray non-JSON file under objectTypes/ (readObjectDefn, :79)", () => {
    tmpDir = seedProject();
    const project = openProject(tmpDir);
    const defns = readProjectObjects(project);
    expect(defns).to.have.lengthOf(1);
    expect(defns[0].name).to.equal("Hero");
  });

  it("projectObjects.ts: readLayoutEffects tolerates a stray non-JSON file under layouts/ (:159)", () => {
    tmpDir = seedProject();
    const project = openProject(tmpDir);
    const sites = readLayoutEffects(project);
    expect(sites).to.deep.equal([]);
  });

  // ─── templateLister.ts ───

  it("templateLister.ts: findTemplates tolerates a stray non-JSON file under layouts/ (:10)", () => {
    tmpDir = seedProject();
    const results = findTemplates(path.join(tmpDir, "layouts"));
    expect(results).to.deep.equal([]);
  });

  // ─── navigationGraph.ts ───

  it("navigationGraph.ts: buildLayoutEventSheetMap tolerates a stray non-JSON file under layouts/ (:12)", () => {
    tmpDir = seedProject();
    const map = buildLayoutEventSheetMap(path.join(tmpDir, "layouts"));
    expect(map).to.deep.equal({ MainLayout: "MainEvents" });
  });

  // ─── layoutScaffold.ts ───

  it("layoutScaffold.ts: collectAllUids tolerates a stray non-JSON file under layouts/ (:77)", () => {
    tmpDir = seedProject();
    const uids = collectAllUids(path.join(tmpDir, "layouts"));
    expect(uids).to.deep.equal(new Set());
  });
});
