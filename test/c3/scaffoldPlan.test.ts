import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  formatScaffoldNameRejection,
  formatScaffoldPathRejection,
  formatScaffoldSourceNotFound,
  planLayoutScaffold,
  planSpriteScaffold,
  writeLayoutScaffold,
  type LayoutScaffoldPlanOptions,
  type ScaffoldRejection,
} from "../../src/c3/scaffoldPlan.js";

// T26 (#259): the shared plan/write split. Every row runs against a temp COPY of the canonical
// fixture — never the fixture itself.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const SOURCE_REL = "Gameplay/Main Layout.json"; // relative to layouts/

/** relPath -> bytes (hex) of every file under root. */
function snapshotTree(root: string): Map<string, string> {
  const snap = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else snap.set(path.relative(root, full).split(path.sep).join("/"), readFileSync(full).toString("hex"));
    }
  };
  walk(root);
  return snap;
}

describe("scaffoldPlan (T26, #259)", function () {
  this.timeout(30_000);

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-scaffold-plan-"));
    cpSync(FIXTURE_ROOT, tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const layoutsDir = (): string => path.join(tmp, "layouts");

  function layoutOpts(
    pathBase: "layouts" | "project-root",
    over: Partial<LayoutScaffoldPlanOptions> = {},
  ): LayoutScaffoldPlanOptions {
    const prefix = pathBase === "layouts" ? "" : "layouts/";
    return {
      rootDir: tmp,
      layoutsDir: layoutsDir(),
      extractedDirAbs: path.join(tmp, "extracted"),
      pathBase,
      source: prefix + SOURCE_REL,
      out: prefix + "Gameplay/PlanX.json",
      name: "PlanX",
      eventSheet: "Event sheet 1",
      ...over,
    };
  }

  function spriteOpts(over: Partial<{ source: string; name: string }> = {}) {
    return {
      rootDir: tmp,
      objectTypesDir: path.join(tmp, "objectTypes"),
      imagesDir: path.join(tmp, "images"),
      source: "Text",
      name: "PlanFresh",
      ...over,
    };
  }

  describe("containment matrix", () => {
    for (const pathBase of ["layouts", "project-root"] as const) {
      const prefix = pathBase === "layouts" ? "" : "layouts/";
      // A path that climbs out of layouts/ under this base.
      const escaping = pathBase === "layouts" ? "../x.json" : "layouts/../x.json";
      const intoSheets = pathBase === "layouts" ? "../eventSheets/x.json" : "layouts/../eventSheets/x.json";

      for (const which of ["output", "source"] as const) {
        const key = which === "output" ? "out" : "source";

        const rejectCases: Array<[string, () => string]> = [
          ["escaping ../x.json", () => escaping],
          ["climb into eventSheets/", () => intoSheets],
          ["absolute path outside layouts/", () => path.join(tmp, "eventSheets", "x.json")],
        ];
        for (const [label, raw] of rejectCases) {
          it(`${pathBase} base: ${which} ${label} is rejected as invalid-path`, () => {
            const value = raw();
            const r = planLayoutScaffold(layoutOpts(pathBase, { [key]: value }));
            expect(r.ok).to.equal(false);
            const rej = r as ScaffoldRejection;
            expect(rej.kind).to.equal("invalid-path");
            expect(rej.message).to.equal(formatScaffoldPathRejection(which, value));
          });
        }

        it(`${pathBase} base: ${which} name merely starting with '..' is not an invalid-path`, () => {
          const value = prefix + "..cache.json";
          const r = planLayoutScaffold(layoutOpts(pathBase, { [key]: value }));
          if (!r.ok) expect(r.kind).to.not.equal("invalid-path");
        });
      }

      it(`${pathBase} base: absolute output path inside layouts/ is accepted`, () => {
        const abs = path.join(layoutsDir(), "Gameplay", "PlanAbs.json");
        const r = planLayoutScaffold(layoutOpts(pathBase, { out: abs }));
        expect(r.ok).to.equal(true);
        if (r.ok) expect(r.outPath).to.equal(abs);
      });

      it(`${pathBase} base: absolute source path inside layouts/ is accepted`, () => {
        const abs = path.join(layoutsDir(), "Gameplay", "Main Layout.json");
        const r = planLayoutScaffold(layoutOpts(pathBase, { source: abs }));
        expect(r.ok).to.equal(true);
      });

      it(`${pathBase} base: success line uses '/' separators relative to the project root`, () => {
        const r = planLayoutScaffold(layoutOpts(pathBase));
        expect(r.ok).to.equal(true);
        if (r.ok) expect(r.successLine).to.equal("Scaffolded PlanX → layouts/Gameplay/PlanX.json");
      });
    }

    it("'..cache.json' under the layouts base resolves to a file inside layouts/", () => {
      const r = planLayoutScaffold(layoutOpts("layouts", { out: "..cache.json" }));
      expect(r.ok).to.equal(true);
      if (r.ok) expect(r.outPath).to.equal(path.join(layoutsDir(), "..cache.json"));
    });
  });

  describe("check order", () => {
    it("invalid-path wins over source-not-found", () => {
      const r = planLayoutScaffold(layoutOpts("layouts", { source: "../missing.json" })) as ScaffoldRejection;
      expect(r.kind).to.equal("invalid-path");
    });

    it("source-not-found wins over conflict", () => {
      // Output already exists AND the source is missing -> not-found, not conflict.
      const r = planLayoutScaffold(
        layoutOpts("layouts", { source: "Gameplay/NoSuch.json", out: SOURCE_REL }),
      ) as ScaffoldRejection;
      expect(r.kind).to.equal("source-not-found");
      expect(r.message).to.equal(formatScaffoldSourceNotFound("layout", "layouts/Gameplay/NoSuch.json"));
    });

    it("existing output with a real source is a conflict", () => {
      const r = planLayoutScaffold(layoutOpts("layouts", { out: SOURCE_REL })) as ScaffoldRejection;
      expect(r.kind).to.equal("conflict");
      expect(r.message).to.include("scaffold-layout refused:");
    });

    it("sprite: source-not-found wins over conflict", () => {
      const r = planSpriteScaffold(spriteOpts({ source: "NoSuchType", name: "Text" })) as ScaffoldRejection;
      expect(r.kind).to.equal("source-not-found");
      expect(r.message).to.equal(formatScaffoldSourceNotFound("objectType", "objectTypes/NoSuchType.json"));
    });

    it("sprite: existing target name is a conflict", () => {
      const r = planSpriteScaffold(spriteOpts({ name: "Sprite" })) as ScaffoldRejection;
      expect(r.kind).to.equal("conflict");
      expect(r.message).to.include("scaffold-sprite refused:");
    });
  });

  describe("sprite name validation", () => {
    for (const bad of ["a..b", "a/b", "a\\b"]) {
      it(`rejects name ${JSON.stringify(bad)} as invalid-name`, () => {
        const r = planSpriteScaffold(spriteOpts({ name: bad })) as ScaffoldRejection;
        expect(r.ok).to.equal(false);
        expect(r.kind).to.equal("invalid-name");
        expect(r.message).to.equal(formatScaffoldNameRejection("name", bad));
      });
      it(`rejects source ${JSON.stringify(bad)} as invalid-name`, () => {
        const r = planSpriteScaffold(spriteOpts({ source: bad })) as ScaffoldRejection;
        expect(r.kind).to.equal("invalid-name");
        expect(r.message).to.equal(formatScaffoldNameRejection("source", bad));
      });
    }

    it("when both source and name are bad, the message is about source", () => {
      const r = planSpriteScaffold(spriteOpts({ source: "s/x", name: "n/y" })) as ScaffoldRejection;
      expect(r.message).to.equal(formatScaffoldNameRejection("source", "s/x"));
    });
  });

  describe("no images dir", () => {
    it("planSpriteScaffold succeeds with empty imageCopies when images/ is missing", () => {
      rmSync(path.join(tmp, "images"), { recursive: true, force: true });
      expect(existsSync(path.join(tmp, "images"))).to.equal(false);
      const r = planSpriteScaffold(spriteOpts());
      expect(r.ok).to.equal(true);
      if (r.ok) expect(r.imageCopies).to.deep.equal([]);
    });
  });

  describe("plans never write", () => {
    it("planLayoutScaffold leaves the tree byte-identical (success input)", () => {
      const before = snapshotTree(tmp);
      const r = planLayoutScaffold(layoutOpts("layouts"));
      expect(r.ok).to.equal(true);
      expect(snapshotTree(tmp)).to.deep.equal(before);
      expect(existsSync(path.join(tmp, "layouts", "Gameplay", "PlanX.json"))).to.equal(false);
    });

    it("planLayoutScaffold leaves the tree byte-identical (rejection inputs)", () => {
      const before = snapshotTree(tmp);
      expect(planLayoutScaffold(layoutOpts("layouts", { out: "../x.json" })).ok).to.equal(false);
      expect(planLayoutScaffold(layoutOpts("layouts", { source: "Gameplay/NoSuch.json" })).ok).to.equal(false);
      expect(planLayoutScaffold(layoutOpts("layouts", { out: SOURCE_REL })).ok).to.equal(false);
      expect(snapshotTree(tmp)).to.deep.equal(before);
    });

    it("planLayoutScaffold into a not-yet-existing directory creates no directory", () => {
      const r = planLayoutScaffold(layoutOpts("layouts", { out: "NewDir/PlanY.json" }));
      expect(r.ok).to.equal(true);
      expect(existsSync(path.join(layoutsDir(), "NewDir"))).to.equal(false);
    });

    it("planSpriteScaffold leaves the tree byte-identical (success input)", () => {
      const before = snapshotTree(tmp);
      const r = planSpriteScaffold(spriteOpts());
      expect(r.ok).to.equal(true);
      expect(snapshotTree(tmp)).to.deep.equal(before);
      expect(existsSync(path.join(tmp, "objectTypes", "PlanFresh.json"))).to.equal(false);
    });

    it("planSpriteScaffold leaves the tree byte-identical (rejection inputs)", () => {
      const before = snapshotTree(tmp);
      expect(planSpriteScaffold(spriteOpts({ name: "a/b" })).ok).to.equal(false);
      expect(planSpriteScaffold(spriteOpts({ source: "NoSuchType" })).ok).to.equal(false);
      expect(planSpriteScaffold(spriteOpts({ name: "Sprite" })).ok).to.equal(false);
      expect(snapshotTree(tmp)).to.deep.equal(before);
    });
  });

  describe("writeLayoutScaffold", () => {
    it("creates missing parent directories, writes the file, and logs the success line once", () => {
      const r = planLayoutScaffold(layoutOpts("layouts", { out: "NewDir/PlanZ.json", name: "PlanZ" }));
      expect(r.ok).to.equal(true);
      if (!r.ok) return;
      const lines: string[] = [];
      writeLayoutScaffold(r, (l) => lines.push(l));
      expect(existsSync(path.join(layoutsDir(), "NewDir", "PlanZ.json"))).to.equal(true);
      expect(lines).to.deep.equal(["Scaffolded PlanZ → layouts/NewDir/PlanZ.json"]);
    });
  });
});
