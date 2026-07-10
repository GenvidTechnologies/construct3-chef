import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { discoverAddons } from "../../src/c3/addonDiscovery.js";
import { checkAddonLang } from "../../src/c3/addonLangValidator.js";
import { formatAddonValidation, type AddonFinding } from "../../src/c3/addonValidator.js";

const LANG_FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate-lang");
const NO_LANG_FIXTURE_ROOT = path.resolve("test/fixtures/addon-validate");

function findAddon(root: string, name: string) {
  const addon = discoverAddons(root).find((a) => a.name === name);
  if (addon === undefined) throw new Error(`fixture addon '${name}' not found under ${root}`);
  return addon;
}

describe("addonLangValidator", () => {
  describe("checkAddonLang", () => {
    it("LangDefects: exactly the 4 expected en-US gaps, fr-FR clean", () => {
      const addon = findAddon(LANG_FIXTURE_ROOT, "LangDefects");
      const findings = checkAddonLang(addon);

      expect(findings).to.have.lengthOf(4);
      for (const finding of findings) {
        expect(finding.addonId).to.equal("LangDefects");
        expect(finding.lang).to.equal("lang/en-US.json");
      }

      const missingAce = findings.find((f) => f.kind === "lang-missing-ace");
      expect(missingAce).to.not.equal(undefined);
      expect(missingAce?.aceId).to.equal("drift");
      expect(missingAce?.context).to.include("expressions.drift");

      const missingParam = findings.find((f) => f.kind === "lang-missing-param");
      expect(missingParam).to.not.equal(undefined);
      expect(missingParam?.paramId).to.equal("offset");
      expect(missingParam?.aceId).to.equal("resync");
      expect(missingParam?.context).to.include("actions.resync.params.offset");

      const propertyFindings = findings.filter((f) => f.kind === "lang-missing-property");
      expect(propertyFindings).to.have.lengthOf(2);

      const missingProperty = propertyFindings.find((f) => f.propId === "speed" && f.itemId === undefined);
      expect(missingProperty).to.not.equal(undefined);
      expect(missingProperty?.context).to.include("properties.speed");

      const missingItem = propertyFindings.find((f) => f.propId === "mode" && f.itemId === "slow");
      expect(missingItem).to.not.equal(undefined);
      expect(missingItem?.context).to.include("properties.mode.items.slow");

      // fr-FR is fully consistent — no finding should reference it.
      expect(findings.some((f) => f.lang === "lang/fr-FR.json")).to.equal(false);
    });

    it("LangClean: no findings", () => {
      const addon = findAddon(LANG_FIXTURE_ROOT, "LangClean");
      expect(checkAddonLang(addon)).to.deep.equal([]);
    });

    it("is inert (returns []) for an addon that ships no lang/ files", () => {
      const addon = findAddon(NO_LANG_FIXTURE_ROOT, "CleanControl");
      expect(checkAddonLang(addon)).to.deep.equal([]);
    });
  });

  describe("formatAddonValidation lang line shapes", () => {
    it("renders a lang-missing-ace finding", () => {
      const finding: AddonFinding = {
        kind: "lang-missing-ace",
        addonId: "LangDefects",
        lang: "lang/en-US.json",
        aceId: "drift",
        context: "plugins.LangDefects.expressions.drift",
        problem: "expression 'drift' has no lang entry",
      };
      const output = formatAddonValidation({ checked: 1, findings: [finding] });
      expect(output.split("\n")).to.include("  LangDefects [lang/en-US.json]: expression 'drift' has no lang entry");
    });

    it("renders a lang-missing-property item finding", () => {
      const finding: AddonFinding = {
        kind: "lang-missing-property",
        addonId: "LangDefects",
        lang: "lang/en-US.json",
        propId: "mode",
        itemId: "slow",
        context: "plugins.LangDefects.properties.mode.items.slow",
        problem: "item 'slow' of property 'mode' has no lang string",
      };
      const output = formatAddonValidation({ checked: 1, findings: [finding] });
      expect(output.split("\n")).to.include(
        "  LangDefects [lang/en-US.json]: item 'slow' of property 'mode' has no lang string",
      );
    });
  });
});
