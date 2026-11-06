import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { exposeDocs } from "@genvidtech/mcp-utils";
// Untyped plain-JS script, same as test/wiki/wikiLint.test.ts.
import { lintWiki } from "../scripts/wiki-lint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** Every `.md` file under `dir`, as POSIX paths relative to `base`. */
function walkMd(dir: string, base: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      return name === "node_modules" ? [] : walkMd(abs, base);
    }
    return name.endsWith(".md") ? [toPosix(path.relative(base, abs))] : [];
  });
}

/**
 * Link targets in markdown text: inline links (a title after the target is
 * dropped, and so are <angle brackets>) and reference-style definitions.
 */
function extractLinkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const m of text.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)[^)]*\)/g)) targets.push(m[1].replace(/^<|>$/g, ""));
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) targets.push(m[1].replace(/^<|>$/g, ""));
  return targets;
}

/** The external doc tier, read from the source tree. */
function externalSetFromSource(): string[] {
  const reference = readdirSync(path.join(REPO_ROOT, "wiki", "reference"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `wiki/reference/${f}`);
  return ["README.md", "CHANGELOG.md", "wiki/index.md", ...reference].sort();
}

/**
 * #387. The package ships, and the MCP server serves, only the external doc
 * tier: `README.md`, `CHANGELOG.md`, `wiki/index.md` and `wiki/reference/*.md`.
 * One real `npm pack` feeds all three rows.
 */
describe("packaged docs — the external tier only (#387)", function () {
  this.timeout(180000);

  let packDir: string;
  let extractDir: string;
  let pkgRoot: string;
  let packedMd: string[];

  before(function () {
    packDir = mkdtempSync(path.join(os.tmpdir(), "c3chef-pd-pack-"));
    extractDir = mkdtempSync(path.join(os.tmpdir(), "c3chef-pd-extract-"));

    // Windows needs the `.cmd` shim, which only resolves with `shell: true`.
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npmCmd, ["pack", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    expect(tarballs, "npm pack should produce exactly one tarball").to.have.lengthOf(1);

    // GNU tar (Git for Windows) reads `C:/...` as a remote host without `--force-local`.
    execFileSync("tar", ["--force-local", "-xzf", path.join(packDir, tarballs[0]), "-C", extractDir], {
      encoding: "utf8",
    });

    pkgRoot = path.join(extractDir, "package");
    packedMd = walkMd(pkgRoot, pkgRoot).sort();
  });

  after(function () {
    const rm = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
    if (packDir) rmSync(packDir, rm);
    if (extractDir) rmSync(extractDir, rm);
  });

  it("PD387-R2: the packed .md set equals the external set in the source tree, with no raw/ entry", () => {
    const expected = externalSetFromSource();
    expect(expected.length, "the expected set must not be an empty walk").to.be.at.least(8);
    expect(packedMd).to.deep.equal(expected);
    expect(existsSync(path.join(pkgRoot, "raw")), "raw/ must not be packed").to.equal(false);
    expect(packedMd.filter((f) => f.startsWith("raw/"))).to.deep.equal([]);
  });

  it("PD387-R3: every relative link in every packed .md file resolves to a packed file", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const rel of packedMd) {
      const text = readFileSync(path.join(pkgRoot, rel), "utf8").replace(/```[^]*?```/g, "");
      const dir = path.dirname(path.join(pkgRoot, rel));
      for (const target of extractLinkTargets(text)) {
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        checked++;
        const file = target.split("#")[0];
        const abs = path.resolve(dir, file);
        const inside = abs === pkgRoot || abs.startsWith(pkgRoot + path.sep);
        if (!inside || !existsSync(abs)) offenders.push(`${rel} -> ${target}`);
      }
    }
    expect(checked, "positive control: the link regex must see relative links").to.be.greaterThan(20);
    expect(offenders, `links that leave the packed set:\n  ${offenders.join("\n  ")}`).to.deep.equal([]);
  });

  it("PD387-R3b: the link extractor reads titled, angle-bracket and reference-style links", () => {
    const text = [
      `[a](../x.md "a title") and [b](<../y.md>) and [c](../z.md)`,
      `[ref]: ../w.md`,
      `  [other]: <../v.md> "t"`,
    ].join("\n");
    expect(extractLinkTargets(text)).to.deep.equal(["../x.md", "../y.md", "../z.md", "../w.md", "../v.md"]);
  });

  it("PD387-R4: exposeDocs on the packed package lists only the external tier", async () => {
    const serverSrc = readFileSync(path.join(REPO_ROOT, "src", "mcp", "server.ts"), "utf8");
    const literal = 'exposeDocs(server, __pkgDir, { docsDir: "wiki", recursive: true })';
    expect(serverSrc.split(literal).length - 1, "server.ts must hold the exposeDocs call exactly once").to.equal(1);

    const server = new McpServer({ name: "packagedDocs-test", version: "0.0.0" });
    exposeDocs(server, pkgRoot, { docsDir: "wiki", recursive: true });
    const client = new Client({ name: "packagedDocs-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const listed = (await client.listResources()).resources.map((r) => r.uri).sort();
      const referenceStems = packedMd
        .filter((f) => f.startsWith("wiki/reference/"))
        .map((f) => path.posix.basename(f, ".md"));
      const expected = [
        "docs:///readme",
        "docs:///index",
        ...referenceStems.map((s) => `docs:///reference/${s}`),
      ].sort();
      expect(listed).to.deep.equal(expected);

      for (const uri of [
        "docs:///index",
        "docs:///reference/cli",
        "docs:///reference/recipe-reference",
        "docs:///reference/ops",
      ]) {
        expect(listed, `${uri} must stay listed`).to.include(uri);
      }

      // Positive control: a served doc reads, so the failure below is the missing doc.
      const ok = await client.readResource({ uri: "docs:///reference/cli" });
      expect(ok.contents.length, "docs:///reference/cli must read").to.be.greaterThan(0);

      let caught: unknown;
      try {
        await client.readResource({ uri: "docs:///decisions/index" });
      } catch (e) {
        caught = e;
      }
      expect(caught, "reading docs:///decisions/index must fail").to.be.instanceOf(McpError);
      expect((caught as McpError).code).to.equal(ErrorCode.InvalidParams);
      expect((caught as McpError).message).to.match(/not found/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("PD387-R6: the source wiki has no dead link, out-of-bundle link, orphaned page or unreachable index", () => {
    const r = lintWiki(REPO_ROOT);
    expect(r.pageCount, "positive control: the linter must scan the real wiki").to.be.greaterThan(50);
    expect({
      dead: r.dead,
      outOfBundle: r.outOfBundle,
      orphans: r.orphans,
      unreachable: r.unreachable,
    }).to.deep.equal({ dead: [], outOfBundle: [], orphans: [], unreachable: [] });
  });
});
