import { expect } from "chai";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The generator is plain ESM JS under scripts/; it has no type declarations, so
// the import is untyped by design rather than by omission.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { buildIndexes } from "../../scripts/gen-wiki-index.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The wiki's central no-drift claim — stated in `wiki/index.md` and
 * `wiki/wiki-schema.md` — is that every index entry's description IS the linked
 * page's frontmatter `description`. Prose cannot enforce that; this does.
 *
 * Deliberately narrow. It gates ONLY index freshness, which is local generation
 * policy. It does NOT assert OKF conformance: §11 forbids an OKF consumer from
 * rejecting a bundle for a broken cross-link, a missing `index.md`, an unknown
 * `type`, or a missing optional field, so those stay advisory in
 * `scripts/wiki-lint.mjs`, which always exits 0. See ADR 0028.
 */
describe("wiki bundle", () => {
  describe("generated indexes", () => {
    const built = buildIndexes(REPO_ROOT) as Map<string, string>;

    it("generates at least the bundle-root index and one section index", () => {
      // Guards against a vacuous pass: an empty map would make every row below
      // trivially true without checking anything.
      expect(built.size).to.be.greaterThan(1);
      expect([...built.keys()]).to.include("wiki/index.md");
    });

    for (const rel of [
      "wiki/index.md",
      "wiki/reference/index.md",
      "wiki/architecture/index.md",
      "wiki/process/index.md",
      "wiki/decisions/index.md",
    ]) {
      it(`${rel} matches generator output (run \`npm run wiki:index\` if this fails)`, () => {
        const abs = path.join(REPO_ROOT, rel);
        expect(existsSync(abs), `${rel} is missing`).to.equal(true);
        expect(built.has(rel), `${rel} is not produced by the generator`).to.equal(true);
        expect(readFileSync(abs, "utf8")).to.equal(built.get(rel));
      });
    }
  });
});
