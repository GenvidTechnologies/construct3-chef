#!/usr/bin/env node
// changelog-notice.mjs — decision engine for the advisory "Changelog Notice"
// CI check (#218, ADR 0039): flags a PR that carries a user-visible change
// with no `[Unreleased]` CHANGELOG entry and no mandatory-reason opt-out.
//
// Node builtins only, deliberately: the workflow invokes this script directly
// via `node`, WITHOUT an `npm ci` step first, so a single non-`node:` import
// would break every run before the check even starts.
//
// "User-visible" is a DENY-LIST (transferring ADR 0038's reasoning): a change
// is user-visible unless its Conventional-Commit type is one of
// `docs`/`style`/`test`/`chore` AND it touches no file under `src/`. An
// unknown/new type (`perf:`, `build:`, a typo) gates by default, and a `!`
// breaking marker gates unconditionally — an allow-list would silently stop
// gating anything added after it was written.
//
// `decide()`'s `reason` is one of exactly five values:
//   "exempt"                 — not gated at all (docs/style/test/chore, no src/ touch)
//   "entry-added"             — gated, but an [Unreleased] bullet was added
//   "opted-out"               — gated, no new bullet, but a `Changelog: none — <reason>`
//                                line was found in the PR body
//   "missing-entry"           — gated, no new bullet, no opt-out
//   "missing-entry-breaking"  — same as above, but the change is breaking (`!`)
//
// See wiki/decisions/0039-<slug>.md for the full design rationale.
//
//   node scripts/changelog-notice.mjs --base-ref <ref> --title <s> [--body <s>]
//   node scripts/changelog-notice.mjs --check-tags

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXEMPT_TYPES = new Set(["docs", "style", "test", "chore"]);
export const MATERIAL_PATHS = ["src/"];

// Mandatory, non-empty reason: `(\S.*)` requires the capture to START with a
// non-whitespace character, so a bare "Changelog: none" (no dash at all) or a
// dash followed only by whitespace never matches — both must still gate.
export const OPTOUT_RE = /^Changelog:\s*none\s*[-–—]\s*(\S.*)$/im;

/**
 * Parse a Conventional Commit subject line into its type and breaking flag.
 * A malformed subject (no recognizable `type: ` prefix, or an uppercase
 * type) yields `{ type: null, breaking: false }` — deliberately, since
 * `decide()` treats an unparsable subject as gating by default.
 */
export function parseSubject(title) {
  const m = /^([a-z]+)(\([^)]*\))?(!)?:\s/.exec(title ?? "");
  if (!m) return { type: null, breaking: false };
  return { type: m[1], breaking: m[3] === "!" };
}

/**
 * Extract the `[Unreleased]` section's top-level bullet lines (lines
 * starting with `- ` at column 0 — a wrapped bullet's continuation lines are
 * indented and excluded) from a CHANGELOG.md's full text. Returns `[]` if
 * the file has no `## [Unreleased]` heading.
 */
export function getUnreleasedBullets(changelogText) {
  const heading = "## [Unreleased]";
  const start = changelogText.indexOf(heading);
  if (start === -1) return [];
  const rest = changelogText.slice(start + heading.length);
  const nextHeading = /\n## \[/.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return section
    .split("\n")
    .filter((line) => /^- /.test(line))
    .map((line) => line.trim());
}

/** Count of `[Unreleased]` bullets — a thin wrapper over `getUnreleasedBullets`. */
export function countUnreleasedBullets(changelogText) {
  return getUnreleasedBullets(changelogText).length;
}

/**
 * Decide whether a PR needs a CHANGELOG entry, and whether it's missing one.
 *
 * `changedFiles` — repo-relative paths changed by the PR.
 * `baseBullets` / `headBullets` — `[Unreleased]` bullet arrays (see
 * `getUnreleasedBullets`) from the PR's base and head CHANGELOG.md.
 * `body` — the PR body; may be `null` in the GitHub webhook payload.
 */
export function decide({ title, changedFiles, baseBullets, headBullets, body }) {
  const { type, breaking } = parseSubject(title);
  const material = changedFiles.some((f) => MATERIAL_PATHS.some((p) => f.startsWith(p)));
  // A DENY-list: gated unless proven exempt. Anything unrecognized gates.
  const gated = breaking || type === null || !EXEMPT_TYPES.has(type) || material;

  if (!gated) {
    return { gated: false, flagged: false, reason: "exempt" };
  }

  // ⚠️ A disjunction, never a Set difference: `headBullets.length >
  // baseBullets.length` alone catches an added bullet that happens to
  // collide textually with an existing one (rare but possible), and the
  // `.some(...)` half catches a bullet that's new text even when the count
  // is unchanged (e.g. a bullet was also removed in the same PR). Collapsing
  // this into a deduped-set comparison would report "no change" when a PR
  // adds a bullet identical to one that's already there — the false-GREEN
  // trap this repo's CLAUDE.md § Conventions names explicitly.
  const added = headBullets.length > baseBullets.length || headBullets.some((b) => !baseBullets.includes(b));
  if (added) {
    return { gated: true, flagged: false, reason: "entry-added" };
  }

  const optOut = OPTOUT_RE.exec(body ?? "");
  if (optOut) {
    return { gated: true, flagged: false, reason: "opted-out", justification: optOut[1].trim() };
  }

  return { gated: true, flagged: true, reason: breaking ? "missing-entry-breaking" : "missing-entry" };
}

/**
 * Check every `[X.Y.Z]:` link-reference operand in a CHANGELOG's text
 * against the repo's actual git tags. The in-flight release version (i.e.
 * the version currently in `package.json`, formatted as `vX.Y.Z`) is
 * SKIPPED rather than checked — that tag genuinely does not exist yet
 * between the version-bump merge and the tag push, on every release, not
 * just the currently-untagged one.
 */
export function checkLinkRefs(tags, changelogText, currentVersion) {
  const tagSet = new Set(tags);
  const currentTag = `v${currentVersion}`;

  // A `[X.Y.Z]: <url>` block's URL is what actually names the git tags being
  // relied on — a compare link carries TWO operands (the previous release and
  // this one), a bare `releases/tag/vX.Y.Z` link carries one. The bracket
  // LABEL itself is not enough to check: it's editorial text that can drift
  // out of sync with the URL it introduces (exactly what the mutation proof
  // below exercises), so every `vX.Y.Z` token inside the URL is pulled out
  // and deduped across the whole block.
  const linkRefLines = [...changelogText.matchAll(/^\[\d+\.\d+\.\d+\]:\s*(.+)$/gm)].map((m) => m[1]);
  const operandSet = new Set();
  for (const line of linkRefLines) {
    for (const m of line.matchAll(/v\d+\.\d+\.\d+/g)) operandSet.add(m[0]);
  }

  const operands = [...operandSet];
  const skipped = operands.filter((v) => v === currentTag);
  const remaining = operands.filter((v) => v !== currentTag);
  const dangling = remaining.filter((v) => !tagSet.has(v));
  const checkedOk = remaining.length - dangling.length;

  return { checkedOk, skipped, dangling };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check-tags") args.checkTags = true;
    else if (a === "--base-ref") args.baseRef = argv[++i];
    else if (a === "--title") args.title = argv[++i];
    else if (a === "--body") args.body = argv[++i];
  }
  return args;
}

function readChangelogAt(ref) {
  try {
    return execFileSync("git", ["show", `${ref}:CHANGELOG.md`], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    // The base ref may not carry a CHANGELOG.md at all (or the ref itself
    // may not resolve) — treat that as an empty [Unreleased] section rather
    // than failing the whole check.
    return "";
  }
}

function printVerdict(verdict, ctx) {
  console.log("Changelog Notice — verdict");
  console.log(`  title: ${ctx.title}`);
  console.log(`  changed files: ${ctx.changedFiles.length}${ctx.material ? " (touches src/)" : ""}`);
  console.log(`  [Unreleased] bullets: base ${ctx.baseBullets.length}, head ${ctx.headBullets.length}`);
  console.log(`  gated: ${verdict.gated}`);
  console.log(`  flagged: ${verdict.flagged}`);
  console.log(`reason: ${verdict.reason}`);
  if (verdict.justification) console.log(`  justification: ${verdict.justification}`);
  if (verdict.flagged) {
    console.log("");
    console.log(
      verdict.reason === "missing-entry-breaking"
        ? "This looks like a BREAKING, user-visible change with no [Unreleased] entry."
        : "This looks like a user-visible change with no [Unreleased] entry.",
    );
    console.log('Add a bullet under "## [Unreleased]" in CHANGELOG.md, or opt out with a PR-body line:');
    console.log('  Changelog: none — <reason>');
  }
}

function runDecide(args) {
  if (!args.baseRef || args.title === undefined) {
    console.error("usage: changelog-notice.mjs --base-ref <ref> --title <string> [--body <string>]");
    process.exitCode = 1;
    return;
  }

  const changedFiles = execFileSync("git", ["diff", "--name-only", args.baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const changelogPath = path.join(REPO_ROOT, "CHANGELOG.md");
  const headChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const baseChangelog = readChangelogAt(args.baseRef);

  const baseBullets = getUnreleasedBullets(baseChangelog);
  const headBullets = getUnreleasedBullets(headChangelog);
  const material = changedFiles.some((f) => MATERIAL_PATHS.some((p) => f.startsWith(p)));

  const verdict = decide({ title: args.title, changedFiles, baseBullets, headBullets, body: args.body });

  printVerdict(verdict, { title: args.title, changedFiles, baseBullets, headBullets, material });
  process.exitCode = verdict.flagged ? 1 : 0;
}

function runCheckTags() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const changelogText = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const tags = execFileSync("git", ["tag", "-l"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const { checkedOk, skipped, dangling } = checkLinkRefs(tags, changelogText, pkg.version);

  console.log(`checked-ok ${checkedOk} | skipped(in-flight) ${skipped.join(", ") || "none"} | dangling ${dangling.length}`);
  if (dangling.length > 0) {
    console.error(`dangling CHANGELOG link-ref(s) with no matching git tag: ${dangling.join(", ")}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkTags) {
    runCheckTags();
  } else {
    runDecide(args);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
