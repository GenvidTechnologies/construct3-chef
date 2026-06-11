import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildAddonAceRegistry } from "../../src/c3/aceRegistry.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-sample");

describe("aceRegistry", () => {
  describe("buildAddonAceRegistry", () => {
    // ── Happy-path fixture ──────────────────────────────────────────────────

    it("returns AceEntry[] from the fixture addon (FixtureClock)", () => {
      const entries = buildAddonAceRegistry(FIXTURE_ROOT);
      expect(entries.length).to.be.greaterThan(0);

      // All entries come from FixtureClock
      for (const e of entries) {
        expect(e.objectClass).to.equal("FixtureClock");
        expect(e.source).to.equal("addon");
      }
    });

    it("includes the condition with correct kind and param mapping", () => {
      const entries = buildAddonAceRegistry(FIXTURE_ROOT);
      const cond = entries.find((e) => e.id === "is-elapsed");

      expect(cond).to.not.be.undefined;
      expect(cond!.kind).to.equal("condition");
      expect(cond!.scriptName).to.equal("IsElapsed");
      expect(cond!.params).to.deep.equal([{ name: "duration", type: "number" }]);
    });

    it("includes the action with correct kind and params", () => {
      const entries = buildAddonAceRegistry(FIXTURE_ROOT);
      const act = entries.find((e) => e.id === "set-rate");

      expect(act).to.not.be.undefined;
      expect(act!.kind).to.equal("action");
      expect(act!.scriptName).to.equal("SetRate");
      expect(act!.params).to.deep.equal([
        { name: "rate", type: "number" },
        { name: "unit", type: "string" },
      ]);
    });

    it("includes the expression with scriptName from expressionName field", () => {
      const entries = buildAddonAceRegistry(FIXTURE_ROOT);
      const expr = entries.find((e) => e.id === "elapsed");

      expect(expr).to.not.be.undefined;
      expect(expr!.kind).to.equal("expression");
      expect(expr!.scriptName).to.equal("Elapsed");
      expect(expr!.params).to.deep.equal([{ name: "unit", type: "string" }]);
    });

    // ── No addons dir ───────────────────────────────────────────────────────

    it("returns [] when the project has no addons directory", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ace-reg-empty-"));
      try {
        expect(buildAddonAceRegistry(tmpDir)).to.deep.equal([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // ── Malformed aces.json ─────────────────────────────────────────────────

    it("skips an addon with malformed aces.json and does not throw", () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ace-reg-bad-"));
      try {
        const pluginDir = path.join(tmpDir, "addons", "plugin");
        mkdirSync(pluginDir, { recursive: true });
        // A .c3addon archive placeholder so discoverAddons picks it up
        writeFileSync(path.join(pluginDir, "Bad.c3addon"), "placeholder");
        // Extracted dir with invalid JSON
        const extractedDir = path.join(pluginDir, "Bad");
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(path.join(extractedDir, "aces.json"), "{ not valid json");

        expect(() => buildAddonAceRegistry(tmpDir)).to.not.throw();
        expect(buildAddonAceRegistry(tmpDir)).to.deep.equal([]);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
