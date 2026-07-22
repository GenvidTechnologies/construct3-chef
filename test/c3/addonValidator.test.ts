import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { validateAddons, formatAddonValidation, type AddonFinding } from "../../src/c3/addonValidator.js";
import { resolveAddonTarget } from "../../src/c3/addonDiscovery.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");
const LANG_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/addon-validate-lang");

function findingsFor(findings: AddonFinding[], pkg: string): AddonFinding[] {
  return findings.filter((f) => f.package === pkg);
}

describe("addonValidator", () => {
  it("checks all 9 fixture packages", () => {
    const result = validateAddons(FIXTURE_ROOT);
    expect(result.checked).to.equal(9);
  });

  it("Complete.c3addon: exactly one version metadata-mismatch against project.c3proj", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/Complete.c3addon");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0]).to.deep.equal({
      package: "addons/plugin/Complete.c3addon",
      addonId: "Complete",
      kind: "metadata-mismatch",
      field: "version",
      packageValue: "1.0.0.0",
      manifestValue: "1.0.0.9",
    });
  });

  it("CleanControl.c3addon: no findings (clean packages are silent)", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/CleanControl.c3addon");
    expect(findings).to.have.lengthOf(0);
  });

  it("Misnamed.c3addon: one integrity finding for the id/filename mismatch", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/Misnamed.c3addon");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0].kind).to.equal("integrity");
    expect(findings[0].problem).to.match(/NotMisnamed/);
    expect(findings[0].problem).to.match(/Misnamed/);
  });

  it("MissingAces.c3addon: one integrity finding for the missing aces.json entry", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/MissingAces.c3addon");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0].kind).to.equal("integrity");
    expect(findings[0].problem).to.match(/aces\.json/);
  });

  it("CorruptZip.c3addon: one integrity finding for the malformed zip", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/CorruptZip.c3addon");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0].kind).to.equal("integrity");
    expect(findings[0].problem).to.match(/malformed zip/);
  });

  it("LfsPointer.c3addon: one integrity finding for the un-materialized LFS pointer", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/LfsPointer.c3addon");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0].kind).to.equal("integrity");
    expect(findings[0].problem).to.match(/LFS pointer/);
  });

  it("Orphan.c3addon: exactly one orphan finding", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/plugin/Orphan.c3addon");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0]).to.deep.equal({
      package: "addons/plugin/Orphan.c3addon",
      addonId: "Orphan",
      kind: "orphan",
      problem: "on disk but not in project.c3proj usedAddons",
    });
  });

  it("Dup: exactly one duplicate finding listing both sorted packages", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = result.findings.filter((f) => f.kind === "duplicate");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0]).to.deep.equal({
      addonId: "Dup",
      kind: "duplicate",
      packages: ["addons/plugin/Dup.c3addon", "addons/plugin/nested/Dup.c3addon"],
      problem: "2 packages resolve to the same addon id",
    });
  });

  it("MissingPkg: exactly one missing finding carrying the manifest version", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = result.findings.filter((f) => f.kind === "missing");
    expect(findings).to.have.lengthOf(1);
    expect(findings[0]).to.deep.equal({
      addonId: "MissingPkg",
      kind: "missing",
      problem: "declared bundled in project.c3proj but no package file on disk",
      manifestValue: "3.2.1.0",
    });
  });

  it("EditorOnly (bundled: false, no package on disk): produces no finding", () => {
    const result = validateAddons(FIXTURE_ROOT);
    expect(result.findings.some((f) => f.addonId === "EditorOnly")).to.equal(false);
  });

  it("NoAcesEffect.c3addon: no findings (effect addons are exempt from aces.json)", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/effect/NoAcesEffect.c3addon");
    expect(findings).to.have.lengthOf(0);
  });

  it("full fixture findings set is exactly the expected 8", () => {
    const result = validateAddons(FIXTURE_ROOT);
    expect(result.findings).to.have.lengthOf(8);
  });

  it("formatAddonValidation: orphan/missing/duplicate line shapes", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const lines = formatAddonValidation(result).split("\n");

    expect(lines).to.include(
      "  addons/plugin/Orphan.c3addon: orphan — on disk but not in project.c3proj usedAddons (id 'Orphan')",
    );
    expect(lines).to.include(
      "  MissingPkg: missing — declared bundled in project.c3proj but no package file on disk (version 3.2.1.0)",
    );
    expect(lines).to.include(
      "  Dup: duplicate — 2 packages resolve to the same addon id: addons/plugin/Dup.c3addon, addons/plugin/nested/Dup.c3addon",
    );
  });

  it("formatAddonValidation: empty case on a project with no addons", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "addon-validate-empty-"));
    try {
      const result = validateAddons(tmpDir);
      expect(result.checked).to.equal(0);
      expect(result.findings).to.have.lengthOf(0);
      expect(formatAddonValidation(result)).to.equal("Checked 0 bundled addon(s): all consistent.");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("formatAddonValidation: non-empty header + version-mismatch line format", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const output = formatAddonValidation(result);
    const lines = output.split("\n");

    expect(lines[0]).to.equal(`Checked 9 bundled addon(s), ${result.findings.length} issue(s):`);
    expect(lines).to.include(
      "  addons/plugin/Complete.c3addon: version mismatch — package '1.0.0.0' vs project.c3proj '1.0.0.9'",
    );
  });

  describe("regression: addon-validate fixture unaffected by lang wiring", () => {
    // The addon-validate fixture ships no lang/ files, so the lang-presence
    // gate in the full-scan loop skips every package — the finding set and
    // checked count above (asserted throughout this file) must stay
    // byte-identical to before the aces/lang cross-check was wired in.
    it("still reports exactly the pre-existing 8 findings", () => {
      const result = validateAddons(FIXTURE_ROOT);
      expect(result.checked).to.equal(9);
      expect(result.findings).to.have.lengthOf(8);
      expect(result.findings.some((f) => f.kind.startsWith("lang-"))).to.equal(false);
    });
  });

  describe("aces/lang cross-check wiring (#98)", () => {
    it("full scan: exactly the 4 expected lang findings, checked === 2", () => {
      const result = validateAddons(LANG_FIXTURE_ROOT);
      expect(result.checked).to.equal(2);
      expect(result.findings).to.have.lengthOf(4);
      expect(result.findings.every((f) => f.kind.startsWith("lang-"))).to.equal(true);
      expect(result.findings.every((f) => f.addonId === "LangDefects" && f.lang === "lang/en-US.json")).to.equal(true);

      const missingAce = result.findings.find((f) => f.kind === "lang-missing-ace");
      expect(missingAce?.aceId).to.equal("drift");

      const missingParam = result.findings.find((f) => f.kind === "lang-missing-param");
      expect(missingParam?.paramId).to.equal("offset");

      const propertyFindings = result.findings.filter((f) => f.kind === "lang-missing-property");
      expect(propertyFindings).to.have.lengthOf(2);
      expect(propertyFindings.some((f) => f.propId === "speed" && f.itemId === undefined)).to.equal(true);
      expect(propertyFindings.some((f) => f.propId === "mode" && f.itemId === "slow")).to.equal(true);
    });

    it("target mode, discovered id: same 4 lang findings, checked === 1", () => {
      const target = resolveAddonTarget(LANG_FIXTURE_ROOT, "LangDefects");
      expect(target).to.not.equal(null);
      const result = validateAddons(LANG_FIXTURE_ROOT, target!);
      expect(result.checked).to.equal(1);
      expect(result.findings).to.have.lengthOf(4);
      expect(result.findings.every((f) => f.kind.startsWith("lang-"))).to.equal(true);
    });

    it("target mode, raw source-tree path: same 4 lang findings (lang-only), checked === 1", () => {
      const target = resolveAddonTarget(LANG_FIXTURE_ROOT, "archive-sources/LangDefects");
      expect(target).to.not.equal(null);
      expect(target!.archivePath).to.equal("");
      const result = validateAddons(LANG_FIXTURE_ROOT, target!);
      expect(result.checked).to.equal(1);
      expect(result.findings).to.have.lengthOf(4);
      expect(result.findings.every((f) => f.kind.startsWith("lang-"))).to.equal(true);
    });

    it("target mode, clean addon (by id): no findings, checked === 1", () => {
      const target = resolveAddonTarget(LANG_FIXTURE_ROOT, "LangClean");
      expect(target).to.not.equal(null);
      const result = validateAddons(LANG_FIXTURE_ROOT, target!);
      expect(result.checked).to.equal(1);
      expect(result.findings).to.have.lengthOf(0);
    });

    it("target mode, clean addon (by raw path): no findings, checked === 1", () => {
      const target = resolveAddonTarget(LANG_FIXTURE_ROOT, "archive-sources/LangClean");
      expect(target).to.not.equal(null);
      const result = validateAddons(LANG_FIXTURE_ROOT, target!);
      expect(result.checked).to.equal(1);
      expect(result.findings).to.have.lengthOf(0);
    });
  });
});
