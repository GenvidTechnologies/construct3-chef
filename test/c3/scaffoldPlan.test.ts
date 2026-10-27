import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  copyFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectAllObjectTypeSids, collectMaxImageSpriteId } from "../../src/c3/spriteScaffold.js";
import {
  formatScaffoldEmptyInput,
  formatScaffoldOutputNotJson,
  formatScaffoldSourceNotFile,
  formatScaffoldNameRejection,
  formatScaffoldPathRejection,
  formatScaffoldSourceAmbiguous,
  formatScaffoldSourceCaseMismatch,
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
          // Contained, so it gets past the path check: an output is accepted outright, and a
          // source (no such file in the fixture) reaches the existence check.
          if (which === "output") expect(r.ok, JSON.stringify(r)).to.equal(true);
          else expect(r.ok ? "ok" : r.kind).to.equal("source-not-found");
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

  describe("input guards (#267)", () => {
    for (const pathBase of ["layouts", "project-root"] as const) {
      const prefix = pathBase === "layouts" ? "" : "layouts/";
      const before = (): Map<string, string> => snapshotTree(tmp);

      it(`SI267-R4: ${pathBase} base: empty name is rejected with the shared message`, () => {
        const snap = before();
        const r = planLayoutScaffold(layoutOpts(pathBase, { name: "" })) as ScaffoldRejection;
        expect(r.ok).to.equal(false);
        expect(r.message).to.equal(formatScaffoldEmptyInput("name"));
        expect(snapshotTree(tmp)).to.deep.equal(snap);
      });

      it(`SI267-R5: ${pathBase} base: empty eventSheet is rejected with the shared message`, () => {
        const snap = before();
        const r = planLayoutScaffold(layoutOpts(pathBase, { eventSheet: "" })) as ScaffoldRejection;
        expect(r.ok).to.equal(false);
        expect(r.message).to.equal(formatScaffoldEmptyInput("event sheet"));
        expect(snapshotTree(tmp)).to.deep.equal(snap);
      });

      for (const [bad, rel] of [
        ["Foo/", "layouts/Foo"],
        ["Foo", "layouts/Foo"],
        ["Foo.JSON", "layouts/Foo.JSON"],
        [".json", "layouts/.json"],
      ]) {
        it(`SI267-R6: ${pathBase} base: output '${prefix}${bad}' is rejected as not a .json file with a name`, () => {
          const out = prefix + bad;
          const r = planLayoutScaffold(layoutOpts(pathBase, { out })) as ScaffoldRejection;
          expect(r.ok).to.equal(false);
          expect(r.message).to.equal(formatScaffoldOutputNotJson(rel));
        });
      }

      it(`SI267-R6: ${pathBase} base: accept control: output '${prefix}Foo.json' plans`, () => {
        const r = planLayoutScaffold(layoutOpts(pathBase, { out: prefix + "Foo.json" }));
        expect(r.ok, JSON.stringify(r)).to.equal(true);
      });

      it(`SI267-R7: ${pathBase} base: a directory source is rejected naming the path, never EISDIR`, () => {
        const r = planLayoutScaffold(layoutOpts(pathBase, { source: prefix + "Gameplay" })) as ScaffoldRejection;
        expect(r.ok).to.equal(false);
        expect(r.message).to.equal(formatScaffoldSourceNotFile("layouts/Gameplay"));
        expect(r.message).to.not.include("EISDIR");
      });
    }
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

  // #294: a bare source name is looked up in every objectTypes/ subfolder.
  describe("sprite source resolution (#294)", () => {
    const AMBIGUOUS_TEXT =
      "Source objectType 'Text' is ambiguous: 2 objectTypes have this name (letter case is ignored): " +
      "objectTypes/Text.json, objectTypes/tiles/Text.json. Rename all but one before cloning.";

    const plantCopy = (fromRel: string, toRel: string): void => {
      mkdirSync(path.dirname(path.join(tmp, toRel)), { recursive: true });
      copyFileSync(path.join(tmp, fromRel), path.join(tmp, toRel));
    };

    /** Every `key` number found anywhere in a parsed JSON value. */
    const numbersAt = (value: unknown, key: string, out: number[] = []): number[] => {
      if (value === null || typeof value !== "object") return out;
      for (const [k, v] of Object.entries(value)) {
        if (k === key && typeof v === "number") out.push(v);
        else numbersAt(v, key, out);
      }
      return out;
    };

    it("SR2: the ambiguous message is the same for either input order and matches the literal", () => {
      const a = formatScaffoldSourceAmbiguous("Text", ["objectTypes/Text.json", "objectTypes/tiles/Text.json"]);
      const b = formatScaffoldSourceAmbiguous("Text", ["objectTypes/tiles/Text.json", "objectTypes/Text.json"]);
      expect(a).to.equal(b);
      expect(a).to.equal(AMBIGUOUS_TEXT);
    });

    it("SR3: a source filed under a subfolder resolves, and the clone is written flat with fresh ids", () => {
      const objectTypesDir = path.join(tmp, "objectTypes");
      const existingSids = collectAllObjectTypeSids(objectTypesDir);
      const maxBefore = collectMaxImageSpriteId(objectTypesDir);
      const r = planSpriteScaffold(spriteOpts({ source: "Sprite2", name: "X" }));
      expect(r.ok, JSON.stringify(r)).to.equal(true);
      if (!r.ok) return;
      expect(r.outPath).to.equal(path.join(objectTypesDir, "X.json"));
      expect(r.imageCopies.map((c) => [c.sourceBasename, c.targetBasename])).to.deep.equal([
        ["sprite2-animation 1-000.png", "x-animation 1-000.png"],
      ]);
      const sids = numbersAt(r.cloned, "sid");
      expect(sids.length).to.be.greaterThan(0);
      expect(sids.filter((s) => existingSids.has(s))).to.deep.equal([]);
      const imageIds = numbersAt(r.cloned, "imageSpriteId");
      expect(imageIds.length).to.be.greaterThan(0);
      expect(imageIds.filter((id) => id <= maxBefore)).to.deep.equal([]);
    });

    it("SR4: a case-only source match is refused with the on-disk spelling", () => {
      const got: Record<string, { kind: string; message: string }> = {};
      for (const source of ["text", "sprite2"]) {
        const r = planSpriteScaffold(spriteOpts({ source })) as ScaffoldRejection;
        expect(r.ok).to.equal(false);
        got[source] = { kind: r.kind, message: r.message };
      }
      expect(got).to.deep.equal({
        text: {
          kind: "source-case-mismatch",
          message:
            "Source objectType 'text' matches objectTypes/Text.json only when letter case is ignored. " +
            "Use the on-disk spelling 'Text', so the result is the same on every filesystem.",
        },
        sprite2: {
          kind: "source-case-mismatch",
          message:
            "Source objectType 'sprite2' matches objectTypes/images/Sprite2.json only when letter case is ignored. " +
            "Use the on-disk spelling 'Sprite2', so the result is the same on every filesystem.",
        },
      });
      expect(got.text!.message).to.equal(formatScaffoldSourceCaseMismatch("text", "objectTypes/Text.json"));
    });

    it("SR5: the same name in two locations is ambiguous, not first-hit", () => {
      plantCopy("objectTypes/Text.json", "objectTypes/tiles/Text.json");
      const r = planSpriteScaffold(spriteOpts({ source: "Text" })) as ScaffoldRejection;
      expect(r.ok).to.equal(false);
      expect({ kind: r.kind, message: r.message }).to.deep.equal({ kind: "source-ambiguous", message: AMBIGUOUS_TEXT });
    });

    it("SR6: a case-variant duplicate in another folder makes the exact name ambiguous", () => {
      plantCopy("objectTypes/Text.json", "objectTypes/tiles/text.json");
      const r = planSpriteScaffold(spriteOpts({ source: "Text" })) as ScaffoldRejection;
      expect(r.kind).to.equal("source-ambiguous");
      expect(r.message).to.include("objectTypes/Text.json");
      expect(r.message).to.include("objectTypes/tiles/text.json");
    });

    it("SR7: source resolution is checked before the name conflict, and a path source is still invalid-name", () => {
      const caseMismatch = planSpriteScaffold(spriteOpts({ source: "text", name: "Sprite" })) as ScaffoldRejection;
      plantCopy("objectTypes/Text.json", "objectTypes/tiles/Text.json");
      const ambiguous = planSpriteScaffold(spriteOpts({ source: "Text", name: "Sprite" })) as ScaffoldRejection;
      const path_ = planSpriteScaffold(spriteOpts({ source: "images/Sprite", name: "Fresh" })) as ScaffoldRejection;
      expect([caseMismatch.kind, ambiguous.kind, path_.kind]).to.deep.equal([
        "source-case-mismatch",
        "source-ambiguous",
        "invalid-name",
      ]);
    });

    it("SR8: editor-local files are never a source", () => {
      plantCopy("objectTypes/Text.json", "objectTypes/Ghost.uistate.json");
      plantCopy("objectTypes/Text.json", "objectTypes/uistate/Ghost2.json");
      plantCopy("objectTypes/Text.json", "objectTypes/ts-defs/Ghost3.json");
      plantCopy("objectTypes/Text.json", "objectTypes/tsconfig.json");
      const sources = ["Ghost.uistate", "Ghost2", "Ghost3", "tsconfig"];
      const got: Record<string, { kind: string; message: string }> = {};
      const want: Record<string, { kind: string; message: string }> = {};
      for (const source of sources) {
        const r = planSpriteScaffold(spriteOpts({ source })) as ScaffoldRejection;
        got[source] = { kind: r.kind ?? "ok", message: r.message };
        want[source] = {
          kind: "source-not-found",
          message: formatScaffoldSourceNotFound("objectType", `objectTypes/${source}.json`),
        };
      }
      expect(got).to.deep.equal(want);
    });

    it("SR9: an editor-local namesake does not make a real source ambiguous", () => {
      mkdirSync(path.join(tmp, "objectTypes", "uistate"), { recursive: true });
      writeFileSync(
        path.join(tmp, "objectTypes", "uistate", "Text.json"),
        JSON.stringify({ name: "Text", "plugin-id": "Sprite", sid: 1 }),
      );
      const r = planSpriteScaffold(spriteOpts({ source: "Text" }));
      expect(r.ok, JSON.stringify(r)).to.equal(true);
      if (r.ok) expect(r.cloned["plugin-id"]).to.equal("Text");
    });

    it("SR10: a project with no objectTypes/ directory reports not-found instead of throwing", () => {
      rmSync(path.join(tmp, "objectTypes"), { recursive: true, force: true });
      let r: ReturnType<typeof planSpriteScaffold> | undefined;
      expect(() => {
        r = planSpriteScaffold(spriteOpts({ source: "Text" }));
      }).to.not.throw();
      const rej = r as ScaffoldRejection;
      expect(rej.kind).to.equal("source-not-found");
      expect(rej.message).to.equal("Source objectType not found: objectTypes/Text.json");
    });

    it("SR11: refusing a case-mismatch or an ambiguous source writes nothing", () => {
      const before = snapshotTree(tmp);
      expect(planSpriteScaffold(spriteOpts({ source: "text" })).ok).to.equal(false);
      expect(snapshotTree(tmp)).to.deep.equal(before);
      plantCopy("objectTypes/Text.json", "objectTypes/tiles/Text.json");
      const planted = snapshotTree(tmp);
      expect(planSpriteScaffold(spriteOpts({ source: "Text" })).ok).to.equal(false);
      expect(snapshotTree(tmp)).to.deep.equal(planted);
    });
  });

  describe("sprite name validation", () => {
    for (const bad of ["a/b", "a\\b", ".", "..", "../X", " . ."]) {
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

    it("SI267-R1: an empty name and an empty source are invalid-name with the shared message", () => {
      const n = planSpriteScaffold(spriteOpts({ name: "" })) as ScaffoldRejection;
      expect(n.ok).to.equal(false);
      expect(n.kind).to.equal("invalid-name");
      expect(n.message).to.equal(formatScaffoldNameRejection("name", ""));
      expect(n.message).to.equal("Invalid name '' — must not be empty");
      const s = planSpriteScaffold(spriteOpts({ source: "" })) as ScaffoldRejection;
      expect(s.kind).to.equal("invalid-name");
      expect(s.message).to.equal("Invalid source '' — must not be empty");
    });

    it("SI267-R2: a name or source containing ':' is invalid-name", () => {
      const n = planSpriteScaffold(spriteOpts({ name: "a:b" })) as ScaffoldRejection;
      expect(n.kind).to.equal("invalid-name");
      expect(n.message).to.equal("Invalid name 'a:b' — must not contain ':' (host-dependent on Windows)");
      const s = planSpriteScaffold(spriteOpts({ source: "a:b" })) as ScaffoldRejection;
      expect(s.kind).to.equal("invalid-name");
      expect(s.message).to.equal("Invalid source 'a:b' — must not contain ':' (host-dependent on Windows)");
    });

    it("SI267-R3: accept control — name 'a..b' plans successfully", () => {
      const r = planSpriteScaffold(spriteOpts({ name: "a..b" }));
      expect(r.ok).to.equal(true);
    });

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

  // #262: the plan's image copies are the source objectType's own derived images.
  describe("image copies (#262)", () => {
    it("PR10: a non-PNG single-image source plans its own image, not a name-prefix glob", () => {
      // JPEGTileBackground lives under objectTypes/tiles/ in the fixture and is found there by name.
      const r = planSpriteScaffold(spriteOpts({ source: "JPEGTileBackground", name: "Jpeg2" }));
      expect(r.ok).to.equal(true);
      if (r.ok) {
        expect(r.imageCopies.map((c) => [c.sourceBasename, c.targetBasename])).to.deep.equal([
          ["jpegtilebackground.jpg", "jpeg2.jpg"],
        ]);
      }
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

    it("SI267-R8: layout rejection inputs (empty name/eventSheet, non-.json out, directory source) leave the tree byte-identical", () => {
      const before = snapshotTree(tmp);
      const inputs: Array<Partial<LayoutScaffoldPlanOptions>> = [
        { name: "" },
        { eventSheet: "" },
        { out: "Foo/" },
        { out: "Foo" },
        { out: "Foo.JSON" },
        { out: ".json" },
        { source: "Gameplay" },
      ];
      for (const base of ["layouts", "project-root"] as const) {
        const prefix = base === "layouts" ? "" : "layouts/";
        for (const over of inputs) {
          const o = { ...over };
          if (o.out !== undefined) o.out = prefix + o.out;
          if (o.source !== undefined) o.source = prefix + o.source;
          const r = planLayoutScaffold(layoutOpts(base, o));
          expect(r.ok, `${base} ${JSON.stringify(o)} must be rejected`).to.equal(false);
          expect(snapshotTree(tmp)).to.deep.equal(before);
        }
      }
    });

    it("SI267-R8: sprite rejection inputs (empty name/source, ':' name) leave the tree byte-identical", () => {
      const before = snapshotTree(tmp);
      for (const over of [{ name: "" }, { source: "" }, { name: "a:b" }, { source: "a:b" }]) {
        const r = planSpriteScaffold(spriteOpts(over));
        expect(r.ok, `${JSON.stringify(over)} must be rejected`).to.equal(false);
        expect(snapshotTree(tmp)).to.deep.equal(before);
      }
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
