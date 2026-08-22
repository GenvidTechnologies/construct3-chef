import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * #198 (RED step, plan task P2). `exposeDocs` (upstream @genvidtech/mcp-utils)
 * hardcodes a flat, non-recursive scan of `<packageDir>/docs`, and `docs/`
 * was retired into `wiki/` by ADR 0028 — so the MCP `docs:///{name}`
 * resource has served nothing since that consolidation.
 * `scripts/gen-docs-alias.mjs` (committed in the prior task) can regenerate
 * a flat `docs/` alias from `wiki/`, but nothing wires it into packaging
 * yet: `package.json`'s `files`/`prepack`/`postpack` are untouched until a
 * later task in this plan. So this suite is committed RED on purpose — the
 * committed red state is the proof artifact that packaging was genuinely
 * broken before that wiring commit, rather than a claim made after the fact.
 *
 * Do not make this file pass here. It flips green only once `files` gains
 * `"docs"` and `prepack` runs `docs:alias`.
 *
 * Every content assertion below reads from a REAL, freshly built `npm pack`
 * tarball, extracted to a temp dir — never from the repo's working tree.
 * This matters because `docs/` is git-ignored and generated only at pack
 * time (see .gitignore): if a stray `docs/` were ever left on disk by a
 * manual `npm run docs:alias` run, a test that read the working tree
 * directly would pass BY ACCIDENT, proving nothing about packaging. The
 * "guard" test below defends the other half of that trap — it fails loudly,
 * rather than silently validating nothing, if the working tree is dirty in
 * exactly that way when the suite starts.
 */
describe("MCP docs resource — packaged tarball (#198)", function () {
  this.timeout(60000);

  let packDir: string;
  let extractDir: string;
  let pkgRoot: string;

  before(function () {
    packDir = mkdtempSync(path.join(os.tmpdir(), "c3chef-pack-"));
    extractDir = mkdtempSync(path.join(os.tmpdir(), "c3chef-extract-"));

    // `npm pack --pack-destination` on Windows needs the `.cmd` shim, which
    // requires `shell: true` to resolve (spawning `npm.cmd` directly fails
    // with EINVAL) — see the same npm-vs-npm.cmd shape documented in
    // package.json's own tooling notes. POSIX runners resolve plain `npm`
    // fine without a shell.
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npmCmd, ["pack", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    expect(tarballs, "npm pack should produce exactly one tarball").to.have.lengthOf(1);
    const tgzPath = path.join(packDir, tarballs[0]);

    // `--force-local` is required on Windows: Git for Windows ships a GNU
    // tar ahead of the System32 bsdtar on PATH, and GNU tar misparses a
    // `C:/...` path as a `host:path` remote-shell spec without it, failing
    // with "tar (child): Cannot connect to C: resolve failed". Harmless
    // (and accepted) on POSIX tar implementations too.
    execFileSync("tar", ["--force-local", "-xzf", tgzPath, "-C", extractDir], { encoding: "utf8" });

    pkgRoot = path.join(extractDir, "package");
  });

  after(function () {
    if (packDir) rmSync(packDir, { recursive: true, force: true });
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
  });

  it("guard: the repo's own working tree has no docs/ dir (accidental-pass trap)", () => {
    expect(
      existsSync(path.join(REPO_ROOT, "docs")),
      "docs/ is git-ignored and generated only at pack time (see .gitignore); a stray one left by a " +
        "manual `npm run docs:alias` would let a disk-read assertion pass by accident instead of " +
        "genuinely exercising the packaged tarball",
    ).to.equal(false);
  });

  it("T3: packaged docs/recipe-reference.md byte-equals wiki/reference/recipe-reference.md", () => {
    const packagedPath = path.join(pkgRoot, "docs", "recipe-reference.md");
    expect(existsSync(packagedPath), `${packagedPath} should exist in the packaged tarball`).to.equal(true);
    const packaged = readFileSync(packagedPath);
    const source = readFileSync(path.join(REPO_ROOT, "wiki", "reference", "recipe-reference.md"));
    expect(packaged.equals(source)).to.equal(true);
  });

  it("T3: packaged docs/ops.md byte-equals wiki/reference/ops.md", () => {
    const packagedPath = path.join(pkgRoot, "docs", "ops.md");
    expect(existsSync(packagedPath), `${packagedPath} should exist in the packaged tarball`).to.equal(true);
    const packaged = readFileSync(packagedPath);
    const source = readFileSync(path.join(REPO_ROOT, "wiki", "reference", "ops.md"));
    expect(packaged.equals(source)).to.equal(true);
  });

  it("T1: packaged docs/ has recipe-reference.md, ops.md, and cli.md", () => {
    const docsDir = path.join(pkgRoot, "docs");
    for (const name of ["recipe-reference.md", "ops.md", "cli.md"]) {
      expect(existsSync(path.join(docsDir, name)), `docs/${name} should exist in the packaged tarball`).to.equal(true);
    }
  });

  it("T2: packaged docs/ has at least 40 top-level *.md entries", () => {
    const docsDir = path.join(pkgRoot, "docs");
    const mdFiles = existsSync(docsDir) ? readdirSync(docsDir).filter((f) => f.endsWith(".md")) : [];
    expect(mdFiles.length).to.be.at.least(40);
  });

  // --- T10: survival assertions -------------------------------------------
  // Both already pass today, before any of this plan's packaging fix. They
  // are evidence of nothing on their own — they exist only to be paired
  // with the T1/T2/T3 assertions above, so a future regression that breaks
  // README packaging or double-registers exposeDocs is caught by the same
  // suite rather than assumed to still hold.

  it("T10 (survival): README.md is present at the package root", () => {
    expect(existsSync(path.join(pkgRoot, "README.md"))).to.equal(true);
  });

  it("T10 (survival): src/mcp/server.ts calls exposeDocs( exactly once", () => {
    // Anchored on the call form `exposeDocs(`, not the bare token — the
    // bare identifier also appears in the import list, so a plain-token
    // count would overcount by one (this repo's documented eighth-trap
    // shape: a mention is not a call site).
    const serverSrc = readFileSync(path.join(REPO_ROOT, "src", "mcp", "server.ts"), "utf8");
    const callSites = serverSrc.match(/exposeDocs\(/g) ?? [];
    expect(callSites).to.have.lengthOf(1);
  });
});
