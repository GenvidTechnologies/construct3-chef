import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { zipSync } from "fflate";
import { validateProjectManifest } from "@genvidtech/c3source";
import {
  applyAddonMetadataSync,
  buildAddonSyncPlan,
  formatAddonMetadataSync,
  planAddonMetadataSync,
  syncAddonMetadata,
  type AddonSyncPlan,
  type AddonSyncResult,
  type AddonSyncRow,
  type AddonSyncStatus,
} from "../../src/c3/addonMetadataSync.js";
import { validateAddons } from "../../src/c3/addonValidator.js";
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");
const SAMPLE_FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

function expectOk(result: AddonSyncResult | { error: string }): AddonSyncResult {
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return result;
}

function expectError(result: AddonSyncResult | { error: string }): string {
  if (!("error" in result)) throw new Error("expected an { error } result, got a success result");
  return result.error;
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

/** Sorted list of every file's path (POSIX, relative to `root`) under `root`. */
function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Every `.c3addon` file's bytes under `root`, keyed by its POSIX-relative path. */
function snapshotAddonPackages(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  for (const relPath of listFilesRecursive(root)) {
    if (relPath.endsWith(".c3addon")) {
      snapshot.set(relPath, readFileSync(path.join(root, ...relPath.split("/"))));
    }
  }
  return snapshot;
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

  // ── applyAddonMetadataSync — P3 write path ──────────────────────────────────
  // All cases here seed drift into a temp COPY of test/fixtures/construct3-chef-sample
  // (never the tracked fixture itself — see seedManifestDrift.ts) using
  // `MyCompany_MyBehavior` (usedAddons[8]) as the anchor entry: its package's
  // addon.json (version 1.0.0.0, author Scirra) matches the PRISTINE manifest entry
  // exactly, so seeding version/author drift and then successfully syncing must
  // reproduce the pristine file byte-for-byte.

  function expectPlanOk(plan: AddonSyncPlan | { error: string }): AddonSyncPlan {
    if ("error" in plan) throw new Error(`unexpected error: ${plan.error}`);
    return plan;
  }

  function makeSeededProject(): string {
    const root = makeTempProject();
    seedManifestDrift(SAMPLE_FIXTURE_ROOT, root, [
      { id: "MyCompany_MyBehavior", version: "0.9.0.0", author: "Nobody" },
    ]);
    return root;
  }

  describe("applyAddonMetadataSync", () => {
    it("T6: byte fidelity — the written file equals the pristine fixture's project.c3proj byte-for-byte", () => {
      const root = makeSeededProject();
      try {
        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        const applyResult = applyAddonMetadataSync(plan);
        expect(applyResult.wrote).to.equal(true);

        const written = readFileSync(path.join(root, "project.c3proj"));
        const pristine = readFileSync(path.join(SAMPLE_FIXTURE_ROOT, "project.c3proj"));
        expect(written.equals(pristine)).to.equal(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T7: sdkVersion (the only field this module doesn't model) survives at its original key position", () => {
      const root = makeSeededProject();
      try {
        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        applyAddonMetadataSync(plan);

        const written = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
        const entry = written.usedAddons[8];
        expect(entry.id).to.equal("MyCompany_MyBehavior");
        expect(entry.sdkVersion).to.equal(2);
        expect(Object.keys(entry)).to.deep.equal(["type", "id", "name", "author", "bundled", "version", "sdkVersion"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T8: unmodeled top-level fields (uniqueId, autosaveData, useWorker, bundleAddons, functionsName) are unchanged", () => {
      const root = makeSeededProject();
      try {
        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        applyAddonMetadataSync(plan);

        const written = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
        const pristine = JSON.parse(readFileSync(path.join(SAMPLE_FIXTURE_ROOT, "project.c3proj"), "utf-8"));

        for (const key of ["uniqueId", "autosaveData", "useWorker", "bundleAddons", "functionsName"]) {
          expect(Object.prototype.hasOwnProperty.call(pristine, key), `fixture is missing '${key}'`).to.equal(true);
          expect(written[key]).to.deep.equal(pristine[key]);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T9: no trailing newline — ends '\\n}' not '}\\n', and the module never appends one", () => {
      const root = makeSeededProject();
      try {
        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        applyAddonMetadataSync(plan);

        const written = readFileSync(path.join(root, "project.c3proj"), "utf-8");
        expect(written.slice(-2)).to.equal("\n}");

        const moduleSource = readFileSync(path.resolve("src/c3/addonMetadataSync.ts"), "utf-8");
        expect(moduleSource).to.not.include('+ "\\n"');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T10: author drift is a {field:'author'} change, restored by apply, and reported by validateAddons on the seeded copy", () => {
      const root = makeSeededProject();
      try {
        const seededValidation = validateAddons(root);
        const authorMismatch = seededValidation.findings.find(
          (f) => f.kind === "metadata-mismatch" && f.addonId === "MyCompany_MyBehavior" && f.field === "author",
        );
        expect(authorMismatch, "expected a metadata-mismatch/author finding on the seeded copy").to.not.be.undefined;

        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        const row = plan.rows.find((r) => r.addonId === "MyCompany_MyBehavior");
        expect(row).to.not.be.undefined;
        expect(row!.status).to.equal("would-change");
        expect(row!.changes).to.deep.include({ field: "author", from: "Nobody", to: "Scirra" });

        applyAddonMetadataSync(plan);
        const written = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
        expect(written.usedAddons[8].author).to.equal("Scirra");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T11: name is never written, even though it differs from the package's display name", () => {
      const root = makeSeededProject();
      try {
        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        const row = plan.rows.find((r) => r.addonId === "MyCompany_MyBehavior");
        expect(row!.changes.some((c) => (c.field as string) === "name")).to.equal(false);

        applyAddonMetadataSync(plan);
        const written = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
        expect(written.usedAddons[8].name).to.equal("MyCustomBehavior");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T12: a blocked (missing-key) row is never applied and the write gains no such key", () => {
      const root = makeTempProject();
      try {
        writeFileSync(
          path.join(root, "project.c3proj"),
          JSON.stringify({
            projectFormatVersion: 1,
            savedWithRelease: 1,
            name: "missing-key-apply-fixture",
            runtime: "c3",
            usedAddons: [{ type: "plugin", id: "NoVersionKey", name: "n", author: "a", bundled: true }],
          }),
        );
        writeAddonPackage(root, "addons/plugin/NoVersionKey.c3addon", {
          id: "NoVersionKey",
          version: "1.0.0.0",
          author: "a",
        });

        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        const row = plan.rows.find((r) => r.addonId === "NoVersionKey");
        expect(row!.status).to.equal("blocked");

        const applyResult = applyAddonMetadataSync(plan);
        expect(applyResult.wrote).to.equal(false);

        const written = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
        expect(Object.prototype.hasOwnProperty.call(written.usedAddons[0], "version")).to.equal(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("no-op run (nothing would-change) does not write the file at all", () => {
      const root = makeTempProject();
      try {
        seedManifestDrift(SAMPLE_FIXTURE_ROOT, root, []); // copy, no drift
        const before = statSync(path.join(root, "project.c3proj")).mtimeMs;

        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        const applyResult = applyAddonMetadataSync(plan);
        expect(applyResult.wrote).to.equal(false);
        expect(applyResult.bytesAfter).to.equal(applyResult.bytesBefore);

        const after = statSync(path.join(root, "project.c3proj")).mtimeMs;
        expect(after).to.equal(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("T14: applying does not change the manifest's validateProjectManifest issue set", () => {
      const root = makeSeededProject();
      try {
        const before = validateProjectManifest(JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8")));
        const beforeIds = before.map((i) => `${i.rule}@${i.path}`).sort();

        const plan = expectPlanOk(buildAddonSyncPlan(root, { direction: "manifest-from-package" }));
        applyAddonMetadataSync(plan);

        const after = validateProjectManifest(JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8")));
        const afterIds = after.map((i) => `${i.rule}@${i.path}`).sort();

        expect(afterIds).to.deep.equal(beforeIds);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ── syncAddonMetadata — P4 orchestrator ─────────────────────────────────────

  describe("syncAddonMetadata", () => {
    describe("T16: package-from-manifest writes nothing anywhere", () => {
      it("leaves project.c3proj bytes+mtime and every .c3addon package byte-identical", () => {
        const root = makeSeededProject();
        try {
          const manifestPath = path.join(root, "project.c3proj");
          const manifestBytesBefore = readFileSync(manifestPath);
          const manifestMtimeBefore = statSync(manifestPath).mtimeMs;
          const filesBefore = listFilesRecursive(root);
          const packagesBefore = snapshotAddonPackages(root);

          const result = expectOk(syncAddonMetadata(root, { direction: "package-from-manifest" }));
          expect(result.wrote).to.equal(false);
          expect(result.dryRun).to.equal(true);
          // Sanity: the seeded drift is actually visible as a would-change row, so this
          // isn't a vacuous "nothing to write anyway" pass.
          expect(rowsByStatus(result, "would-change").map((r) => r.addonId)).to.deep.equal(["MyCompany_MyBehavior"]);

          const manifestBytesAfter = readFileSync(manifestPath);
          const manifestMtimeAfter = statSync(manifestPath).mtimeMs;
          expect(manifestBytesAfter.equals(manifestBytesBefore)).to.equal(true);
          expect(manifestMtimeAfter).to.equal(manifestMtimeBefore);

          const filesAfter = listFilesRecursive(root);
          expect(filesAfter).to.deep.equal(filesBefore);

          const packagesAfter = snapshotAddonPackages(root);
          expect([...packagesAfter.keys()].sort()).to.deep.equal([...packagesBefore.keys()].sort());
          for (const [relPath, before] of packagesBefore) {
            const after = packagesAfter.get(relPath);
            expect(after, `missing package after sync: ${relPath}`).to.not.be.undefined;
            expect(after!.equals(before), `package bytes changed: ${relPath}`).to.equal(true);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    describe("T18: dry-run is inert end-to-end", () => {
      it("touches no bytes/mtime, and its render equals the apply render plus the dry-run trailer", () => {
        const root = makeSeededProject();
        try {
          const manifestPath = path.join(root, "project.c3proj");
          const bytesBefore = readFileSync(manifestPath);
          const mtimeBefore = statSync(manifestPath).mtimeMs;

          const dryRunResult = expectOk(syncAddonMetadata(root, { direction: "manifest-from-package", dryRun: true }));
          expect(dryRunResult.dryRun).to.equal(true);
          expect(dryRunResult.wrote).to.equal(false);

          const bytesAfter = readFileSync(manifestPath);
          const mtimeAfter = statSync(manifestPath).mtimeMs;
          expect(bytesAfter.equals(bytesBefore)).to.equal(true);
          expect(mtimeAfter).to.equal(mtimeBefore);

          const dryRunReport = formatAddonMetadataSync(dryRunResult);
          const nonDryRunReport = formatAddonMetadataSync({ ...dryRunResult, dryRun: false });
          expect(dryRunReport).to.equal(nonDryRunReport + "\nNothing written (dry run).");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    describe("T19: post-condition — zero metadata-mismatch findings after a real sync", () => {
      it("validateAddons reports zero metadata-mismatch findings (pre-existing lang-missing-ace findings untouched)", () => {
        const root = makeSeededProject();
        try {
          // Pre-existing baseline on the pristine sample fixture: 3 `lang-missing-ace`
          // findings, 0 `metadata-mismatch` findings. Scope to metadata-mismatch only —
          // asserting the whole findings array is empty would fail for an unrelated
          // reason (the lang findings), not the one this test exists to check.
          const result = expectOk(syncAddonMetadata(root, { direction: "manifest-from-package" }));
          expect(result.wrote).to.equal(true);

          const validation = validateAddons(root);
          const mismatchFindings = validation.findings.filter((f) => f.kind === "metadata-mismatch");
          expect(mismatchFindings).to.have.lengthOf(0);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    describe("T26: --addon scoping touches only the targeted entry", () => {
      it("scoping to MyCompany_MyBehavior leaves a second drifted entry (MyCompany_MyEffect) untouched", () => {
        const root = makeTempProject();
        try {
          seedManifestDrift(SAMPLE_FIXTURE_ROOT, root, [
            { id: "MyCompany_MyBehavior", version: "0.9.0.0", author: "Nobody" },
            { id: "MyCompany_MyEffect", version: "0.5.0.0", author: "Someone Else" },
          ]);

          const before = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
          const effectEntryBefore = before.usedAddons.find((e: { id: string }) => e.id === "MyCompany_MyEffect");
          expect(effectEntryBefore).to.not.be.undefined;

          const result = expectOk(
            syncAddonMetadata(root, { direction: "manifest-from-package", addon: "MyCompany_MyBehavior" }),
          );
          expect(result.wrote).to.equal(true);
          expect(result.rows.map((r) => r.addonId)).to.deep.equal(["MyCompany_MyBehavior"]);

          const after = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf-8"));
          const behaviorEntryAfter = after.usedAddons.find((e: { id: string }) => e.id === "MyCompany_MyBehavior");
          expect(behaviorEntryAfter.version).to.equal("1.0.0.0");
          expect(behaviorEntryAfter.author).to.equal("Scirra");

          const effectEntryAfter = after.usedAddons.find((e: { id: string }) => e.id === "MyCompany_MyEffect");
          // Untouched — still carries the seeded drift, byte-identical to the pre-sync entry.
          expect(effectEntryAfter).to.deep.equal(effectEntryBefore);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    describe("T27: --addon scoping is id-only", () => {
      it("resolves a discovered addon's resolved id", () => {
        const result = expectOk(
          syncAddonMetadata(FIXTURE_ROOT, { direction: "package-from-manifest", addon: "Complete" }),
        );
        expect(result.rows.map((r) => r.addonId)).to.deep.equal(["Complete"]);
      });

      it("resolves a package filename, with or without the .c3addon extension, even when it differs from the resolved id", () => {
        const bare = expectOk(
          syncAddonMetadata(FIXTURE_ROOT, { direction: "package-from-manifest", addon: "Misnamed" }),
        );
        expect(bare.rows.map((r) => r.addonId)).to.deep.equal(["NotMisnamed"]);

        const withExtension = expectOk(
          syncAddonMetadata(FIXTURE_ROOT, { direction: "package-from-manifest", addon: "Misnamed.c3addon" }),
        );
        expect(withExtension.rows.map((r) => r.addonId)).to.deep.equal(["NotMisnamed"]);
      });

      it("rejects a path-shaped --addon value with the exact error message", () => {
        const result = syncAddonMetadata(FIXTURE_ROOT, {
          direction: "package-from-manifest",
          addon: "addons/plugin/Complete.c3addon",
        });
        expect(expectError(result)).to.equal("--addon takes an addon id, not a path");
      });

      it("rejects a Windows-style path-shaped --addon value too", () => {
        const result = syncAddonMetadata(FIXTURE_ROOT, {
          direction: "package-from-manifest",
          addon: "addons\\plugin\\Complete.c3addon",
        });
        expect(expectError(result)).to.equal("--addon takes an addon id, not a path");
      });

      it("errors cleanly on an unresolvable id, with no manifest read attempted first", () => {
        const result = syncAddonMetadata(FIXTURE_ROOT, {
          direction: "package-from-manifest",
          addon: "NoSuchAddon",
        });
        expect(expectError(result)).to.equal("Addon 'NoSuchAddon' not found");
      });
    });
  });

  describe("formatAddonMetadataSync", () => {
    // Hand-built rows — a pure formatter needs no pipeline run, and hand-built
    // inputs let us cover states the addon-validate fixture doesn't exercise
    // together (a two-field would-change row, an author-only change).
    const rows: AddonSyncRow[] = [
      {
        addonId: "Complete",
        package: "addons/plugin/Complete.c3addon",
        status: "would-change",
        changes: [{ field: "version", from: "1.0.0.9", to: "1.0.0.0" }],
      },
      {
        addonId: "TwoFields",
        package: "addons/plugin/TwoFields.c3addon",
        status: "would-change",
        changes: [
          { field: "version", from: "1.0.0.9", to: "1.0.0.0" },
          { field: "author", from: "Old Author", to: "New Author" },
        ],
      },
      {
        addonId: "CleanControl",
        package: "addons/plugin/CleanControl.c3addon",
        status: "in-sync",
        changes: [],
      },
      {
        addonId: "CorruptZip",
        package: "addons/plugin/CorruptZip.c3addon",
        status: "blocked",
        changes: [],
        reason: "package is unreadable (corrupt archive, malformed zip, or un-materialized LFS pointer)",
      },
      {
        addonId: "Orphan",
        package: "addons/plugin/Orphan.c3addon",
        status: "no-manifest-entry",
        changes: [],
      },
    ];

    function makeResult(overrides: Partial<AddonSyncResult> = {}): AddonSyncResult {
      return {
        direction: "manifest-from-package",
        rows,
        dryRun: true,
        wrote: false,
        manifestIssues: [],
        ...overrides,
      };
    }

    describe("T4: all four statuses, blocked reason, summary", () => {
      it("renders a visually distinguishable line per status", () => {
        const output = formatAddonMetadataSync(makeResult());
        expect(output).to.include("[would-change] Complete");
        expect(output).to.include("[in-sync] CleanControl");
        expect(output).to.include("[blocked] CorruptZip");
        expect(output).to.include("[no-manifest-entry] Orphan");
      });

      it("renders the blocked row's reason", () => {
        const output = formatAddonMetadataSync(makeResult());
        expect(output).to.include(
          "reason: package is unreadable (corrupt archive, malformed zip, or un-materialized LFS pointer)",
        );
      });

      it("summarizes counts for all four states", () => {
        const output = formatAddonMetadataSync(makeResult());
        expect(output).to.include("2 would-change");
        expect(output).to.include("1 in-sync");
        expect(output).to.include("1 blocked");
        expect(output).to.include("1 no-manifest-entry");
      });
    });

    describe("T5: per-field from→to lines", () => {
      it("renders one line with both values for a single-field change", () => {
        const output = formatAddonMetadataSync(makeResult());
        expect(output).to.include("version: '1.0.0.9' → '1.0.0.0'");
      });

      it("renders one line per field for a row changing two fields", () => {
        const output = formatAddonMetadataSync(makeResult());
        const twoFieldsSection = output.slice(output.indexOf("[would-change] TwoFields"));
        expect(twoFieldsSection).to.include("version: '1.0.0.9' → '1.0.0.0'");
        expect(twoFieldsSection).to.include("author: 'Old Author' → 'New Author'");
      });
    });

    describe("T18: dry-run vs apply render", () => {
      it("dry-run output equals apply output plus exactly one trailing line", () => {
        const dryRunOutput = formatAddonMetadataSync(makeResult({ dryRun: true }));
        const applyOutput = formatAddonMetadataSync(makeResult({ dryRun: false, wrote: true }));

        expect(dryRunOutput).to.equal(applyOutput + "\nNothing written (dry run).");
      });
    });

    describe("T31: reformatWarning renders as a note: line", () => {
      const reformatWarning =
        "project.c3proj is not in canonical serialized form — a write will reformat the whole file";

      it("appears in dry-run output", () => {
        const output = formatAddonMetadataSync(makeResult({ dryRun: true, reformatWarning }));
        expect(output).to.include(`note: ${reformatWarning}`);
      });

      it("appears in apply output", () => {
        const output = formatAddonMetadataSync(makeResult({ dryRun: false, wrote: true, reformatWarning }));
        expect(output).to.include(`note: ${reformatWarning}`);
      });
    });

    describe("direction-aware framing", () => {
      it("package-from-manifest reads differently from manifest-from-package for the same rows", () => {
        const manifestFromPackage = formatAddonMetadataSync(makeResult({ direction: "manifest-from-package" }));
        const packageFromManifest = formatAddonMetadataSync(makeResult({ direction: "package-from-manifest" }));

        expect(manifestFromPackage).to.not.equal(packageFromManifest);
        expect(manifestFromPackage).to.include("would update manifest entry");
        expect(packageFromManifest).to.include("re-export it from Construct");
        expect(packageFromManifest).to.not.include("would update manifest entry");
      });

      // `dryRun` is true for BOTH a requested preview and for package-from-manifest,
      // which structurally never writes. Calling the second one a "dry run" would tell
      // the operator to re-run without the flag — which would do the same nothing,
      // since chef has no `.c3addon` writer.
      it("package-from-manifest does not call itself a dry run", () => {
        const output = formatAddonMetadataSync(makeResult({ direction: "package-from-manifest" }));
        expect(output).to.not.include("(dry run)");
        expect(output).to.include("never rewrites a .c3addon");
        expect(output).to.include("Re-export 2 package(s) from Construct.");
      });

      it("package-from-manifest with nothing stale says so, rather than naming a count", () => {
        const inSyncOnly = rows.filter((r) => r.status === "in-sync");
        const output = formatAddonMetadataSync(makeResult({ direction: "package-from-manifest", rows: inSyncOnly }));
        expect(output).to.not.include("(dry run)");
        expect(output).to.include("Nothing written — no package is stale.");
      });

      it("manifest-from-package still uses the dry-run wording", () => {
        const output = formatAddonMetadataSync(makeResult({ direction: "manifest-from-package" }));
        expect(output).to.include("Nothing written (dry run).");
      });
    });

    describe("empty case", () => {
      it("renders something sensible for zero rows, not a bare header", () => {
        const output = formatAddonMetadataSync(makeResult({ rows: [] }));
        expect(output).to.include("No addon packages found to sync.");
      });
    });
  });
});
