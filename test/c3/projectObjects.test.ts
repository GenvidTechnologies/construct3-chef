import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { openProject } from "@genvidtech/c3source";
import { readProjectObjects, readLayoutEffects, type ObjectDefn } from "../../src/c3/projectObjects.js";

const ACE_USAGE_ROOT = path.resolve("test/fixtures/addon-ace-usage");
const SAMPLE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

function find(defns: ObjectDefn[], name: string): ObjectDefn | undefined {
  return defns.find((d) => d.name === name);
}

describe("readProjectObjects", () => {
  describe("against the addon-ace-usage fixture", () => {
    const defns = readProjectObjects(openProject(ACE_USAGE_ROOT));

    it("reads Account as an objectType with pluginId GCore and no members", () => {
      const account = find(defns, "Account");
      expect(account).to.deep.equal({
        name: "Account",
        kind: "objectType",
        pluginId: "GCore",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("reads Leaderboard as an objectType with pluginId GCore and no members", () => {
      const leaderboard = find(defns, "Leaderboard");
      expect(leaderboard).to.deep.equal({
        name: "Leaderboard",
        kind: "objectType",
        pluginId: "GCore",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("reads Hero as an objectType with pluginId Sprite and no members", () => {
      const hero = find(defns, "Hero");
      expect(hero).to.deep.equal({
        name: "Hero",
        kind: "objectType",
        pluginId: "Sprite",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("reads GCoreFamily as a family with pluginId GCore and its members", () => {
      const family = find(defns, "GCoreFamily");
      expect(family).to.deep.equal({
        name: "GCoreFamily",
        kind: "family",
        pluginId: "GCore",
        members: ["Account", "Leaderboard"],
        behaviors: [],
        effectTypes: [],
      });
    });
  });

  describe("against the construct3-chef-sample fixture (read-only, addon-agnostic)", () => {
    const defns = readProjectObjects(openProject(SAMPLE_ROOT));

    it("reads NavButton (a nested-free objectType) with pluginId Button", () => {
      const navButton = find(defns, "NavButton");
      expect(navButton).to.deep.equal({
        name: "NavButton",
        kind: "objectType",
        pluginId: "Button",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("reads a nested-subfolder objectType (tiles/JPEGTileBackground) with its pluginId", () => {
      const jpegTileBackground = find(defns, "JPEGTileBackground");
      expect(jpegTileBackground).to.deep.equal({
        name: "JPEGTileBackground",
        kind: "objectType",
        pluginId: "TiledBg",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("reads TextFamily as a family with pluginId Text, its members, and its behaviors", () => {
      const textFamily = find(defns, "TextFamily");
      expect(textFamily).to.deep.equal({
        name: "TextFamily",
        kind: "family",
        pluginId: "Text",
        members: ["Text2", "Text"],
        behaviors: [{ behaviorId: "Timer", name: "Timer" }],
        effectTypes: [],
      });
    });

    it("reads LevelMaps as a family with pluginId TiledBg and its members", () => {
      const levelMaps = find(defns, "LevelMaps");
      expect(levelMaps).to.deep.equal({
        name: "LevelMaps",
        kind: "family",
        pluginId: "TiledBg",
        members: ["JPEGTileBackground"],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("reads Sprite2 (a nested-subfolder objectType) with its two behaviors", () => {
      const sprite2 = find(defns, "Sprite2");
      expect(sprite2).to.deep.equal({
        name: "Sprite2",
        kind: "objectType",
        pluginId: "Sprite",
        members: [],
        behaviors: [
          { behaviorId: "MyCompany_MyBehavior", name: "MyCustomBehavior" },
          { behaviorId: "Persist", name: "Persist" },
        ],
        effectTypes: [{ effectId: "burn", name: "Burn" }],
      });
    });
  });

  describe("behaviorTypes malformed-entry handling", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeObjectType(root: string, fileName: string, json: unknown): void {
      const objectTypesDir = path.join(root, "objectTypes");
      mkdirSync(objectTypesDir, { recursive: true });
      writeFileSync(path.join(objectTypesDir, fileName), JSON.stringify(json, null, "\t") + "\n");
    }

    it("defaults to [] when behaviorTypes is not an array", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-"));
      writeObjectType(tmpDir, "Bad.json", {
        name: "Bad",
        "plugin-id": "Sprite",
        behaviorTypes: "not-an-array",
      });

      const defns = readProjectObjects(openProject(tmpDir));
      const bad = find(defns, "Bad");
      expect(bad).to.deep.equal({
        name: "Bad",
        kind: "objectType",
        pluginId: "Sprite",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("filters out malformed entries (missing name) while keeping valid ones", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-"));
      writeObjectType(tmpDir, "Mixed.json", {
        name: "Mixed",
        "plugin-id": "Sprite",
        behaviorTypes: [
          { behaviorId: "Timer", sid: 1 },
          { behaviorId: "Persist", name: "Persist", sid: 2 },
        ],
      });

      const defns = readProjectObjects(openProject(tmpDir));
      const mixed = find(defns, "Mixed");
      expect(mixed).to.deep.equal({
        name: "Mixed",
        kind: "objectType",
        pluginId: "Sprite",
        members: [],
        behaviors: [{ behaviorId: "Persist", name: "Persist" }],
        effectTypes: [],
      });
    });
  });

  describe("effectTypes reading", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeObjectType(root: string, fileName: string, json: unknown): void {
      const objectTypesDir = path.join(root, "objectTypes");
      mkdirSync(objectTypesDir, { recursive: true });
      writeFileSync(path.join(objectTypesDir, fileName), JSON.stringify(json, null, "\t") + "\n");
    }

    it("reads Sprite2's real effectTypes (burn) from the construct3-chef-sample fixture", () => {
      const defns = readProjectObjects(openProject(SAMPLE_ROOT));
      const sprite2 = find(defns, "Sprite2");
      expect(sprite2?.effectTypes).to.deep.equal([{ effectId: "burn", name: "Burn" }]);
    });

    it("reads TextFamily's empty effectTypes from the construct3-chef-sample fixture", () => {
      const defns = readProjectObjects(openProject(SAMPLE_ROOT));
      const textFamily = find(defns, "TextFamily");
      expect(textFamily?.effectTypes).to.deep.equal([]);
    });

    it("defaults to [] when effectTypes is not an array", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-"));
      writeObjectType(tmpDir, "Bad.json", {
        name: "Bad",
        "plugin-id": "Sprite",
        effectTypes: "not-an-array",
      });

      const defns = readProjectObjects(openProject(tmpDir));
      const bad = find(defns, "Bad");
      expect(bad).to.deep.equal({
        name: "Bad",
        kind: "objectType",
        pluginId: "Sprite",
        members: [],
        behaviors: [],
        effectTypes: [],
      });
    });

    it("filters out malformed effectTypes entries (missing name) while keeping valid ones", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-"));
      writeObjectType(tmpDir, "Mixed.json", {
        name: "Mixed",
        "plugin-id": "Sprite",
        effectTypes: [
          { effectId: "burn", sid: 1 },
          { effectId: "sepia", name: "Sepia", sid: 2 },
        ],
      });

      const defns = readProjectObjects(openProject(tmpDir));
      const mixed = find(defns, "Mixed");
      expect(mixed).to.deep.equal({
        name: "Mixed",
        kind: "objectType",
        pluginId: "Sprite",
        members: [],
        behaviors: [],
        effectTypes: [{ effectId: "sepia", name: "Sepia" }],
      });
    });
  });

  describe("readLayoutEffects", () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeLayout(root: string, fileName: string, json: unknown): void {
      const layoutsDir = path.join(root, "layouts");
      mkdirSync(layoutsDir, { recursive: true });
      writeFileSync(path.join(layoutsDir, fileName), JSON.stringify(json, null, "\t") + "\n");
    }

    it("reads layout-level, layer-level, and deeply-nested sub-layer effects", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-layout-fx-"));
      writeLayout(tmpDir, "Effects.json", {
        name: "Effects",
        effectTypes: [{ effectId: "sepia", name: "Sepia", sid: 1 }],
        layers: [
          {
            name: "layer 0",
            effectTypes: [{ effectId: "burn", name: "Burn", sid: 2 }],
            subLayers: [
              {
                name: "sublayer 0.1",
                effectTypes: [],
                subLayers: [
                  {
                    name: "sublayer 0.1.1",
                    effectTypes: [{ effectId: "glow", name: "Glow", sid: 3 }],
                    subLayers: [],
                  },
                ],
              },
            ],
          },
        ],
      });

      const sites = readLayoutEffects(openProject(tmpDir));
      expect(sites).to.have.length(3);

      expect(sites).to.deep.include({
        effectId: "sepia",
        name: "Sepia",
        container: "layout",
        layout: "Effects",
      });
      expect(sites).to.deep.include({
        effectId: "burn",
        name: "Burn",
        container: "layer",
        layout: "Effects",
        layer: "layer 0",
      });
      // The deepest sub-layer, 3 levels down (layer 0 > sublayer 0.1 > sublayer 0.1.1),
      // proves the recursion doesn't stop at the first level of subLayers.
      expect(sites).to.deep.include({
        effectId: "glow",
        name: "Glow",
        container: "layer",
        layout: "Effects",
        layer: "sublayer 0.1.1",
      });
    });

    it("returns [] for a layout with no effects anywhere", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-layout-fx-"));
      writeLayout(tmpDir, "NoEffects.json", {
        name: "NoEffects",
        effectTypes: [],
        layers: [{ name: "layer 0", effectTypes: [], subLayers: [] }],
      });

      const sites = readLayoutEffects(openProject(tmpDir));
      expect(sites).to.deep.equal([]);
    });

    it("tolerates malformed effectTypes/layers/subLayers without throwing", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "project-objects-layout-fx-"));
      writeLayout(tmpDir, "Malformed.json", {
        name: "Malformed",
        effectTypes: "not-an-array",
        layers: [
          {
            name: "layer 0",
            effectTypes: [{ effectId: "burn", sid: 1 }], // missing name -> dropped
            subLayers: "not-an-array",
          },
          "not-a-layer-object",
        ],
      });

      expect(() => readLayoutEffects(openProject(tmpDir))).to.not.throw();
      const sites = readLayoutEffects(openProject(tmpDir));
      expect(sites).to.deep.equal([]);
    });
  });
});
