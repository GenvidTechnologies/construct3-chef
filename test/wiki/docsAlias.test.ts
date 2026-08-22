import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// The generator is plain ESM JS under scripts/; it has no type declarations, so
// the import is untyped by design rather than by omission.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { buildDocsAlias, generate, clean, check } from "../../scripts/gen-docs-alias.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `exposeDocs` (upstream @genvidtech/mcp-utils) hardcodes a flat,
 * non-recursive scan of `<packageDir>/docs`. `docs/` was retired into
 * `wiki/` by ADR 0028, so `scripts/gen-docs-alias.mjs` regenerates a flat
 * `docs/` alias from `wiki/` at pack time (see .gitignore, and
 * wiki/decisions/0029-*). This suite covers the generator itself; the
 * committed-red `test/mcp/docsResource.test.ts` covers the packaged tarball.
 */
describe("docs alias", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  /** Build a throwaway `<root>/wiki/...` tree from a { relPath: content } map. */
  function seedWiki(structure: Record<string, string>): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "c3chef-docsalias-"));
    for (const [relPath, content] of Object.entries(structure)) {
      const abs = path.join(root, "wiki", relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return root;
  }

  describe("synthetic corpus", () => {
    it("T5(a): index.md at every level collapses to exactly one generated docs/index.md", () => {
      tmpDir = seedWiki({
        "index.md": "# root index\n",
        "log.md": "# log\n",
        "page-a.md": "root page a\n",
        "reference/index.md": "# reference index\n",
        "reference/page-b.md": "reference page b\n",
        "process/index.md": "# process index\n",
        "process/page-c.md": "process page c\n",
      });

      const files = buildDocsAlias(tmpDir) as Map<string, Buffer>;
      const names = [...files.keys()].map((rel) => path.basename(rel));

      const indexCount = names.filter((n) => n === "index.md").length;
      expect(indexCount, "exactly one index.md should be emitted (the generated manifest)").to.equal(1);

      const uniqueNames = new Set(names);
      expect(names.length, "emitted-name count must equal unique-name count").to.equal(uniqueNames.size);

      expect(names).to.have.members(["page-a.md", "page-b.md", "page-c.md", "index.md"]);
    });

    it("does not emit the bundle-root log.md (RESERVED reuse)", () => {
      tmpDir = seedWiki({
        "log.md": "# log\n",
        "page-a.md": "root page a\n",
      });

      const files = buildDocsAlias(tmpDir) as Map<string, Buffer>;
      expect([...files.keys()].some((rel) => path.basename(rel) === "log.md")).to.equal(false);
      expect(files.has("docs/page-a.md")).to.equal(true);
    });

    it("T5(b): two same-stem non-index pages in different sections throws, naming both source paths", () => {
      tmpDir = seedWiki({
        "reference/dup.md": "reference dup\n",
        "process/dup.md": "process dup\n",
      });

      const refPath = path.join(tmpDir, "wiki", "reference", "dup.md");
      const procPath = path.join(tmpDir, "wiki", "process", "dup.md");

      let thrown: Error | undefined;
      try {
        buildDocsAlias(tmpDir);
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown, "expected a stem collision to throw").to.exist;
      expect(thrown!.message).to.include(refPath);
      expect(thrown!.message).to.include(procPath);
    });

    it("verbatim copy: emitted bytes equal source bytes exactly", () => {
      tmpDir = seedWiki({
        "page-a.md": "root page a\nwith more than one line\n",
      });

      const files = buildDocsAlias(tmpDir) as Map<string, Buffer>;
      const src = readFileSync(path.join(tmpDir, "wiki", "page-a.md"));
      expect(files.get("docs/page-a.md")!.equals(src)).to.equal(true);
    });

    it("generated docs/index.md names every served page in docs:///<name> form", () => {
      tmpDir = seedWiki({
        "page-a.md": "root page a\n",
        "reference/page-b.md": "reference page b\n",
      });

      const files = buildDocsAlias(tmpDir) as Map<string, Buffer>;
      const manifest = files.get("docs/index.md")!.toString("utf8");
      expect(manifest).to.include("docs:///page-a");
      expect(manifest).to.include("docs:///page-b");
      expect(manifest).to.not.include("docs:///index");
    });
  });

  describe("generate / clean / check", () => {
    it("check() reports no diff immediately after generate()", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n", "reference/page-b.md": "ref b\n" });
      generate(tmpDir);
      expect(check(tmpDir)).to.deep.equal([]);
    });

    it("clean() removes the generated docs/ dir", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n" });
      generate(tmpDir);
      expect(existsSync(path.join(tmpDir, "docs"))).to.equal(true);
      clean(tmpDir);
      expect(existsSync(path.join(tmpDir, "docs"))).to.equal(false);
    });

    it("clean() is a no-op (not an error) when docs/ does not already exist", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n" });
      expect(existsSync(path.join(tmpDir, "docs"))).to.equal(false);
      expect(() => clean(tmpDir)).to.not.throw();
      expect(existsSync(path.join(tmpDir, "docs"))).to.equal(false);
    });

    it("check() reports a missing file", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n" });
      generate(tmpDir);
      rmSync(path.join(tmpDir, "docs", "page-a.md"));
      const diffs = check(tmpDir) as string[];
      expect(diffs.some((d) => d.includes("missing") && d.includes("page-a.md"))).to.equal(true);
    });

    it("check() reports an extra file", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n" });
      generate(tmpDir);
      writeFileSync(path.join(tmpDir, "docs", "stray.md"), "stray\n");
      const diffs = check(tmpDir) as string[];
      expect(diffs.some((d) => d.includes("extra") && d.includes("stray.md"))).to.equal(true);
    });

    it("check() reports content drift", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n" });
      generate(tmpDir);
      writeFileSync(path.join(tmpDir, "docs", "page-a.md"), "drifted\n");
      const diffs = check(tmpDir) as string[];
      expect(diffs.some((d) => d.includes("differs") && d.includes("page-a.md"))).to.equal(true);
    });

    it("--check does not write anything", () => {
      tmpDir = seedWiki({ "page-a.md": "root a\n" });
      check(tmpDir);
      expect(existsSync(path.join(tmpDir, "docs"))).to.equal(false);
    });
  });

  describe("real wiki corpus", () => {
    it("copies a real page verbatim (byte-identical)", () => {
      const files = buildDocsAlias(REPO_ROOT) as Map<string, Buffer>;
      const src = readFileSync(path.join(REPO_ROOT, "wiki", "reference", "recipe-reference.md"));
      expect(files.get("docs/recipe-reference.md")!.equals(src)).to.equal(true);
    });

    it("does not emit the real bundle-root log.md", () => {
      const files = buildDocsAlias(REPO_ROOT) as Map<string, Buffer>;
      expect(files.has("docs/log.md")).to.equal(false);
    });

    it("manifest names every real served page in docs:///<name> form", () => {
      const files = buildDocsAlias(REPO_ROOT) as Map<string, Buffer>;
      const manifest = files.get("docs/index.md")!.toString("utf8");
      for (const rel of files.keys()) {
        if (rel === "docs/index.md") continue;
        const name = path.basename(rel, ".md");
        expect(manifest, `manifest should list docs:///${name}`).to.include(`docs:///${name}`);
      }
    });

    it("emits exactly one file per non-reserved wiki page, plus a generated index.md", () => {
      // Independently derived (not via SECTIONS/RESERVED) so this is a real
      // check on the generator's output, not a restatement of its own logic.
      const allMd: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(abs);
          else if (entry.name.endsWith(".md")) allMd.push(abs);
        }
      };
      walk(path.join(REPO_ROOT, "wiki"));

      const nonReserved = allMd.filter((abs) => !/^(index|log)\.md$/.test(path.basename(abs)));

      const files = buildDocsAlias(REPO_ROOT) as Map<string, Buffer>;
      // +1 for the generated docs/index.md manifest, which is not a copy of
      // any source page.
      expect(files.size).to.equal(nonReserved.length + 1);
    });
  });
});
