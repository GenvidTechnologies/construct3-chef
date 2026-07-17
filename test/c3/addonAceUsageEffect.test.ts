import { describe, it, after } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanAddonUsage,
  scanEffectUsage,
  formatAddonUsage,
  type AddonUsageResult,
  type EffectSite,
} from "../../src/c3/addonAceUsage.js";
import { resolveAddonTarget, type DiscoveredAddon } from "../../src/c3/addonDiscovery.js";
import { readProjectObjects } from "../../src/c3/projectObjects.js";
import { openProject } from "@genvidtech/c3source";

// ── Synthetic project + path-mode effect addon ─────────────────────────────
//
// scanEffectUsage takes an already-resolved DiscoveredAddon (callers get one
// from resolveAddonTarget), so these tests build a temp project root with:
//   - objectTypes/Foo.json:   effectTypes [MyEffect "MyGlow", OtherEffect "Other"]
//   - families/FooFamily.json: effectTypes [MyEffect "FamGlow"]
//   - layouts/Level1.json:    layout-level [MyEffect "LayoutGlow"],
//                             layer "Layer0" [MyEffect "LayerGlow"],
//                             nested sub-layer "Sub0.1" [MyEffect "SubGlow"]
//   - addon-src/MyEffect/addon.json: {type: "effect", id: "MyEffect"} — a
//     path-mode addon source tree, no .c3addon/aces.json needed (effects
//     have no ACEs).
//
// "OtherEffect" on Foo is the unrelated-effect-id negative case: it must
// never appear in MyEffect's effectSites.

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "addon-ace-usage-effect-"));

function writeJson(root: string, subdir: string, fileName: string, json: unknown): void {
  const dir = path.join(root, subdir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), JSON.stringify(json, null, "\t") + "\n");
}

writeJson(TMP_ROOT, "objectTypes", "Foo.json", {
  name: "Foo",
  "plugin-id": "Sprite",
  effectTypes: [
    { effectId: "MyEffect", name: "MyGlow", sid: 1 },
    { effectId: "OtherEffect", name: "Other", sid: 2 },
  ],
});

writeJson(TMP_ROOT, "families", "FooFamily.json", {
  name: "FooFamily",
  "plugin-id": "Sprite",
  members: ["Foo"],
  effectTypes: [{ effectId: "MyEffect", name: "FamGlow", sid: 3 }],
});

writeJson(TMP_ROOT, "layouts", "Level1.json", {
  name: "Level1",
  effectTypes: [{ effectId: "MyEffect", name: "LayoutGlow", sid: 4 }],
  layers: [
    {
      name: "Layer0",
      effectTypes: [{ effectId: "MyEffect", name: "LayerGlow", sid: 5 }],
      subLayers: [
        {
          name: "Sub0.1",
          effectTypes: [{ effectId: "MyEffect", name: "SubGlow", sid: 6 }],
          subLayers: [],
        },
      ],
    },
  ],
});

writeJson(TMP_ROOT, "addon-src/MyEffect", "addon.json", {
  type: "effect",
  id: "MyEffect",
  name: "My Effect",
});

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function resolveMyEffectTarget(): DiscoveredAddon {
  const target = resolveAddonTarget(TMP_ROOT, "addon-src/MyEffect");
  expect(target).to.not.be.null;
  return target as DiscoveredAddon;
}

function ok(result: ReturnType<typeof scanEffectUsage>): AddonUsageResult {
  expect("error" in result).to.be.false;
  return result as AddonUsageResult;
}

describe("scanEffectUsage", () => {
  it("resolves the path-mode addon.json as an effect target", () => {
    const target = resolveMyEffectTarget();
    expect(target.kind).to.equal("effect");
    expect(target.name).to.equal("MyEffect");
  });

  it("finds all four application sites (objectType, family, layout, layer) plus the nested sub-layer", () => {
    const target = resolveMyEffectTarget();
    const result = ok(scanEffectUsage(TMP_ROOT, target));

    expect(result.kind).to.equal("effect");
    expect(result.addonId).to.equal("MyEffect");
    expect(result.presence).to.deep.equal([]);
    expect(result.callSites).to.deep.equal([]);
    expect(result.aces).to.deep.equal([]);

    const sites = result.effectSites ?? [];
    expect(sites).to.have.length(5);

    expect(sites).to.deep.include({ effectId: "MyEffect", name: "MyGlow", container: "objectType", host: "Foo" });
    expect(sites).to.deep.include({
      effectId: "MyEffect",
      name: "FamGlow",
      container: "family",
      host: "FooFamily",
    });
    expect(sites).to.deep.include({
      effectId: "MyEffect",
      name: "LayoutGlow",
      container: "layout",
      host: "Level1",
    });
    expect(sites).to.deep.include({
      effectId: "MyEffect",
      name: "LayerGlow",
      container: "layer",
      host: "Level1",
      layer: "Layer0",
    });
    expect(sites).to.deep.include({
      effectId: "MyEffect",
      name: "SubGlow",
      container: "layer",
      host: "Level1",
      layer: "Sub0.1",
    });
  });

  it("never matches the unrelated OtherEffect id present in the same fixture", () => {
    const target = resolveMyEffectTarget();
    const result = ok(scanEffectUsage(TMP_ROOT, target));
    const names = (result.effectSites ?? []).map((s) => s.name);
    expect(names).to.not.include("Other");
  });

  it("sorts sites objectType -> family -> layout -> layer, and by name within the layer group", () => {
    const target = resolveMyEffectTarget();
    const result = ok(scanEffectUsage(TMP_ROOT, target));
    const containers = (result.effectSites ?? []).map((s) => s.container);
    expect(containers).to.deep.equal(["objectType", "family", "layout", "layer", "layer"]);

    const layerNames = (result.effectSites ?? []).filter((s) => s.container === "layer").map((s) => s.layer);
    expect(layerNames).to.deep.equal(["Layer0", "Sub0.1"]);
  });

  describe("--from blast radius", () => {
    it("affectedCount equals effectSites.length (every site is exposed by a version bump)", () => {
      const target = resolveMyEffectTarget();
      const result = ok(scanEffectUsage(TMP_ROOT, target, "addon-src/MyEffect"));

      expect(result.blast).to.not.be.undefined;
      expect(result.blast?.changedKeys).to.deep.equal([]);
      expect(result.blast?.removedKeys).to.deep.equal([]);
      expect(result.blast?.affectedCount).to.equal((result.effectSites ?? []).length);
      expect(result.blast?.fromLabel).to.equal("MyEffect");
    });

    it("an unresolvable --from source returns an error, never throws", () => {
      const target = resolveMyEffectTarget();
      expect(() => scanEffectUsage(TMP_ROOT, target, "NoSuchSource")).to.not.throw();
      const result = scanEffectUsage(TMP_ROOT, target, "NoSuchSource");
      expect(result).to.deep.equal({ error: "addon source not found: NoSuchSource" });
    });

    it("every rendered site line carries the exposed marker when blast is present", () => {
      const target = resolveMyEffectTarget();
      const result = scanEffectUsage(TMP_ROOT, target, "addon-src/MyEffect");
      const output = formatAddonUsage(result);

      const siteLines = output.split("\n").filter((l) => l.includes("["));
      expect(siteLines.length).to.be.greaterThan(0);
      for (const line of siteLines) {
        expect(line).to.include("⚠ exposed");
      }
    });
  });
});

// ── formatAddonUsage — effect branch (synthetic results) ───────────────────

describe("formatAddonUsage — effect scan", () => {
  it("renders a header, summary, and grouped sections for a non-empty effect result", () => {
    const result: AddonUsageResult = {
      addonId: "MyEffect",
      addonLabel: "MyEffect",
      presence: [],
      callSites: [],
      aces: [],
      kind: "effect",
      effectSites: [
        { effectId: "MyEffect", name: "MyGlow", container: "objectType", host: "Foo" },
        { effectId: "MyEffect", name: "FamGlow", container: "family", host: "FooFamily" },
        { effectId: "MyEffect", name: "LayoutGlow", container: "layout", host: "Level1" },
        { effectId: "MyEffect", name: "LayerGlow", container: "layer", host: "Level1", layer: "Layer0" },
      ],
    };

    const output = formatAddonUsage(result);
    expect(output).to.include("scan-addon-usage: MyEffect (effect)");
    expect(output).to.include("applied at 4 site(s)");
    expect(output).to.include("Object types:");
    expect(output).to.include("Foo   [MyGlow]");
    expect(output).to.include("Families:");
    expect(output).to.include("FooFamily   [FamGlow]");
    expect(output).to.include("Layouts:");
    expect(output).to.include("Level1 (layout stack)   [LayoutGlow]");
    expect(output).to.include("Level1 / Layer0   [LayerGlow]");
    expect(output).to.not.include("⚠ exposed");
  });

  it("renders the standard empty-usage sentence when effectSites is empty", () => {
    const empty: AddonUsageResult = {
      addonId: "NowhereEffect",
      addonLabel: "NowhereEffect",
      presence: [],
      callSites: [],
      aces: [],
      kind: "effect",
      effectSites: [],
    };
    expect(formatAddonUsage(empty)).to.equal('No usage of addon "NowhereEffect" found.');
  });

  it("renders the same empty-usage sentence when effectSites is entirely absent", () => {
    const empty: AddonUsageResult = {
      addonId: "NowhereEffect",
      addonLabel: "NowhereEffect",
      presence: [],
      callSites: [],
      aces: [],
      kind: "effect",
    };
    expect(formatAddonUsage(empty)).to.equal('No usage of addon "NowhereEffect" found.');
  });

  it("renders the blast radius header + per-site exposed markers", () => {
    const blastResult: AddonUsageResult = {
      addonId: "MyEffect",
      addonLabel: "MyEffect",
      presence: [],
      callSites: [],
      aces: [],
      kind: "effect",
      effectSites: [{ effectId: "MyEffect", name: "MyGlow", container: "objectType", host: "Foo" }],
      blast: { fromLabel: "MyEffectOld", changedKeys: [], removedKeys: [], affectedCount: 1 },
    };
    const output = formatAddonUsage(blastResult);
    expect(output).to.include("blast radius (vs MyEffectOld): 1 site(s) affected by version bump");
    expect(output).to.include("Foo   [MyGlow] ⚠ exposed");
  });
});

// ── Public dispatch (F1 wiring) ────────────────────────────────────────────
//
// The PUBLIC scanAddonUsage dispatch routes an effect target straight to
// scanEffectUsage (short-circuiting the ACE read + event walk before they
// run, since effects have neither). So the public entry point yields the
// same populated effectSites as calling scanEffectUsage directly.

describe("scanAddonUsage — effect target (public dispatch)", () => {
  it("routes an effect addon to scanEffectUsage, returning the populated effectSites", () => {
    const result = scanAddonUsage(TMP_ROOT, "addon-src/MyEffect");
    expect("error" in result).to.be.false;
    const okResult = result as AddonUsageResult;

    expect(okResult.kind).to.equal("effect");
    expect(okResult.effectSites ?? []).to.have.length(5);
    expect(okResult.presence).to.deep.equal([]);
    expect(okResult.callSites).to.deep.equal([]);
    // The unrelated OtherEffect on Foo is never surfaced for MyEffect.
    expect((okResult.effectSites ?? []).some((s: EffectSite) => s.name === "Other")).to.be.false;
  });

  it("formatAddonUsage renders the real application sites, not the empty sentence", () => {
    const result = scanAddonUsage(TMP_ROOT, "addon-src/MyEffect");
    const output = formatAddonUsage(result);
    expect(output).to.not.equal('No usage of addon "MyEffect" found.');
    expect(output).to.contain("Object types:");
    expect(output).to.contain("MyGlow");
  });
});

// ── Real-fixture integration (construct3-chef-sample, discovered addon id) ─
//
// The describe blocks above already cover scanEffectUsage/formatAddonUsage
// mechanics (incl. the R7 empty-usage case, see "formatAddonUsage — effect
// scan" > "renders the standard empty-usage sentence...") against a temp-dir
// project and a PATH-mode addon (`resolveAddonTarget(TMP_ROOT,
// "addon-src/MyEffect")`). This block instead resolves the addon by its
// DISCOVERED id ("MyCompany_MyEffect") against the real
// `construct3-chef-sample` fixture — the end-to-end path a real
// `scan-addon-usage --addon MyCompany_MyEffect` CLI/MCP call takes (through
// `discoverAddons`), which the synthetic tests above don't exercise.
//
// Fixture sites (read-only — construct3-chef-sample is golden-diffed, never
// mutated by this file):
//   - objectTypes/images/Sprite2.json: effectTypes ["burn" (unrelated
//     built-in, negative case), "MyCompany_MyEffect"]
//   - families/TextFamily.json: effectTypes ["MyCompany_MyEffect"]
//   - layouts/Second Layout.json: top-level effectTypes
//     ["MyCompany_MyEffect"] AND, nested two levels deep (layer 1 ->
//     sublayer 1.1 -> sublayer 1.1.1), a layer-level "MyCompany_MyEffect" —
//     the real-fixture proof of the recursive subLayers walk.

const SAMPLE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

describe("scanAddonUsage — effect addon (against construct3-chef-sample, discovered id)", () => {
  it("R1: objectType site — Sprite2 carries the effect", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    expect(result.effectSites ?? []).to.deep.include({
      effectId: "MyCompany_MyEffect",
      name: "My custom effect",
      container: "objectType",
      host: "Sprite2",
    });
  });

  it("R2: family site — TextFamily carries the effect", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    expect(result.effectSites ?? []).to.deep.include({
      effectId: "MyCompany_MyEffect",
      name: "My custom effect",
      container: "family",
      host: "TextFamily",
    });
  });

  it("R3: layout-level site — Second Layout's top-level effectTypes, no `layer` key", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    expect(result.effectSites ?? []).to.deep.include({
      effectId: "MyCompany_MyEffect",
      name: "My custom effect",
      container: "layout",
      host: "Second Layout",
    });
  });

  it("R4/R5: layer site incl. nested recursion two levels deep — layer 1 -> sublayer 1.1 -> sublayer 1.1.1", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    expect(result.effectSites ?? []).to.deep.include({
      effectId: "MyCompany_MyEffect",
      name: "My custom effect",
      container: "layer",
      host: "Second Layout",
      layer: "sublayer 1.1.1",
    });
  });

  it("R6: the unrelated built-in 'burn' effect on Sprite2 is never matched by the MyCompany_MyEffect scan", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    const sites = result.effectSites ?? [];
    expect(sites.some((s) => s.effectId === "burn" || s.name === "Burn")).to.be.false;

    // readProjectObjects itself DOES see "burn" on Sprite2 — it's the effect
    // scan's own effectId filter (scanEffectUsage's `if (e.effectId !==
    // addonId) continue;`) that excludes it, not an upstream reader gap.
    const objects = readProjectObjects(openProject(SAMPLE_ROOT));
    const sprite2 = objects.find((d) => d.name === "Sprite2");
    expect(sprite2?.effectTypes).to.deep.include({ effectId: "burn", name: "Burn" });
  });

  it("R8: 'burn' is a C3 built-in effect with no discoverable addon package — scan returns the standard error", () => {
    expect(() => scanAddonUsage(SAMPLE_ROOT, "burn")).to.not.throw();
    const result = scanAddonUsage(SAMPLE_ROOT, "burn");
    expect(result).to.deep.equal({ error: "addon source not found: burn" });
  });

  describe("--from blast radius (real fixture, path-mode --from against the extracted addon source tree)", () => {
    const FROM_SOURCE = path.join("archive-sources", "MyCompany_MyEffect");

    it("R9: affectedCount equals effectSites.length; every rendered site line carries ' ⚠ exposed'", () => {
      const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect", FROM_SOURCE));

      expect(result.blast).to.not.be.undefined;
      expect(result.blast?.changedKeys).to.deep.equal([]);
      expect(result.blast?.removedKeys).to.deep.equal([]);
      expect(result.blast?.affectedCount).to.equal((result.effectSites ?? []).length);
      expect(result.blast?.affectedCount).to.equal(4);

      const output = formatAddonUsage(result);
      const siteLines = output.split("\n").filter((l) => l.includes("["));
      expect(siteLines.length).to.equal(4);
      for (const line of siteLines) {
        expect(line).to.include("⚠ exposed");
      }
    });

    it("R10: the CLI exit-code decision (result.blast !== undefined && affectedCount > 0) is true for this scan", () => {
      const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect", FROM_SOURCE));
      expect(result.blast !== undefined && result.blast.affectedCount > 0).to.be.true;
    });
  });

  it("R11: formatAddonUsage renders deterministic, container-grouped sections naming every host + the applied effect", () => {
    const first = formatAddonUsage(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    const second = formatAddonUsage(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyEffect"));
    expect(first).to.equal(second);

    expect(first).to.equal(
      [
        "scan-addon-usage: MyCompany_MyEffect (effect)",
        "applied at 4 site(s)",
        "",
        "Object types:",
        "  Sprite2   [My custom effect]",
        "",
        "Families:",
        "  TextFamily   [My custom effect]",
        "",
        "Layouts:",
        "  Second Layout (layout stack)   [My custom effect]",
        "  Second Layout / sublayer 1.1.1   [My custom effect]",
      ].join("\n"),
    );
  });

  // R7 (the empty-usage case) stays covered SYNTHETICALLY — see
  // "formatAddonUsage — effect scan" > "renders the standard empty-usage
  // sentence when effectSites is empty" above. construct3-chef-sample bundles
  // only ONE effect addon and it IS applied at all four sites, so there's no
  // real resolvable-but-unapplied effect to drive an empty case against the
  // real fixture without adding a second effect-addon package purely for
  // this — not worth the fixture churn.
});
