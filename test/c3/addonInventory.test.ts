import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { listAddons, formatAddonInventory, type AddonStatus } from "../../src/c3/addonInventory.js";

// Reuses the shared `addon-validate` fixture (a read-only tool, so no golden or
// mutation risk). NB: this couples the expected inventory to that fixture's
// packages + project.c3proj — a future validate-addons fixture change must
// re-bless the assertions below.
const FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");

function idsWithStatus(root: string, status: AddonStatus): string[] {
  return listAddons(root)
    .rows.filter((r) => r.status === status)
    .map((r) => r.id);
}

describe("addonInventory", () => {
  it("lists every disk + manifest addon as one row per id, sorted", () => {
    const { rows } = listAddons(FIXTURE_ROOT);
    const ids = rows.map((r) => r.id);
    expect(ids).to.deep.equal([
      "CleanControl",
      "Complete",
      "CorruptZip",
      "Dup",
      "EditorOnly",
      "LfsPointer",
      "MissingAces",
      "MissingPkg",
      "NoAcesEffect",
      "NotMisnamed",
      "Orphan",
    ]);
    // sorted by id
    expect(ids).to.deep.equal([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("classifies bundled = declared in usedAddons AND on disk", () => {
    expect(idsWithStatus(FIXTURE_ROOT, "bundled")).to.deep.equal(["CleanControl", "Complete", "Dup", "NoAcesEffect"]);
  });

  it("classifies orphan = on disk, absent from usedAddons", () => {
    expect(idsWithStatus(FIXTURE_ROOT, "orphan")).to.deep.equal([
      "CorruptZip",
      "LfsPointer",
      "MissingAces",
      "NotMisnamed",
      "Orphan",
    ]);
  });

  it("classifies missing = usedAddons bundled:true with no package on disk", () => {
    expect(idsWithStatus(FIXTURE_ROOT, "missing")).to.deep.equal(["MissingPkg"]);
  });

  it("classifies editor-only = usedAddons bundled:false", () => {
    expect(idsWithStatus(FIXTURE_ROOT, "editor-only")).to.deep.equal(["EditorOnly"]);
  });

  it("shows the manifest version for a bundled addon (not the drifted package version)", () => {
    const complete = listAddons(FIXTURE_ROOT).rows.find((r) => r.id === "Complete");
    // package addon.json is 1.0.0.0 but project.c3proj records 1.0.0.9 — the
    // inventory shows the declared version; the mismatch is validate-addons' job.
    expect(complete?.version).to.equal("1.0.0.9");
  });

  it("carries the manifest version for a missing addon", () => {
    const missing = listAddons(FIXTURE_ROOT).rows.find((r) => r.id === "MissingPkg");
    expect(missing?.version).to.equal("3.2.1.0");
  });

  it("leaves version undefined when an orphan's archive can't be read", () => {
    const corrupt = listAddons(FIXTURE_ROOT).rows.find((r) => r.id === "CorruptZip");
    expect(corrupt?.version).to.equal(undefined);
    expect(corrupt?.packagePath).to.equal("addons/plugin/CorruptZip.c3addon");
  });

  it("keys on the addon.json id, not the filename, when they diverge", () => {
    const misnamed = listAddons(FIXTURE_ROOT).rows.find((r) => r.id === "NotMisnamed");
    expect(misnamed?.status).to.equal("orphan");
    expect(misnamed?.packagePath).to.equal("addons/plugin/Misnamed.c3addon");
  });

  describe("formatAddonInventory", () => {
    it("renders the empty case", () => {
      expect(formatAddonInventory({ rows: [] })).to.equal("No addons found.");
    });

    it("renders per-status line shapes", () => {
      const text = formatAddonInventory(listAddons(FIXTURE_ROOT));
      const lines = text.split("\n");
      expect(lines[0]).to.equal("11 addon(s):");
      expect(lines).to.include("  CleanControl  bundled  2.3.4.5  addons/plugin/CleanControl.c3addon");
      expect(lines).to.include("  NoAcesEffect  bundled  1.0.0.0  addons/effect/NoAcesEffect.c3addon");
      expect(lines).to.include("  EditorOnly  editor-only  —");
      expect(lines).to.include("  MissingPkg  missing  3.2.1.0  (declared bundled, no package on disk)");
      expect(lines).to.include("  Orphan  orphan  1.0.0.0  addons/plugin/Orphan.c3addon (not in project.c3proj)");
      expect(lines).to.include("  CorruptZip  orphan  —  addons/plugin/CorruptZip.c3addon (not in project.c3proj)");
    });
  });
});
