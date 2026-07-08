import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateAddons, formatAddonValidation, type AddonFinding } from "../../src/c3/addonValidator.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");

function findingsFor(findings: AddonFinding[], pkg: string): AddonFinding[] {
  return findings.filter((f) => f.package === pkg);
}

describe("addonValidator", () => {
  it("checks all 6 fixture packages", () => {
    const result = validateAddons(FIXTURE_ROOT);
    expect(result.checked).to.equal(6);
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

  it("full fixture findings set is exactly the expected 5", () => {
    const result = validateAddons(FIXTURE_ROOT);
    expect(result.findings).to.have.lengthOf(5);
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

    expect(lines[0]).to.equal(`Checked 6 bundled addon(s), ${result.findings.length} issue(s):`);
    expect(lines).to.include(
      "  addons/plugin/Complete.c3addon: version mismatch — package '1.0.0.0' vs project.c3proj '1.0.0.9'",
    );
  });
});
