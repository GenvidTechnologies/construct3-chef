import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  validateAddons,
  formatAddonValidation,
  familyOf,
  countByFamily,
  type AddonFinding,
} from "../../src/c3/addonValidator.js";
import { resolveAddonTarget } from "../../src/c3/addonDiscovery.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");
const LANG_FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/addon-validate-lang");

function findingsFor(findings: AddonFinding[], pkg: string): AddonFinding[] {
  return findings.filter((f) => f.package === pkg);
}

describe("addonValidator", () => {
  it("checks all 10 fixture packages", () => {
    const result = validateAddons(FIXTURE_ROOT);
    expect(result.checked).to.equal(10);
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

  it("NameMismatchBehavior.c3addon: no findings (instance name vs display name are allowed to differ, #132)", () => {
    const result = validateAddons(FIXTURE_ROOT);
    const findings = findingsFor(result.findings, "addons/behavior/NameMismatchBehavior.c3addon");
    expect(findings).to.have.lengthOf(0);
    expect(result.findings.some((f) => f.kind === "metadata-mismatch" && f.field === "name")).to.equal(false);
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

    expect(lines[0]).to.equal(`Checked 10 bundled addon(s), ${result.findings.length} issue(s):`);
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
      expect(result.checked).to.equal(10);
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

  describe("familyOf / countByFamily (#220 prep)", () => {
    it("maps every kind to its family", () => {
      expect(familyOf("metadata-mismatch")).to.equal("metadata");
      expect(familyOf("integrity")).to.equal("integrity");
      expect(familyOf("orphan")).to.equal("package-consistency");
      expect(familyOf("missing")).to.equal("package-consistency");
      expect(familyOf("duplicate")).to.equal("package-consistency");
      expect(familyOf("lang-missing-ace")).to.equal("lang");
      expect(familyOf("lang-missing-param")).to.equal("lang");
      expect(familyOf("lang-missing-property")).to.equal("lang");
    });

    it("countByFamily zero-fills all four families on an empty array", () => {
      expect(countByFamily([])).to.deep.equal({
        metadata: 0,
        integrity: 0,
        "package-consistency": 0,
        lang: 0,
      });
    });

    it("countByFamily counts a mixed set correctly", () => {
      const findings: AddonFinding[] = [
        { kind: "metadata-mismatch" },
        { kind: "integrity" },
        { kind: "integrity" },
        { kind: "orphan" },
        { kind: "missing" },
        { kind: "duplicate" },
        { kind: "lang-missing-ace" },
        { kind: "lang-missing-param" },
        { kind: "lang-missing-property" },
      ];
      expect(countByFamily(findings)).to.deep.equal({
        metadata: 1,
        integrity: 2,
        "package-consistency": 3,
        lang: 3,
      });
    });
  });

  describe("formatAddonValidation: per-family breakdown + gating (#220)", () => {
    const mixedFindings: AddonFinding[] = [
      {
        package: "addons/plugin/A.c3addon",
        addonId: "A",
        kind: "metadata-mismatch",
        field: "version",
        packageValue: "1.0.0.0",
        manifestValue: "1.0.0.1",
      },
      { package: "addons/plugin/B.c3addon", kind: "integrity", problem: "missing required entry: aces.json" },
      {
        package: "addons/plugin/C.c3addon",
        kind: "integrity",
        problem: "malformed zip (not a valid .c3addon archive)",
      },
      {
        package: "addons/plugin/D.c3addon",
        addonId: "D",
        kind: "orphan",
        problem: "on disk but not in project.c3proj usedAddons",
      },
      {
        addonId: "E",
        kind: "missing",
        problem: "declared bundled in project.c3proj but no package file on disk",
      },
      {
        addonId: "F",
        kind: "duplicate",
        packages: ["addons/plugin/F.c3addon", "addons/plugin/nested/F.c3addon"],
        problem: "2 packages resolve to the same addon id",
      },
      {
        addonId: "G",
        kind: "lang-missing-ace",
        lang: "lang/en-US.json",
        aceId: "drift",
        problem: "missing ACE 'drift'",
      },
      {
        addonId: "H",
        kind: "lang-missing-param",
        lang: "lang/en-US.json",
        paramId: "offset",
        problem: "missing param 'offset'",
      },
      {
        addonId: "I",
        kind: "lang-missing-property",
        lang: "lang/en-US.json",
        propId: "speed",
        problem: "missing property 'speed'",
      },
    ];
    const mixedResult = { checked: 9, findings: mixedFindings };

    it("breakdown line lists all four families with correct counts, including zeros", () => {
      const lines = formatAddonValidation(mixedResult).split("\n");
      expect(lines[1]).to.equal("  metadata 1, integrity 2, package-consistency 3, lang 3");

      // A finding set that is all one family still zero-fills the other three.
      const onlyMetadata = { checked: 1, findings: [mixedFindings[0]] };
      const onlyLines = formatAddonValidation(onlyMetadata).split("\n");
      expect(onlyLines[1]).to.equal("  metadata 1, integrity 0, package-consistency 0, lang 0");
    });

    it("with a skip set, the gating line names gated + exempted families and excludes skipped findings from fatal", () => {
      const lines = formatAddonValidation(mixedResult, { skipGate: ["lang"] }).split("\n");
      expect(lines[1]).to.equal("  metadata 1, integrity 2, package-consistency 3, lang 3");
      expect(lines[2]).to.equal("Gating on metadata, integrity, package-consistency (lang exempted) — 6 fatal.");
    });

    it("renders 'Gating on nothing' when every family is exempted, never a bare subject", () => {
      // A report-but-never-fail run is legitimate, so the all-exempted case must read
      // as prose. Joining an empty family list would emit "Gating on  (… exempted)"
      // — a doubled space with nothing named. Pin the exact string, not a substring.
      const lines = formatAddonValidation(mixedResult, {
        skipGate: ["metadata", "integrity", "package-consistency", "lang"],
      }).split("\n");
      expect(lines[2]).to.equal(
        "Gating on nothing (metadata, integrity, package-consistency, lang exempted) — 0 fatal.",
      );
      expect(lines[2]).to.not.include("on  ");
    });

    it("with no skip set, the gating line is absent but the breakdown line is present", () => {
      const output = formatAddonValidation(mixedResult);
      expect(output).to.not.include("Gating on");
      const lines = output.split("\n");
      expect(lines[1]).to.equal("  metadata 1, integrity 2, package-consistency 3, lang 3");
      // finding lines follow immediately after the breakdown line (no gating line inserted).
      expect(lines[2]).to.equal(
        "  addons/plugin/A.c3addon: version mismatch — package '1.0.0.0' vs project.c3proj '1.0.0.1'",
      );
    });

    it("clean case is unchanged: no breakdown line, no gating line", () => {
      const cleanResult = { checked: 3, findings: [] as AddonFinding[] };
      expect(formatAddonValidation(cleanResult)).to.equal("Checked 3 bundled addon(s): all consistent.");
      expect(formatAddonValidation(cleanResult, { skipGate: ["lang"] })).to.equal(
        "Checked 3 bundled addon(s): all consistent.",
      );
    });

    it("existing per-finding lines are byte-identical to before, for the real fixture's 8 findings", () => {
      const result = validateAddons(FIXTURE_ROOT);
      const lines = formatAddonValidation(result).split("\n");

      // header + breakdown + 8 finding lines (no skip set passed -> no gating line).
      expect(lines).to.have.lengthOf(10);
      expect(lines[0]).to.equal(`Checked 10 bundled addon(s), ${result.findings.length} issue(s):`);
      expect(lines[1]).to.equal("  metadata 1, integrity 4, package-consistency 3, lang 0");

      const expectedFindingLines = [
        "  addons/plugin/Complete.c3addon: version mismatch — package '1.0.0.0' vs project.c3proj '1.0.0.9'",
        "  addons/plugin/Orphan.c3addon: orphan — on disk but not in project.c3proj usedAddons (id 'Orphan')",
        "  MissingPkg: missing — declared bundled in project.c3proj but no package file on disk (version 3.2.1.0)",
        "  Dup: duplicate — 2 packages resolve to the same addon id: addons/plugin/Dup.c3addon, addons/plugin/nested/Dup.c3addon",
      ];
      for (const expected of expectedFindingLines) {
        expect(lines).to.include(expected);
      }
      // Every line past the breakdown is a two-space-indented finding line (never a
      // "Gating on ..." line, since no skipGate was passed).
      for (const line of lines.slice(2)) {
        expect(line.startsWith("  ")).to.equal(true);
      }
    });
  });
});
