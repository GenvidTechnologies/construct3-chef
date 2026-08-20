#!/usr/bin/env node
// Regenerates every index under the wiki bundle from the pages' own frontmatter.
//
// Each index entry's description IS the linked page's frontmatter `description`,
// so the index and the page cannot drift. That guarantee is stated in
// wiki/index.md and in wiki/wiki-schema.md; this script is what makes it true
// rather than aspirational — hand-editing an index reintroduces exactly the
// drift the generation exists to prevent.
//
//   node scripts/gen-wiki-index.mjs           # write the indexes
//   node scripts/gen-wiki-index.mjs --check   # exit 1 if any index is stale
//
// See wiki/decisions/0028-documentation-consolidated-into-the-wiki-tier.md.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Section directories, in the order they appear in the bundle-root index.
// Adding a section here is the only edit a new wiki subdirectory needs.
export const SECTIONS = {
  reference: [
    "Reference",
    "How to drive the tool: every CLI subcommand, the recipe format and its operations, the generator pipeline, and user-defined ops.",
  ],
  architecture: [
    "Architecture & research",
    "Why the MCP server is shaped the way it is, plus the preserved prior-art comparison it was designed against.",
  ],
  process: [
    "Process & contracts",
    "How the backlog is groomed, and the version-by-version record of what each upstream leaf-dependency release shipped and what chef did with it.",
  ],
  decisions: [
    "Decision records",
    "Numbered ADRs, chronological by when the decision landed (earliest first). 0001-0005 trace to the 2026-04-03 initial release, ordered by dependency.",
  ],
};

// index.md and log.md are reserved at every level (the same exclusion the OKF
// conformance walk uses), so lint and this generator agree on the page set.
const RESERVED = /^(index|log)\.md$/;

export function resolveWikiDir(repoRoot = REPO_ROOT) {
  const cfgPath = path.join(repoRoot, ".gvt-agent.json");
  if (!existsSync(cfgPath)) return "wiki";
  return JSON.parse(readFileSync(cfgPath, "utf8"))?.wiki?.wikiDir ?? "wiki";
}

export function readFrontmatter(file) {
  const s = readFileSync(file, "utf8");
  if (!s.startsWith("---\n")) throw new Error(`${file}: no frontmatter`);
  const end = s.indexOf("\n---\n", 4);
  if (end === -1) throw new Error(`${file}: unterminated frontmatter`);
  return yaml.load(s.slice(4, end + 1));
}

function pagesIn(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !RESERVED.test(f))
    .sort();
}

// Soft-wrap a one-line description so indexes stay readable in a plain editor.
function wrap(text, indent = "  ", width = 76) {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) out.push(line);
  return out.join("\n" + indent);
}

function entriesFor(absDir) {
  return pagesIn(absDir)
    .map((f) => {
      const meta = readFrontmatter(path.join(absDir, f));
      return `* [${meta.title}](${f}) -\n  ${wrap(meta.description)}`;
    })
    .join("\n");
}

/** Build every index file's content. Returns a Map of repo-relative path -> content. */
export function buildIndexes(repoRoot = REPO_ROOT) {
  const wikiDir = resolveWikiDir(repoRoot);
  const absWiki = path.join(repoRoot, wikiDir);
  const out = new Map();

  for (const [dir, [title, blurb]] of Object.entries(SECTIONS)) {
    const absDir = path.join(absWiki, dir);
    if (!existsSync(absDir)) continue;
    out.set(
      `${wikiDir}/${dir}/index.md`,
      `# ${title}\n\n${wrap(blurb, "", 78)}\n\n` +
        `See the [wiki index](../index.md) for the other sections.\n\n` +
        `${entriesFor(absDir)}\n`,
    );
  }

  const topLevel = (name) => {
    const meta = readFrontmatter(path.join(absWiki, name));
    return `* [${meta.title}](${name}) -\n  ${wrap(meta.description)}`;
  };
  const sectionList = Object.entries(SECTIONS)
    .filter(([d]) => existsSync(path.join(absWiki, d)))
    .map(([d, [t, b]]) => `* [${t}](${d}/index.md) -\n  ${wrap(b)}`)
    .join("\n");

  out.set(
    `${wikiDir}/index.md`,
    `---
okf_version: "0.2"
---

<!-- \`okf_version\` is the ONLY frontmatter key permitted here (§8/§12) — this
     file is the bundle-root index (\`${wikiDir}/index.md\`, the OKF bundle root per
     ADR-0022). A \`${wikiDir}/<subdir>/index.md\` carries NO frontmatter at all. -->

# Wiki Index

This is construct3-chef's **only** documentation tier: since the \`docs/\`
consolidation of 2026-08-20 (ADR
[0028](decisions/0028-documentation-consolidated-into-the-wiki-tier.md)) the
reference manuals, architecture and research notes, process docs, and decision
records all live here, alongside the durable knowledge that has no other repo
home. \`CLAUDE.md\` keeps only the always-loaded operating context and routes
here for everything else.

\`/gvt-dev:maintain-wiki\` keeps this list current: a new page is added here (or
to its subdirectory's own \`index.md\`) when it's created, and \`lint\` flags any
page listed in **no** index. Each entry's description is the linked page's
frontmatter \`description\`, so the index and the page can't drift — the indexes
are generated by \`npm run wiki:index\`, never hand-edited. See
[wiki-schema.md](wiki-schema.md) for the page format and maintenance rules.

## Sections

${sectionList}

## Contract

${topLevel("wiki-schema.md")}

## Practice

${topLevel("local-verification-practice.md")}

## C3 platform reference (the *why* behind the gotchas)

C3 platform reference — event-sheet & layout JSON structure, the scripting API,
the TS async/concurrency model — lives in the **gvt-construct3** Claude Code
plugin at \`\${CLAUDE_PLUGIN_ROOT}/docs/c3/*\`, not here. construct3-chef owns the
*tooling* knowledge above; the plugin owns the *platform* knowledge.
`,
  );

  return out;
}

function main() {
  const check = process.argv.includes("--check");
  const built = buildIndexes();
  const stale = [];

  for (const [rel, content] of built) {
    const abs = path.join(REPO_ROOT, rel);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (current === content) continue;
    stale.push(rel);
    if (!check) writeFileSync(abs, content);
  }

  if (check) {
    if (stale.length) {
      console.error(`Stale wiki indexes (run \`npm run wiki:index\`):\n  ${stale.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log(`wiki indexes up to date (${built.size} checked)`);
    }
    return;
  }
  console.log(stale.length ? `rewrote ${stale.length} of ${built.size} indexes` : `all ${built.size} indexes already current`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
