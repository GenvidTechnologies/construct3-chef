import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverAddons, findAddonExtractedDir, resolveAddonTarget } from "../../src/c3/addonDiscovery.js";

const LANG_FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate-lang");

describe("addonDiscovery", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── discoverAddons ──────────────────────────────────────────────────────

  describe("discoverAddons", () => {
    it("returns [] when neither addons/plugin nor addons/effect exists", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      expect(discoverAddons(tmpDir)).to.deep.equal([]);
    });

    it("returns [] when addon dirs exist but contain no .c3addon files", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      mkdirSync(path.join(tmpDir, "addons", "plugin"), { recursive: true });
      mkdirSync(path.join(tmpDir, "addons", "effect"), { recursive: true });
      // Write a non-.c3addon file to make sure it's ignored
      writeFileSync(path.join(tmpDir, "addons", "plugin", "readme.txt"), "");
      expect(discoverAddons(tmpDir)).to.deep.equal([]);
    });

    it("discovers a plugin addon archive with no extracted folder", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      mkdirSync(path.join(tmpDir, "addons", "plugin"), { recursive: true });
      const archivePath = path.join(tmpDir, "addons", "plugin", "Foo.c3addon");
      writeFileSync(archivePath, "");

      const addons = discoverAddons(tmpDir);
      expect(addons).to.have.length(1);
      expect(addons[0]).to.deep.equal({
        name: "Foo",
        kind: "plugin",
        archivePath,
        extractedDir: null,
      });
    });

    it("discovers a plugin addon archive with an extracted folder", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      mkdirSync(pluginDir, { recursive: true });
      const archivePath = path.join(pluginDir, "Bar.c3addon");
      writeFileSync(archivePath, "");
      const extractedDir = path.join(pluginDir, "Bar");
      mkdirSync(extractedDir, { recursive: true });

      const addons = discoverAddons(tmpDir);
      expect(addons).to.have.length(1);
      expect(addons[0]).to.deep.equal({
        name: "Bar",
        kind: "plugin",
        archivePath,
        extractedDir,
      });
    });

    it("discovers an effect addon with kind 'effect'", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      const effectDir = path.join(tmpDir, "addons", "effect");
      mkdirSync(effectDir, { recursive: true });
      const archivePath = path.join(effectDir, "Glow.c3addon");
      writeFileSync(archivePath, "");

      const addons = discoverAddons(tmpDir);
      expect(addons).to.have.length(1);
      expect(addons[0]).to.deep.equal({
        name: "Glow",
        kind: "effect",
        archivePath,
        extractedDir: null,
      });
    });

    it("discovers mixed plugin and effect addons", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      const effectDir = path.join(tmpDir, "addons", "effect");
      mkdirSync(pluginDir, { recursive: true });
      mkdirSync(effectDir, { recursive: true });
      writeFileSync(path.join(pluginDir, "MyPlugin.c3addon"), "");
      writeFileSync(path.join(effectDir, "MyEffect.c3addon"), "");

      const addons = discoverAddons(tmpDir);
      expect(addons).to.have.length(2);

      const plugin = addons.find((a) => a.kind === "plugin");
      const effect = addons.find((a) => a.kind === "effect");
      expect(plugin).to.not.be.undefined;
      expect(effect).to.not.be.undefined;
      expect(plugin!.name).to.equal("MyPlugin");
      expect(effect!.name).to.equal("MyEffect");
    });

    it("a directory named *.c3addon is not treated as an archive", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-disc-"));
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      mkdirSync(path.join(pluginDir, "NotArchive.c3addon"), { recursive: true });

      expect(discoverAddons(tmpDir)).to.deep.equal([]);
    });
  });

  // ── findAddonExtractedDir ───────────────────────────────────────────────

  describe("findAddonExtractedDir", () => {
    it("returns null when no addon dirs exist", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      expect(findAddonExtractedDir(tmpDir, "SomeAddon")).to.be.null;
    });

    it("returns null when the named directory does not exist", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      mkdirSync(path.join(tmpDir, "addons", "plugin"), { recursive: true });
      expect(findAddonExtractedDir(tmpDir, "Missing")).to.be.null;
    });

    it("finds a directory under addons/plugin", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      const expectedPath = path.join(tmpDir, "addons", "plugin", "Bar");
      mkdirSync(expectedPath, { recursive: true });

      expect(findAddonExtractedDir(tmpDir, "Bar")).to.equal(expectedPath);
    });

    it("finds a directory under addons/effect", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      const expectedPath = path.join(tmpDir, "addons", "effect", "Glow");
      mkdirSync(expectedPath, { recursive: true });

      expect(findAddonExtractedDir(tmpDir, "Glow")).to.equal(expectedPath);
    });

    it("prefers addons/plugin over addons/effect when both exist", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      const pluginPath = path.join(tmpDir, "addons", "plugin", "Shared");
      const effectPath = path.join(tmpDir, "addons", "effect", "Shared");
      mkdirSync(pluginPath, { recursive: true });
      mkdirSync(effectPath, { recursive: true });

      expect(findAddonExtractedDir(tmpDir, "Shared")).to.equal(pluginPath);
    });

    it("does NOT require a matching .c3addon archive — directory alone suffices", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      // No .c3addon file, only the directory
      const dirPath = path.join(tmpDir, "addons", "plugin", "NoArchive");
      mkdirSync(dirPath, { recursive: true });

      expect(findAddonExtractedDir(tmpDir, "NoArchive")).to.equal(dirPath);
    });

    it("returns null when name matches a FILE not a directory", () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-find-"));
      mkdirSync(path.join(tmpDir, "addons", "plugin"), { recursive: true });
      // Write a file with the addon name (no extension), not a dir
      writeFileSync(path.join(tmpDir, "addons", "plugin", "FileNotDir"), "");

      expect(findAddonExtractedDir(tmpDir, "FileNotDir")).to.be.null;
    });
  });

  // ── resolveAddonTarget ──────────────────────────────────────────────────

  describe("resolveAddonTarget", () => {
    it("id-mode: resolves a discovered addon by name", () => {
      const addon = resolveAddonTarget(LANG_FIXTURE_ROOT, "LangDefects");
      expect(addon).to.not.be.null;
      expect(addon!.name).to.equal("LangDefects");
      expect(addon!.kind).to.equal("plugin");
      expect(addon!.archivePath.endsWith(path.join("LangDefects.c3addon"))).to.be.true;
      expect(addon!.extractedDir).to.be.null;
    });

    it("path-mode: resolves a project-root-contained source-tree directory", () => {
      const addon = resolveAddonTarget(LANG_FIXTURE_ROOT, "archive-sources/LangDefects");
      expect(addon).to.not.be.null;
      expect(addon!.extractedDir!.endsWith(path.join("archive-sources", "LangDefects"))).to.be.true;
      expect(addon!.archivePath).to.equal("");
      expect(addon!.name).to.equal("LangDefects");
      expect(addon!.kind).to.equal("plugin");
    });

    it("path-mode: classifies kind from addon.json's type field", () => {
      const defects = resolveAddonTarget(LANG_FIXTURE_ROOT, "archive-sources/LangDefects");
      const clean = resolveAddonTarget(LANG_FIXTURE_ROOT, "archive-sources/LangClean");
      expect(defects!.kind).to.equal("plugin");
      expect(clean!.kind).to.equal("plugin");
    });

    it("returns null when the path argument escapes the project root", () => {
      expect(resolveAddonTarget(LANG_FIXTURE_ROOT, "../../../etc")).to.be.null;
    });

    it("returns null when neither id-mode nor path-mode resolves", () => {
      expect(resolveAddonTarget(LANG_FIXTURE_ROOT, "DoesNotExist")).to.be.null;
    });
  });
});
