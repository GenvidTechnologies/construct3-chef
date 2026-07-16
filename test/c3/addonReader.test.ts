import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { zipSync } from "fflate";
import {
  readAddon,
  readAddonEntry,
  readAddonMetadata,
  readAddonAces,
  listAddonEntries,
  formatAddonInfo,
  formatAddonList,
} from "../../src/c3/addonReader.js";
import { discoverAddons, type DiscoveredAddon } from "../../src/c3/addonDiscovery.js";
import { buildAddonAceRegistry } from "../../src/c3/aceRegistry.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-sample");
const LANG_FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate-lang");

describe("addonReader", () => {
  // ── R1: extracted-dir read ───────────────────────────────────────────────

  it("R1: reads FixtureClock from its extracted directory", () => {
    const info = readAddon(FIXTURE_ROOT, "FixtureClock");
    expect(info).to.not.be.null;
    expect(info!.source).to.equal("extracted");
    expect(info!.kind).to.equal("plugin");
    expect(info!.metadata).to.deep.equal({
      id: "FixtureClock",
      version: "1.0.0.0",
      name: "Fixture Clock",
      author: "construct3-chef fixtures",
      sdkVersion: "2",
      minConstructVersion: "r399",
    });
    expect(info!.aces.length).to.be.greaterThan(0);
    expect(info!.aces.every((a) => a.objectClass === "FixtureClock")).to.be.true;
  });

  // ── R2: zip fallback (archive-only addon) ────────────────────────────────

  it("R2: reads FixtureClockArchived via the zip fallback", () => {
    const info = readAddon(FIXTURE_ROOT, "FixtureClockArchived");
    expect(info).to.not.be.null;
    expect(info!.source).to.equal("archive");
    expect(info!.metadata.id).to.equal("FixtureClockArchived");
    expect(info!.metadata.version).to.equal("1.0.1.0");
    expect(info!.aces.length).to.be.greaterThan(0);
    expect(info!.aces.every((a) => a.objectClass === "FixtureClockArchived")).to.be.true;

    const act = info!.aces.find((a) => a.id === "resync");
    expect(act).to.not.be.undefined;
    expect(act!.kind).to.equal("action");
    expect(act!.scriptName).to.equal("Resync");
  });

  // ── R3: fall-through when the extracted dir exists but lacks addon.json ──

  it("R3: falls through to the zip when the extracted dir lacks addon.json", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-reader-fallthrough-"));
    try {
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      mkdirSync(pluginDir, { recursive: true });

      const zipAddonJson = { id: "FallThrough", version: "9.9.9.9" };
      const zipData = zipSync({
        "addon.json": new TextEncoder().encode(JSON.stringify(zipAddonJson)),
      });
      writeFileSync(path.join(pluginDir, "FallThrough.c3addon"), zipData);

      // Extracted dir exists (so extractedDir !== null) but has no addon.json.
      const extractedDir = path.join(pluginDir, "FallThrough");
      mkdirSync(extractedDir, { recursive: true });
      writeFileSync(path.join(extractedDir, "aces.json"), "{}");

      const addon: DiscoveredAddon = {
        name: "FallThrough",
        kind: "plugin",
        archivePath: path.join(pluginDir, "FallThrough.c3addon"),
        extractedDir,
      };

      const result = readAddonMetadata(addon);
      expect(result).to.not.be.null;
      expect(result!.source).to.equal("archive");
      expect(result!.metadata.id).to.equal("FallThrough");
      expect(result!.metadata.version).to.equal("9.9.9.9");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── R4: missing/malformed addon.json ─────────────────────────────────────

  it("R4: malformed addon.json in the extracted dir yields empty metadata, no throw", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-reader-bad-meta-"));
    try {
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(path.join(pluginDir, "Bad.c3addon"), "placeholder");

      const extractedDir = path.join(pluginDir, "Bad");
      mkdirSync(extractedDir, { recursive: true });
      writeFileSync(path.join(extractedDir, "addon.json"), "{ not valid json");

      const addon: DiscoveredAddon = {
        name: "Bad",
        kind: "plugin",
        archivePath: path.join(pluginDir, "Bad.c3addon"),
        extractedDir,
      };

      expect(() => readAddonMetadata(addon)).to.not.throw();
      const result = readAddonMetadata(addon);
      expect(result).to.not.be.null;
      expect(result!.source).to.equal("extracted");
      expect(result!.metadata).to.deep.equal({});
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("R4: no addon.json anywhere yields null, no throw", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-reader-no-meta-"));
    try {
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(path.join(pluginDir, "NoMeta.c3addon"), "not a zip");

      const addon: DiscoveredAddon = {
        name: "NoMeta",
        kind: "plugin",
        archivePath: path.join(pluginDir, "NoMeta.c3addon"),
        extractedDir: null,
      };

      expect(() => readAddonMetadata(addon)).to.not.throw();
      expect(readAddonMetadata(addon)).to.be.null;

      const info = readAddon(tmpDir, "NoMeta");
      expect(info).to.not.be.null;
      expect(info!.metadata).to.deep.equal({});
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── R5: missing aces.json ────────────────────────────────────────────────

  it("R5: missing aces.json yields [], no throw", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-reader-no-aces-"));
    try {
      const pluginDir = path.join(tmpDir, "addons", "plugin");
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(path.join(pluginDir, "NoAces.c3addon"), "placeholder");

      const extractedDir = path.join(pluginDir, "NoAces");
      mkdirSync(extractedDir, { recursive: true });
      writeFileSync(path.join(extractedDir, "addon.json"), JSON.stringify({ id: "NoAces" }));

      const addon: DiscoveredAddon = {
        name: "NoAces",
        kind: "plugin",
        archivePath: path.join(pluginDir, "NoAces.c3addon"),
        extractedDir,
      };

      expect(() => readAddonAces(addon)).to.not.throw();
      expect(readAddonAces(addon)).to.deep.equal([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── R6: malicious zip entry is inert ─────────────────────────────────────

  it("R6: a zip entry named '../../evil.txt' is inert — exact-name lookup still returns addon.json, nothing written outside the fixture", () => {
    const addon: DiscoveredAddon = {
      name: "FixtureClockMalicious",
      kind: "plugin",
      archivePath: path.join(FIXTURE_ROOT, "addons", "plugin", "FixtureClockMalicious.c3addon"),
      extractedDir: null,
    };

    const text = readAddonEntry(addon, "addon.json");
    expect(text).to.not.be.null;
    const parsed = JSON.parse(text!);
    expect(parsed.id).to.equal("FixtureClockMalicious");

    // The traversal target must not exist anywhere near the fixture tree.
    const traversalTarget = path.resolve(FIXTURE_ROOT, "addons", "plugin", "..", "..", "evil.txt");
    expect(existsSync(traversalTarget)).to.be.false;
    expect(existsSync(path.resolve(FIXTURE_ROOT, "..", "evil.txt"))).to.be.false;
    expect(existsSync(path.resolve(FIXTURE_ROOT, "..", "..", "evil.txt"))).to.be.false;
  });

  // ── R7: aggregate registry still only sees the extracted addon ──────────

  it("R7: buildAddonAceRegistry over the addon-sample root only yields the extracted FixtureClock entries", () => {
    const entries = buildAddonAceRegistry(FIXTURE_ROOT);
    expect(entries.length).to.be.greaterThan(0);
    expect(entries.every((e) => e.objectClass === "FixtureClock")).to.be.true;
    expect(entries.some((e) => e.objectClass === "FixtureClockArchived")).to.be.false;
    expect(entries.some((e) => e.objectClass === "FixtureClockMalicious")).to.be.false;
  });

  // ── R8: shared formatters ─────────────────────────────────────────────────

  it("R8: formatAddonInfo renders the metadata header + ACE lines", () => {
    const info = readAddon(FIXTURE_ROOT, "FixtureClock");
    expect(info).to.not.be.null;

    const expected = [
      "FixtureClock (plugin, extracted)",
      "id: FixtureClock",
      "version: 1.0.0.0",
      "name: Fixture Clock",
      "author: construct3-chef fixtures",
      "sdk-version: 2",
      "min-construct-version: r399",
      "",
      "3 ACE(s)",
      "[addon condition] FixtureClock.is-elapsed(duration)",
      "[addon action] FixtureClock.set-rate(rate, unit)",
      "[addon expression] FixtureClock.elapsed(unit)",
    ].join("\n");

    expect(formatAddonInfo(info!)).to.equal(expected);
  });

  it("R8: formatAddonList renders one sorted line per addon", () => {
    const addons = discoverAddons(FIXTURE_ROOT);
    const output = formatAddonList(addons);

    expect(output).to.equal(
      [
        "FixtureClock  (plugin)  extracted",
        "FixtureClockArchived  (plugin)  archive only",
        "FixtureClockMalicious  (plugin)  archive only",
      ].join("\n"),
    );
  });

  it("R8: formatAddonList owns the empty case (byte-identical across CLI/MCP)", () => {
    expect(formatAddonList([])).to.equal("No addons found.");
  });

  // ── R9: listAddonEntries ──────────────────────────────────────────────────

  describe("listAddonEntries", () => {
    it("R9: zip branch — returns sorted entries under the prefix from the archive", () => {
      const defects: DiscoveredAddon = {
        name: "LangDefects",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "LangDefects.c3addon"),
        extractedDir: null,
      };
      expect(listAddonEntries(defects, "lang/")).to.deep.equal(["lang/en-US.json", "lang/fr-FR.json"]);

      const clean: DiscoveredAddon = {
        name: "LangClean",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "LangClean.c3addon"),
        extractedDir: null,
      };
      expect(listAddonEntries(clean, "lang/")).to.deep.equal(["lang/en-US.json"]);
    });

    it("R9: extracted branch — returns sorted entries under the prefix from the extracted dir", () => {
      const addon: DiscoveredAddon = {
        name: "LangDefects",
        kind: "plugin",
        archivePath: "",
        extractedDir: path.join(LANG_FIXTURE_ROOT, "archive-sources", "LangDefects"),
      };
      expect(listAddonEntries(addon, "lang/")).to.deep.equal(["lang/en-US.json", "lang/fr-FR.json"]);
    });

    it("R9: union/dedup — both sources present yields no duplicates", () => {
      const addon: DiscoveredAddon = {
        name: "LangDefects",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "LangDefects.c3addon"),
        extractedDir: path.join(LANG_FIXTURE_ROOT, "archive-sources", "LangDefects"),
      };
      expect(listAddonEntries(addon, "lang/")).to.deep.equal(["lang/en-US.json", "lang/fr-FR.json"]);
    });

    it("R9: empty result for a prefix present in neither source", () => {
      const addon: DiscoveredAddon = {
        name: "LangDefects",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "LangDefects.c3addon"),
        extractedDir: path.join(LANG_FIXTURE_ROOT, "archive-sources", "LangDefects"),
      };
      expect(listAddonEntries(addon, "nonexistent/")).to.deep.equal([]);
    });

    it("R9: an entry found in only one source is still returned", () => {
      // extractedDir lacks the prefix entirely, zip has it.
      const zipOnly: DiscoveredAddon = {
        name: "LangDefects",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "LangDefects.c3addon"),
        extractedDir: path.join(LANG_FIXTURE_ROOT, "archive-sources", "LangClean"),
      };
      expect(listAddonEntries(zipOnly, "lang/")).to.deep.equal(["lang/en-US.json", "lang/fr-FR.json"]);

      // extractedDir has the prefix, archivePath is bogus/absent.
      const extractedOnly: DiscoveredAddon = {
        name: "LangDefects",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "DoesNotExist.c3addon"),
        extractedDir: path.join(LANG_FIXTURE_ROOT, "archive-sources", "LangDefects"),
      };
      expect(listAddonEntries(extractedOnly, "lang/")).to.deep.equal(["lang/en-US.json", "lang/fr-FR.json"]);
    });

    it("R9: never throws — bogus archivePath, no extractedDir, yields []", () => {
      const addon: DiscoveredAddon = {
        name: "Bogus",
        kind: "plugin",
        archivePath: path.join(LANG_FIXTURE_ROOT, "addons", "plugin", "DoesNotExist.c3addon"),
        extractedDir: null,
      };
      expect(() => listAddonEntries(addon, "lang/")).to.not.throw();
      expect(listAddonEntries(addon, "lang/")).to.deep.equal([]);
    });
  });

  // ── R10: leading UTF-8 BOM is stripped before JSON.parse ─────────────────
  //
  // A real C3-exported addon can ship addon.json/aces.json with a leading
  // U+FEFF BOM; JSON.parse throws on that and the catch swallows it to an
  // empty/null result. readAddonEntryWithSource must strip it first.

  describe("BOM handling", () => {
    const BOM = "﻿";
    const acesJson = {
      timing: {
        conditions: [{ id: "is-elapsed", scriptName: "IsElapsed", params: [{ id: "duration", type: "number" }] }],
        actions: [],
        expressions: [],
      },
    };
    const addonJson = { id: "BomAddon", version: "1.0.0.0", name: "Bom Addon" };

    it("R10: extracted-dir addon.json/aces.json with a leading BOM parses correctly", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-reader-bom-extracted-"));
      try {
        const pluginDir = path.join(tmpDir, "addons", "plugin");
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(path.join(pluginDir, "BomAddon.c3addon"), "placeholder");

        const extractedDir = path.join(pluginDir, "BomAddon");
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(path.join(extractedDir, "addon.json"), BOM + JSON.stringify(addonJson));
        writeFileSync(path.join(extractedDir, "aces.json"), BOM + JSON.stringify(acesJson));

        const addon: DiscoveredAddon = {
          name: "BomAddon",
          kind: "plugin",
          archivePath: path.join(pluginDir, "BomAddon.c3addon"),
          extractedDir,
        };

        const metaResult = readAddonMetadata(addon);
        expect(metaResult).to.not.be.null;
        expect(metaResult!.source).to.equal("extracted");
        expect(metaResult!.metadata).to.deep.equal({ id: "BomAddon", version: "1.0.0.0", name: "Bom Addon" });

        const aces = readAddonAces(addon);
        expect(aces.length).to.equal(1);
        expect(aces[0].id).to.equal("is-elapsed");
        expect(aces[0].kind).to.equal("condition");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("R10: zip-archive addon.json/aces.json with a leading BOM parses correctly", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-reader-bom-archive-"));
      try {
        const pluginDir = path.join(tmpDir, "addons", "plugin");
        mkdirSync(pluginDir, { recursive: true });

        const zipData = zipSync({
          "addon.json": new TextEncoder().encode(BOM + JSON.stringify(addonJson)),
          "aces.json": new TextEncoder().encode(BOM + JSON.stringify(acesJson)),
        });
        writeFileSync(path.join(pluginDir, "BomAddon.c3addon"), zipData);

        const addon: DiscoveredAddon = {
          name: "BomAddon",
          kind: "plugin",
          archivePath: path.join(pluginDir, "BomAddon.c3addon"),
          extractedDir: null,
        };

        const metaResult = readAddonMetadata(addon);
        expect(metaResult).to.not.be.null;
        expect(metaResult!.source).to.equal("archive");
        expect(metaResult!.metadata).to.deep.equal({ id: "BomAddon", version: "1.0.0.0", name: "Bom Addon" });

        const aces = readAddonAces(addon);
        expect(aces.length).to.equal(1);
        expect(aces[0].id).to.equal("is-elapsed");
        expect(aces[0].kind).to.equal("condition");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
