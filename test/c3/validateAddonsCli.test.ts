import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { runCli } from "../helpers/runCli.js";

// Wiring-only coverage for the `validate-addons` CLI subcommand's `--skip-gate`
// option (issue #220, ADR 0038: a deny-list). The gating predicate itself
// (`countFatal`) and the rendered "Gating on ..." line are already covered at
// the library level (test/c3/addonValidator.test.ts) — this file exists only
// for the handful of assertions that genuinely need a real process boundary:
// yargs' `coerce` rejection message (R5) and the CLI's exit-code decisions
// (R1-R3, multi-family, all-four). `validate-addons` is read-only, so — like
// addonInventory.test.ts — the tracked fixtures are addressed directly, no
// temp copy needed.

const SAMPLE_FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const ADDON_VALIDATE_ROOT = path.resolve("test/fixtures/addon-validate");
const ADDON_VALIDATE_LANG_ROOT = path.resolve("test/fixtures/addon-validate-lang");

describe("validate-addons CLI --skip-gate wiring", function () {
  // Spawns the real CLI via tsx (~0.5-2s each) — see test/helpers/runCli.ts.
  this.timeout(30_000);

  describe("R3: no flag — unchanged from today", () => {
    it("construct3-chef-sample: exits 1, breakdown line, no Gating line", () => {
      const result = runCli(["validate-addons", "--project-dir", SAMPLE_FIXTURE_ROOT]);
      expect(result.exitCode).to.equal(1);
      expect(result.stdout).to.include("metadata 0, integrity 0, package-consistency 0, lang 3");
      expect(result.stdout).to.not.include("Gating on");
    });

    it("addon-validate: exits 1, breakdown line, no Gating line", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_ROOT]);
      expect(result.exitCode).to.equal(1);
      expect(result.stdout).to.include("metadata 1, integrity 4, package-consistency 3, lang 0");
      expect(result.stdout).to.not.include("Gating on");
    });

    it("addon-validate-lang: exits 1, breakdown line, no Gating line", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_LANG_ROOT]);
      expect(result.exitCode).to.equal(1);
      expect(result.stdout).to.include("lang 4");
      expect(result.stdout).to.not.include("Gating on");
    });
  });

  describe("R1: --skip-gate lang against construct3-chef-sample (all findings are lang)", () => {
    it("exits 0 and the report still lists all 3 findings", () => {
      const result = runCli(["validate-addons", "--project-dir", SAMPLE_FIXTURE_ROOT, "--skip-gate", "lang"]);
      expect(result.exitCode).to.equal(0);
      expect(result.stdout).to.include("3 issue(s):");
      expect(result.stdout).to.include("condition 'is-moving' has no lang entry");
      expect(result.stdout).to.include("action 'stop' has no lang entry");
      expect(result.stdout).to.include("expression 'leet' has no lang entry");
      expect(result.stdout).to.include("Gating on metadata, integrity, package-consistency (lang exempted) — 0 fatal.");
    });
  });

  describe("R2: --skip-gate lang against addon-validate (non-lang findings remain fatal)", () => {
    it("exits 1 and the non-zero metadata/integrity/package-consistency counts are reported", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_ROOT, "--skip-gate", "lang"]);
      expect(result.exitCode).to.equal(1);
      expect(result.stdout).to.include("metadata 1, integrity 4, package-consistency 3, lang 0");
      expect(result.stdout).to.include("Gating on metadata, integrity, package-consistency (lang exempted) — 8 fatal.");
    });
  });

  describe("R5: unknown family names hard-fail, naming the valid families", () => {
    it("rejects a bogus family with a message naming metadata/integrity/package-consistency/lang", () => {
      const result = runCli(["validate-addons", "--project-dir", SAMPLE_FIXTURE_ROOT, "--skip-gate", "bogus"]);
      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include("Invalid --skip-gate value(s): 'bogus'");
      expect(result.stderr).to.include("Valid families: metadata, integrity, package-consistency, lang.");
    });

    it("rejects an empty element (a trailing/doubled comma)", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_ROOT, "--skip-gate", "lang,,metadata"]);
      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include("Invalid --skip-gate value(s): ''");
    });

    it("does not partially apply a rejected --skip-gate — one valid family alongside one bogus one still fails", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_ROOT, "--skip-gate", "lang,bogus"]);
      expect(result.exitCode).to.not.equal(0);
      expect(result.stderr).to.include("Invalid --skip-gate value(s): 'bogus'");
    });
  });

  describe("multi-family and all-family --skip-gate", () => {
    it("--skip-gate lang,metadata against addon-validate: integrity + package-consistency stay fatal", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_ROOT, "--skip-gate", "lang,metadata"]);
      expect(result.exitCode).to.equal(1);
      expect(result.stdout).to.include("Gating on integrity, package-consistency (metadata, lang exempted) — 7 fatal.");
    });

    it("trims whitespace around comma-delimited names", () => {
      const result = runCli(["validate-addons", "--project-dir", ADDON_VALIDATE_ROOT, "--skip-gate", "lang, metadata"]);
      expect(result.exitCode).to.equal(1);
      expect(result.stdout).to.include("Gating on integrity, package-consistency (metadata, lang exempted) — 7 fatal.");
    });

    it("all four families skipped: exits 0 even though findings are present", () => {
      const result = runCli([
        "validate-addons",
        "--project-dir",
        ADDON_VALIDATE_ROOT,
        "--skip-gate",
        "metadata,integrity,package-consistency,lang",
      ]);
      expect(result.exitCode).to.equal(0);
      expect(result.stdout).to.include("8 issue(s):");
      expect(result.stdout).to.include(
        "Gating on nothing (metadata, integrity, package-consistency, lang exempted) — 0 fatal.",
      );
    });
  });
});
