import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { zipSync } from "fflate";
import { planAddonMetadataSync, type AddonSyncResult, type AddonSyncStatus } from "../../src/c3/addonMetadataSync.js";
import { validateAddons } from "../../src/c3/addonValidator.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");

function expectOk(result: AddonSyncResult | { error: string }): AddonSyncResult {
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return result;
}

function rowsByStatus(result: AddonSyncResult, status: AddonSyncStatus) {
  return result.rows.filter((r) => r.status === status);
}

// ── Synthetic temp-dir fixture helpers ──────────────────────────────────────
// Zero fixture churn: every synthetic case below is built at test time in a
// mkdtempSync temp dir, never under test/fixtures/.

function makeTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "addon-metadata-sync-"));
}

function writeManifest(root: string, text: string): void {
  writeFileSync(path.join(root, "project.c3proj"), text);
}

function writeAddonPackage(root: string, relPackagePath: string, addonJson: Record<string, unknown>): void {
  const fullPath = path.join(root, relPackagePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const zipData = zipSync({
    "addon.json": new TextEncoder().encode(JSON.stringify(addonJson)),
  });
  writeFileSync(fullPath, zipData);
}

describe("addonMetadataSync", () => {
  describe("planAddonMetadataSync — T3: four states over the real addon-validate corpus", () => {
    it("classifies all 10 discovered packages", () => {
      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      expect(result.rows).to.have.lengthOf(10);
    });

    it("would-change ×1 — Complete, version 1.0.0.9 → 1.0.0.0", () => {
      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      const wouldChange = rowsByStatus(result, "would-change");
      expect(wouldChange.map((r) => r.addonId)).to.deep.equal(["Complete"]);
      expect(wouldChange[0].changes).to.deep.equal([{ field: "version", from: "1.0.0.9", to: "1.0.0.0" }]);
    });

    it("in-sync ×4 — CleanControl, Dup, NoAcesEffect, NameMismatchBehavior (name ignored, #132)", () => {
      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      const inSync = rowsByStatus(result, "in-sync").map((r) => r.addonId);
      expect([...inSync].sort()).to.deep.equal(["CleanControl", "Dup", "NameMismatchBehavior", "NoAcesEffect"].sort());
    });

    it("blocked ×2 — CorruptZip, LfsPointer (both unreadable)", () => {
      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      const blocked = rowsByStatus(result, "blocked").map((r) => r.addonId);
      expect([...blocked].sort()).to.deep.equal(["CorruptZip", "LfsPointer"]);
    });

    it("no-manifest-entry ×3 — Misnamed (resolves to NotMisnamed), MissingAces, Orphan", () => {
      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      const noEntry = rowsByStatus(result, "no-manifest-entry").map((r) => r.addonId);
      expect([...noEntry].sort()).to.deep.equal(["MissingAces", "NotMisnamed", "Orphan"]);
    });
  });

  describe("T13: tolerant read over a strict-invalid manifest", () => {
    it("runs to completion and surfaces both violated rule ids", () => {
      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      expect(result.manifestIssues).to.include("saved-with-release-number");
      expect(result.manifestIssues).to.include("used-addon-author");
    });
  });

  describe("T15: duality with validateAddons' metadata-mismatch findings", () => {
    // Scope caveat — the two paths agree on this fixture, but they are NOT equivalent
    // by construction. `checkMetadataMismatch` is a read-only *reporter*: it flags any
    // differing field, including on a `bundled:false` (editor-only) entry and on an
    // entry missing the key entirely. `planAddonMetadataSync` is the input to a *write*,
    // so it classifies both of those `blocked` rather than `would-change` — refusing to
    // write into an editor-only entry, and never adding an absent key.
    //
    // The sets coincide here only because `addon-validate`'s single editor-only entry
    // (`EditorOnly`) has no matching package on disk, so the case never arises. If that
    // fixture ever gains an editor-only entry WITH a package and a differing field, this
    // assertion will fail — and that failure would be CORRECT, not a regression. Widen
    // the comparison to exclude blocked rows rather than "fixing" either function.
    it("would-change rows and metadata-mismatch findings name the same (addonId, field) pairs", () => {
      const validation = validateAddons(FIXTURE_ROOT);
      const mismatchPairs = validation.findings
        .filter((f) => f.kind === "metadata-mismatch")
        .map((f) => `${f.addonId}:${f.field}`)
        .sort();

      const result = expectOk(planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package" }));
      const wouldChangePairs = rowsByStatus(result, "would-change")
        .flatMap((r) => r.changes.map((c) => `${r.addonId}:${c.field}`))
        .sort();

      expect(wouldChangePairs).to.deep.equal(mismatchPairs);
      // Sanity: the fixture actually exercises this (a vacuous empty-set equality
      // would pass trivially and prove nothing).
      expect(mismatchPairs.length).to.be.greaterThan(0);
    });
  });

  describe("T29: ambiguous id → single blocked row naming both paths", () => {
    it("collapses two flat-discovered packages resolving to the same id into one blocked row", () => {
      const root = makeTempProject();
      try {
        writeManifest(
          root,
          JSON.stringify({
            projectFormatVersion: 1,
            savedWithRelease: 1,
            name: "ambiguous-fixture",
            runtime: "c3",
            usedAddons: [{ type: "plugin", id: "SameId", name: "n", author: "a", version: "1.0.0.0", bundled: true }],
          }),
        );
        writeAddonPackage(root, "addons/plugin/PkgA.c3addon", { id: "SameId", version: "1.0.0.0" });
        writeAddonPackage(root, "addons/plugin/PkgB.c3addon", { id: "SameId", version: "1.0.0.0" });

        const result = expectOk(planAddonMetadataSync(root, { direction: "manifest-from-package" }));
        const sameIdRows = result.rows.filter((r) => r.addonId === "SameId");
        expect(sameIdRows).to.have.lengthOf(1);
        expect(sameIdRows[0].status).to.equal("blocked");
        expect(sameIdRows[0].reason).to.include("addons/plugin/PkgA.c3addon");
        expect(sameIdRows[0].reason).to.include("addons/plugin/PkgB.c3addon");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("T30: bundled:false (editor-only) entries", () => {
    it("(a) editor-only entry with no matching package on disk produces no row at all", () => {
      const root = makeTempProject();
      try {
        writeManifest(
          root,
          JSON.stringify({
            projectFormatVersion: 1,
            savedWithRelease: 1,
            name: "editor-only-fixture",
            runtime: "c3",
            usedAddons: [{ type: "plugin", id: "EditorOnly", name: "n", bundled: false }],
          }),
        );

        const result = expectOk(planAddonMetadataSync(root, { direction: "manifest-from-package" }));
        expect(result.rows.some((r) => r.addonId === "EditorOnly")).to.equal(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("(b) editor-only entry WITH a matching package on disk is blocked with the editor-only reason", () => {
      const root = makeTempProject();
      try {
        writeManifest(
          root,
          JSON.stringify({
            projectFormatVersion: 1,
            savedWithRelease: 1,
            name: "editor-only-with-package-fixture",
            runtime: "c3",
            usedAddons: [
              { type: "plugin", id: "EditorOnly", name: "n", author: "a", version: "1.0.0.0", bundled: false },
            ],
          }),
        );
        writeAddonPackage(root, "addons/plugin/EditorOnly.c3addon", {
          id: "EditorOnly",
          version: "2.0.0.0",
          author: "a",
        });

        const result = expectOk(planAddonMetadataSync(root, { direction: "manifest-from-package" }));
        const row = result.rows.find((r) => r.addonId === "EditorOnly");
        expect(row).to.not.be.undefined;
        expect(row!.status).to.equal("blocked");
        expect(row!.reason).to.equal(
          "manifest entry declares bundled:false (editor-only) — refusing to write a package version into an editor-only entry",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("missing-key blocked case (T12's classification half)", () => {
    it("blocks a row when the package has a value but the manifest entry has no such key", () => {
      const root = makeTempProject();
      try {
        writeManifest(
          root,
          JSON.stringify({
            projectFormatVersion: 1,
            savedWithRelease: 1,
            name: "missing-key-fixture",
            runtime: "c3",
            // No "version" key on this entry at all (not merely undefined).
            usedAddons: [{ type: "plugin", id: "NoVersionKey", name: "n", author: "a", bundled: true }],
          }),
        );
        writeAddonPackage(root, "addons/plugin/NoVersionKey.c3addon", {
          id: "NoVersionKey",
          version: "1.0.0.0",
          author: "a",
        });

        const result = expectOk(planAddonMetadataSync(root, { direction: "manifest-from-package" }));
        const row = result.rows.find((r) => r.addonId === "NoVersionKey");
        expect(row).to.not.be.undefined;
        expect(row!.status).to.equal("blocked");
        expect(row!.reason).to.equal("manifest entry has no 'version' field — sync overwrites, never adds");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("T31: non-canonical manifest form", () => {
    it("still classifies correctly and sets reformatWarning", () => {
      const root = makeTempProject();
      try {
        // Compact single-line JSON + trailing newline — NOT the canonical tab-indented,
        // no-trailing-newline form `serializeProjectManifest` would produce.
        const manifestObj = {
          projectFormatVersion: 1,
          savedWithRelease: 1,
          name: "noncanonical-fixture",
          runtime: "c3",
          usedAddons: [{ type: "plugin", id: "Compact", name: "n", author: "a", version: "1.0.0.9", bundled: true }],
        };
        writeManifest(root, JSON.stringify(manifestObj) + "\n");
        writeAddonPackage(root, "addons/plugin/Compact.c3addon", {
          id: "Compact",
          version: "1.0.0.0",
          author: "a",
        });

        const result = expectOk(planAddonMetadataSync(root, { direction: "manifest-from-package" }));
        expect(result.reformatWarning).to.not.be.undefined;
        const row = result.rows.find((r) => r.addonId === "Compact");
        expect(row).to.not.be.undefined;
        expect(row!.status).to.equal("would-change");
        expect(row!.changes).to.deep.equal([{ field: "version", from: "1.0.0.9", to: "1.0.0.0" }]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("error path", () => {
    it("returns { error } (never throws) when project.c3proj is missing", () => {
      const root = makeTempProject();
      try {
        const result = planAddonMetadataSync(root, { direction: "manifest-from-package" });
        expect("error" in result).to.equal(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("returns { error } (never throws) when project.c3proj is malformed JSON", () => {
      const root = makeTempProject();
      try {
        writeManifest(root, "{ not json");
        const result = planAddonMetadataSync(root, { direction: "manifest-from-package" });
        expect("error" in result).to.equal(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("opts.addon scoping", () => {
    it("narrows to a single addon by id", () => {
      const result = expectOk(
        planAddonMetadataSync(FIXTURE_ROOT, { direction: "manifest-from-package", addon: "Complete" }),
      );
      expect(result.rows.map((r) => r.addonId)).to.deep.equal(["Complete"]);
    });
  });
});
