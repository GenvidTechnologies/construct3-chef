#!/usr/bin/env node
// Advisory health check of the wiki bundle. ALWAYS exits 0.
//
// This is the repo-local counterpart of `/gvt-dev:maintain-wiki lint`, and it
// inherits that verb's binding constraint: the bundle is OKF v0.2 and this is an
// OKF *consumer*, so §11 forbids rejecting a bundle for a broken cross-link, a
// missing index.md, an unknown `type`, unknown extra frontmatter keys, or a
// missing optional field. Reporting any of those is fully conformant; failing on
// them is not. Hence: no non-zero exit, no strict mode, ever.
//
// The one thing this repo DOES gate on lives in the test suite, not here —
// `test/wiki/wikiBundle.test.ts` asserts the indexes match `gen-wiki-index.mjs`
// output. That is local generation policy (documented in wiki/wiki-schema.md),
// not an OKF conformance claim, which is why it is allowed to fail a build.
//
//   node scripts/wiki-lint.mjs
//
// See wiki/decisions/0028-documentation-consolidated-into-the-wiki-tier.md.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveWikiDir } from "./gen-wiki-index.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slash = (p) => p.split(path.sep).join("/");

// Link-shaped text inside fenced blocks and inline code spans is an EXAMPLE, not
// a link. Stripping both is the whole difference between a real finding and a
// false one: without it, this repo's own schema/ADR prose (which quotes broken
// link forms deliberately) reports as four dead links against a correct bundle.
const FENCE = new RegExp("```[^]*?```", "g");
const CODE = new RegExp("`[^`\n]*`", "g");
const stripCode = (s) => s.replace(FENCE, "").replace(CODE, "");

const RESERVED = /^(index|log)\.md$/;
const EXTERNAL = /^(https?:|mailto:|#|\$\{)/;

function walk(dir) {
  return readdirSync(dir)
    .flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    })
    .filter((f) => f.endsWith(".md"))
    .map(slash);
}

function frontmatter(file) {
  const s = readFileSync(file, "utf8");
  if (!s.startsWith("---\n")) return null;
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) return null;
  try {
    return yaml.load(s.slice(4, end + 1));
  } catch {
    return null;
  }
}

// §6.1: `/x.md` is BUNDLE-absolute (rooted at wikiDir), not filesystem-absolute.
// A naive resolver treating it as filesystem-absolute is the failure to avoid.
function resolveTarget(target, fromDir, absWiki) {
  return target.startsWith("/")
    ? slash(path.join(absWiki, target.slice(1)))
    : slash(path.normalize(path.join(fromDir, target)));
}

export function lintWiki(repoRoot = REPO_ROOT, today = new Date().toISOString().slice(0, 10)) {
  const wikiDir = resolveWikiDir(repoRoot);
  const absWiki = slash(path.join(repoRoot, wikiDir));
  if (!existsSync(absWiki)) return { missing: true, wikiDir };

  const all = walk(absWiki);
  const pages = all.filter((f) => !RESERVED.test(path.basename(f)));
  const indexes = all.filter((f) => path.basename(f) === "index.md");
  const dead = [];
  const outOfBundle = [];
  const stale = [];
  const noType = [];

  for (const f of all) {
    const body = stripCode(readFileSync(f, "utf8"));
    const dir = slash(path.dirname(f));
    for (const m of body.matchAll(/\]\(([^)\s]+?)(#[^)\s]*)?\)/g)) {
      const target = m[1];
      if (EXTERNAL.test(target)) continue;
      const abs = resolveTarget(target, dir, absWiki);
      const inBundle = abs === absWiki || abs.startsWith(absWiki + "/");
      const rel = slash(path.relative(repoRoot, f));
      if (!existsSync(abs)) dead.push(`${rel} -> ${target}`);
      else if (!inBundle) outOfBundle.push(`${rel} -> ${target}`);
    }
  }

  for (const f of pages) {
    const meta = frontmatter(f);
    const rel = slash(path.relative(repoRoot, f));
    if (!meta?.type) noType.push(rel);
    if (meta?.stale_after && today >= String(meta.stale_after)) stale.push(`${rel} (stale_after ${meta.stale_after})`);
  }

  // A page counts as listed if it appears in the bundle-root index OR in its own
  // subdirectory's index (§8 contemplates subdirectory indexes).
  const listed = new Set();
  for (const idx of indexes) {
    const dir = slash(path.dirname(idx));
    for (const m of stripCode(readFileSync(idx, "utf8")).matchAll(/\]\(([^)\s#]+\.md)/g)) {
      listed.add(resolveTarget(m[1], dir, absWiki));
    }
  }
  const orphans = pages.filter((p) => !listed.has(p)).map((p) => slash(path.relative(repoRoot, p)));
  const unreachable = indexes
    .filter((i) => i !== `${absWiki}/index.md` && !listed.has(i))
    .map((i) => slash(path.relative(repoRoot, i)));

  // raw/ is a local convention of this three-tier layout, NOT an OKF requirement
  // (rawDir sits outside the bundle). A capture is added or re-captured under a
  // new dated name; it is never edited in place.
  let rawModified = [];
  try {
    const rawDir = JSON.parse(readFileSync(path.join(repoRoot, ".gvt-agent.json"), "utf8"))?.wiki?.rawDir ?? "raw";
    const out = execFileSync("git", ["log", "--diff-filter=M", "--format=%h %s", "--", rawDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    rawModified = out.split("\n").filter(Boolean);
  } catch {
    rawModified = [];
  }

  return { wikiDir, pageCount: pages.length, indexCount: indexes.length, dead, outOfBundle, orphans, unreachable, stale, noType, rawModified };
}

function main() {
  const r = lintWiki();
  if (r.missing) {
    console.log(`No wiki at ${r.wikiDir}/ — nothing to check.`);
    return;
  }
  console.log(`wiki: ${r.pageCount} pages, ${r.indexCount} indexes\n`);
  const report = (label, items, note) => {
    console.log(`${items.length ? "FINDING" : "ok     "}  ${label}: ${items.length}${note && items.length ? `  (${note})` : ""}`);
    for (const i of items) console.log(`    ${i}`);
  };
  report("dead links", r.dead, "advisory per §6.1 — may be knowledge not yet written");
  report("out-of-bundle links", r.outOfBundle, "legal, but unresolvable to an external OKF consumer");
  report("orphaned pages", r.orphans);
  report("unreachable subdir indexes", r.unreachable);
  report("stale pages", r.stale);
  report("pages with no frontmatter type", r.noType);
  report("raw/ files modified after add", r.rawModified, "raw/ is append-only");
  console.log("\nAdvisory only — this check never fails a build (OKF §11).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
