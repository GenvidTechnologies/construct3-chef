import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getUnreleasedBullets } from "../scripts/changelog-notice.mjs";

/**
 * Structural invariants over `CHANGELOG.md` itself — no git, no tags, pure
 * file I/O. This is deliberately in the mocha suite rather than the
 * `changelog-notice` CI job: the job's own `--check-tags` half needs a real
 * git checkout with tags, which CI does not have on a depth-1 checkout, but
 * "every dated section has a matching link reference" needs neither git nor
 * tags at all, so it can run — and gate — on every PR regardless of checkout
 * depth. See plan.md P3 / #218 T6.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");
const CHANGELOG_TEXT = readFileSync(CHANGELOG_PATH, "utf8");

/** Every `## [X.Y.Z] - <date>` or `## [Unreleased]` section heading. */
function sectionVersions(text: string): string[] {
  return [...text.matchAll(/^## \[([^\]]+)\](?:\s*-\s*.+)?$/gm)].map((m) => m[1]);
}

/** Every `[X.Y.Z]:` / `[Unreleased]:` link-reference label at the file's foot. */
function linkRefVersions(text: string): string[] {
  return [...text.matchAll(/^\[([^\]]+)\]:\s*\S/gm)].map((m) => m[1]);
}

describe("CHANGELOG.md", () => {
  describe("T6 — every dated/[Unreleased] section has a matching link reference, and vice versa", () => {
    const sections = sectionVersions(CHANGELOG_TEXT);
    const linkRefs = linkRefVersions(CHANGELOG_TEXT);

    it("finds all 19 dated+[Unreleased] sections", () => {
      // Guards against a vacuous pass: a regex that matched nothing would
      // make the set-equality assertion below trivially true over two empty
      // arrays.
      expect(sections.length).to.equal(19);
    });

    it("every section heading has a matching link-reference line", () => {
      const missing = sections.filter((v) => !linkRefs.includes(v));
      expect(missing, `sections with no link ref: ${missing.join(", ")}`).to.deep.equal([]);
    });

    it("every link-reference line has a matching section heading", () => {
      const orphaned = linkRefs.filter((v) => !sections.includes(v));
      expect(orphaned, `link refs with no section: ${orphaned.join(", ")}`).to.deep.equal([]);
    });
  });

  describe("structural invariants", () => {
    it("package.json's version has a dated section, or is covered by [Unreleased]", () => {
      const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
      const sections = sectionVersions(CHANGELOG_TEXT);
      const hasDatedSection = sections.includes(pkg.version);
      const hasUnreleased = sections.includes("Unreleased");

      expect(
        hasDatedSection || hasUnreleased,
        `package.json version ${pkg.version} has neither a dated section nor an [Unreleased] section`,
      ).to.equal(true);
    });

    it("[Unreleased] bullets are well-formed (non-empty, start with '- ')", () => {
      const bullets = getUnreleasedBullets(CHANGELOG_TEXT);
      for (const bullet of bullets) {
        expect(bullet.startsWith("- ")).to.equal(true);
        expect(bullet.trim().length).to.be.greaterThan(2);
      }
    });
  });
});
