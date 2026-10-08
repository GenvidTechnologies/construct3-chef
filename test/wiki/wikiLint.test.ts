import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";

// The lint script is plain ESM JS under scripts/; it has no type declarations, so
// the import is untyped by design rather than by omission.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { findSetextHeadings, lintWiki } from "../../scripts/wiki-lint.mjs";

/**
 * `scripts/wiki-lint.mjs` is advisory and always exits 0 (OKF §11, ADR 0028).
 * These tests pin what its setext check *reports*. They do not gate the wiki's
 * content: a finding in a real page never fails the build.
 */
describe("wiki-lint: accidental setext headings", () => {
  it("flags a text line directly above `---` (the #249 docs-edit shape)", () => {
    const text = "Intro paragraph.\n\nLast sentence of the section.\n---\n\n## Next\n";
    expect(findSetextHeadings(text)).to.deep.equal([{ line: 4, over: "Last sentence of the section." }]);
  });

  it("does not flag `---` preceded by a blank line", () => {
    expect(findSetextHeadings("Last sentence.\n\n---\n\n## Next\n")).to.deep.equal([]);
  });

  it("skips YAML frontmatter", () => {
    expect(findSetextHeadings("---\ntype: guide\ntitle: x\n---\n\nBody.\n")).to.deep.equal([]);
  });

  it("skips fenced code", () => {
    expect(findSetextHeadings("Intro.\n\n```md\nquoted text\n---\n```\n")).to.deep.equal([]);
  });

  it("does not flag a `---` under a list item, ATX heading, blockquote or table row", () => {
    for (const prev of ["- a list item", "1. a numbered item", "## A heading", "> a quote", "| a | b |"]) {
      expect(findSetextHeadings(`${prev}\n---\n`), prev).to.deep.equal([]);
    }
  });

  it("is wired into lintWiki's report", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "c3chef-wikilint-"));
    try {
      mkdirSync(path.join(root, "wiki"));
      writeFileSync(path.join(root, "wiki", "page.md"), "---\ntype: guide\n---\n\nBody.\nLast.\n---\n");
      const r = lintWiki(root, "2026-10-08");
      expect(r.setext).to.deep.equal(['wiki/page.md:7 (over "Last.")']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
