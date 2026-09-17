import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";

// The decision engine is plain ESM JS under scripts/; it has no type
// declarations, so the import is untyped by design rather than by omission —
// the same shape `test/wiki/wikiBundle.test.ts` uses for `gen-wiki-index.mjs`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { decide, parseSubject, checkLinkRefs, getUnreleasedBullets } from "../scripts/changelog-notice.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

interface HistoryRow {
  sha: string;
  subject: string;
  type: string | null;
  breaking: boolean;
  touchesSrc: boolean;
  baseUnreleasedBullets: number;
  headUnreleasedBullets: number;
  hasOptOut: boolean;
  expectedGated: boolean;
  expectedFlagged: boolean;
}

/**
 * Reconstructs the `decide()` inputs `changelog-signal-survey.mjs` would have
 * derived for this row, from the row's own summarized fields rather than by
 * re-reading git history. `baseBullets`/`headBullets` only need the right
 * *counts* — `decide()` only ever compares `.length` and set-membership
 * against each other, and no row's opt-out/no-opt-out disposition depends on
 * the bullets' actual text — so synthetic placeholder bullets of the right
 * count are equivalent for this row's own before/after comparison.
 */
function bulletsOfLength(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `- placeholder bullet ${i}`);
}

function decideForRow(row: HistoryRow, body = "") {
  const changedFiles = row.touchesSrc ? ["src/placeholder.ts"] : ["docs/placeholder.md"];
  return decide({
    title: row.subject,
    changedFiles,
    baseBullets: bulletsOfLength(row.baseUnreleasedBullets),
    headBullets: bulletsOfLength(row.headUnreleasedBullets),
    body,
  });
}

describe("changelog-notice decision engine", () => {
  describe("T1 — regression oracle: 9e3b3d8 is flagged as a missing breaking entry", () => {
    it("gates and flags a breaking feat! with no [Unreleased] entry and no opt-out", () => {
      const verdict = decide({
        title: "feat!: MCP server multi-project support (N roots, per-call project selector)",
        changedFiles: [
          "src/mcp/server.ts",
          "src/mcp/projectContext.ts",
          "src/mcp/projectRegistry.ts",
          "src/mcp/txToken.ts",
          "src/mcp/launchConfig.ts",
          "src/cli.ts",
          "src/index.ts",
        ],
        baseBullets: [],
        headBullets: [],
        body: "Adds multi-project support to the MCP server.",
      });

      expect(verdict).to.deep.equal({ gated: true, flagged: true, reason: "missing-entry-breaking" });
    });
  });

  describe("T2 — fixture-driven over the full 30-commit historical window", () => {
    const fixturePath = path.join(REPO_ROOT, "test", "data", "changelog-signal-history.json");
    const rows: HistoryRow[] = JSON.parse(readFileSync(fixturePath, "utf8"));

    it("carries exactly 30 rows", () => {
      // Guards against a vacuous pass: a truncated fixture would make every
      // count assertion below trivially satisfiable over a smaller corpus.
      expect(rows.length).to.equal(30);
    });

    it("gates exactly 16 rows and flags exactly 7", () => {
      const verdicts = rows.map((row) => decideForRow(row));
      const gatedCount = verdicts.filter((v) => v.gated).length;
      const flaggedCount = verdicts.filter((v) => v.flagged).length;

      expect(gatedCount).to.equal(16);
      expect(flaggedCount).to.equal(7);
    });

    it("flags exactly the 7 pledged SHAs", () => {
      const flaggedShas = rows.filter((row) => decideForRow(row).flagged).map((row) => row.sha);
      const expectedShas = ["9e3b3d8", "6e067a0", "d7a2f55", "2286e1b", "491459d", "d84ad83", "b69e4f2"];

      // Compare as sets — sort both sides — rather than depending on row
      // order, which is incidental to the fixture's own construction.
      expect([...flaggedShas].sort()).to.deep.equal([...expectedShas].sort());
    });

    it("agrees with each row's own expectedGated/expectedFlagged fields", () => {
      for (const row of rows) {
        const verdict = decideForRow(row);
        expect(verdict.gated, `${row.sha} gated`).to.equal(row.expectedGated);
        expect(verdict.flagged, `${row.sha} flagged`).to.equal(row.expectedFlagged);
      }
    });
  });

  describe("T3 — default-gate property: an unrecognized type gates by default", () => {
    it("flags a perf: commit, a type that appears in no row of the 30-commit window", () => {
      const verdict = decide({
        title: "perf: speed up the DSL formatter",
        changedFiles: ["docs/x.md"],
        baseBullets: [],
        headBullets: [],
        body: "",
      });

      expect(verdict.flagged).to.equal(true);
    });
  });

  describe("T4 — a chore: touching src/ is material even though chore is exempt-by-default", () => {
    it("flags chore: adopt mcp-utils 0.8.0, which touches src/mcp/server.ts (2286e1b's real shape)", () => {
      const verdict = decide({
        title: "chore: adopt mcp-utils 0.8.0",
        changedFiles: ["src/mcp/server.ts", "package.json"],
        baseBullets: [],
        headBullets: [],
        body: "",
      });

      expect(verdict.flagged).to.equal(true);
    });

    it("does not gate the same title when it touches no src/ file", () => {
      const verdict = decide({
        title: "chore: adopt mcp-utils 0.8.0",
        changedFiles: ["wiki/a.md"],
        baseBullets: [],
        headBullets: [],
        body: "",
      });

      expect(verdict.gated).to.equal(false);
    });
  });

  describe("T5 — the opt-out requires a mandatory, non-empty reason", () => {
    const otherwiseFlagged = {
      title: "fix: some user-visible bug",
      changedFiles: ["src/x.ts"],
      baseBullets: [],
      headBullets: [],
    };

    it("accepts a well-formed opt-out with a reason", () => {
      const verdict = decide({ ...otherwiseFlagged, body: "Changelog: none — pure test scaffolding" });
      expect(verdict).to.deep.equal({
        gated: true,
        flagged: false,
        reason: "opted-out",
        justification: "pure test scaffolding",
      });
    });

    it("still flags a bare 'Changelog: none' with no dash/reason at all", () => {
      const verdict = decide({ ...otherwiseFlagged, body: "Changelog: none" });
      expect(verdict.flagged).to.equal(true);
    });

    it("still flags 'Changelog: none —' followed by only whitespace", () => {
      const verdict = decide({ ...otherwiseFlagged, body: "Changelog: none —   " });
      expect(verdict.flagged).to.equal(true);
    });
  });

  describe("parseSubject", () => {
    it("parses a plain conventional-commit subject", () => {
      expect(parseSubject("fix: do the thing")).to.deep.equal({ type: "fix", breaking: false });
    });

    it("parses a breaking marker", () => {
      expect(parseSubject("feat!: do the thing")).to.deep.equal({ type: "feat", breaking: true });
    });

    it("returns a null type for a malformed subject", () => {
      expect(parseSubject("not a conventional commit")).to.deep.equal({ type: null, breaking: false });
    });
  });

  describe("getUnreleasedBullets", () => {
    it("returns an empty array when there is no [Unreleased] heading", () => {
      expect(getUnreleasedBullets("# Changelog\n\n## [1.0.0]\n\n- something\n")).to.deep.equal([]);
    });

    it("returns only top-level bullet lines under [Unreleased]", () => {
      const text =
        "## [Unreleased]\n\n### Added\n\n- first bullet\n  continuation line\n- second bullet\n\n## [1.0.0]\n";
      expect(getUnreleasedBullets(text)).to.deep.equal(["- first bullet", "- second bullet"]);
    });
  });

  describe("checkLinkRefs", () => {
    it("skips the in-flight version's own operand and reports the rest as checked-ok", () => {
      // Only a numbered `[X.Y.Z]:` label is parsed for operands — an
      // `[Unreleased]:` line's label never matches, regardless of what its
      // URL names — so the in-flight tag must appear on a real dated section
      // (a compare link's second operand) to be exercised at all.
      const changelogText = "[2.0.0]: https://x/compare/v1.0.0...v2.0.0\n";
      const result = checkLinkRefs(["v1.0.0"], changelogText, "2.0.0");
      expect(result).to.deep.equal({ checkedOk: 1, skipped: ["v2.0.0"], dangling: [] });
    });

    it("reports a link-ref operand with no matching tag as dangling", () => {
      const changelogText = "[1.0.0]: https://x/releases/tag/v1.0.0\n";
      const result = checkLinkRefs([], changelogText, "2.0.0");
      expect(result.dangling).to.deep.equal(["v1.0.0"]);
    });
  });
});
