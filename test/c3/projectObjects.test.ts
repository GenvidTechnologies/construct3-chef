import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { openProject } from "@genvidtech/c3source";
import { readProjectObjects, type ObjectDefn } from "../../src/c3/projectObjects.js";

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
      expect(account).to.deep.equal({ name: "Account", kind: "objectType", pluginId: "GCore", members: [] });
    });

    it("reads Leaderboard as an objectType with pluginId GCore and no members", () => {
      const leaderboard = find(defns, "Leaderboard");
      expect(leaderboard).to.deep.equal({
        name: "Leaderboard",
        kind: "objectType",
        pluginId: "GCore",
        members: [],
      });
    });

    it("reads Hero as an objectType with pluginId Sprite and no members", () => {
      const hero = find(defns, "Hero");
      expect(hero).to.deep.equal({ name: "Hero", kind: "objectType", pluginId: "Sprite", members: [] });
    });

    it("reads GCoreFamily as a family with pluginId GCore and its members", () => {
      const family = find(defns, "GCoreFamily");
      expect(family).to.deep.equal({
        name: "GCoreFamily",
        kind: "family",
        pluginId: "GCore",
        members: ["Account", "Leaderboard"],
      });
    });
  });

  describe("against the construct3-chef-sample fixture (read-only, addon-agnostic)", () => {
    const defns = readProjectObjects(openProject(SAMPLE_ROOT));

    it("reads NavButton (a nested-free objectType) with pluginId Button", () => {
      const navButton = find(defns, "NavButton");
      expect(navButton).to.deep.equal({ name: "NavButton", kind: "objectType", pluginId: "Button", members: [] });
    });

    it("reads a nested-subfolder objectType (tiles/JPEGTileBackground) with its pluginId", () => {
      const jpegTileBackground = find(defns, "JPEGTileBackground");
      expect(jpegTileBackground).to.deep.equal({
        name: "JPEGTileBackground",
        kind: "objectType",
        pluginId: "TiledBg",
        members: [],
      });
    });

    it("reads TextFamily as a family with pluginId Text and its members", () => {
      const textFamily = find(defns, "TextFamily");
      expect(textFamily).to.deep.equal({
        name: "TextFamily",
        kind: "family",
        pluginId: "Text",
        members: ["Text2", "Text"],
      });
    });

    it("reads LevelMaps as a family with pluginId TiledBg and its members", () => {
      const levelMaps = find(defns, "LevelMaps");
      expect(levelMaps).to.deep.equal({
        name: "LevelMaps",
        kind: "family",
        pluginId: "TiledBg",
        members: ["JPEGTileBackground"],
      });
    });
  });
});
