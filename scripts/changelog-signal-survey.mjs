#!/usr/bin/env node
// changelog-signal-survey.mjs — keep-around instrument that replays
// `decide()` (scripts/changelog-notice.mjs, #218/ADR 0039) over a historical
// commit range, to measure how it would have classified real squash merges.
//
// For each commit in `<since>..HEAD` (default `99a80aa..origin/main`), the
// real inputs `decide()` needs are re-derived from git history:
//   title         — the squash subject          (git log -1 --format=%s)
//   body          — the squash body             (git log -1 --format=%b)
//   changedFiles  — files touched by the commit (git show --name-only)
//   baseBullets   — [Unreleased] bullets at `<sha>^`
//   headBullets   — [Unreleased] bullets at `<sha>`
//
// `CHANGELOG.md` did not exist before 99a80aa, so `git show <ref>:CHANGELOG.md`
// is expected to fail on the earliest commits in the window — that failure is
// treated as an empty [Unreleased] section (no bullets), not an error.
//
//   node scripts/changelog-signal-survey.mjs [--since <ref>] [--emit-fixture <path>]

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, getUnreleasedBullets } from "./changelog-notice.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SINCE = "99a80aa";
const DEFAULT_UNTIL = "origin/main";

function parseArgs(argv) {
  const args = { since: DEFAULT_SINCE, until: DEFAULT_UNTIL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") args.since = argv[++i];
    else if (a === "--until") args.until = argv[++i];
    else if (a === "--emit-fixture") args.emitFixture = argv[++i];
  }
  return args;
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function readChangelogAt(ref) {
  try {
    return git(["show", `${ref}:CHANGELOG.md`]);
  } catch {
    // No CHANGELOG.md at this ref yet (true for every commit before it was
    // added at 99a80aa) — treat as an empty [Unreleased] section.
    return "";
  }
}

function surveyCommit(sha) {
  const title = git(["log", "-1", "--format=%s", sha]).trim();
  const body = git(["log", "-1", "--format=%b", sha]);
  const changedFiles = git(["show", "--name-only", "--format=", sha])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const baseBullets = getUnreleasedBullets(readChangelogAt(`${sha}^`));
  const headBullets = getUnreleasedBullets(readChangelogAt(sha));

  const verdict = decide({ title, changedFiles, baseBullets, headBullets, body });
  const touchesSrc = changedFiles.some((f) => f.startsWith("src/"));

  return { sha, title, body, changedFiles, touchesSrc, baseBullets, headBullets, verdict };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = `${args.since}..${args.until}`;
  const shas = git(["log", "--format=%H", range])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // git log prints newest-first; walk oldest-first for a readable table.
    .reverse();

  const rows = shas.map(surveyCommit);

  console.log(`Changelog signal survey — ${range} (${rows.length} commits)`);
  console.log("");
  for (const row of rows) {
    const short = row.sha.slice(0, 7);
    const flag = row.verdict.flagged ? "FLAGGED" : row.verdict.gated ? "gated  " : "exempt ";
    console.log(`${short}  ${flag}  ${row.verdict.reason.padEnd(24)}  ${row.title}`);
  }

  const gated = rows.filter((r) => r.verdict.gated).length;
  const flagged = rows.filter((r) => r.verdict.flagged);

  console.log("");
  console.log(`total: ${rows.length}  gated: ${gated}  flagged: ${flagged.length}`);
  if (flagged.length > 0) {
    console.log(`flagged SHAs: ${flagged.map((r) => r.sha.slice(0, 7)).join(", ")}`);
  }

  if (args.emitFixture) {
    const fixtureRows = rows.map((r) => ({
      sha: r.sha.slice(0, 7),
      subject: r.title,
      type: /^([a-z]+)(\([^)]*\))?(!)?:\s/.exec(r.title ?? "")?.[1] ?? null,
      breaking: /^[a-z]+(\([^)]*\))?!:/.test(r.title ?? ""),
      touchesSrc: r.touchesSrc,
      baseUnreleasedBullets: r.baseBullets.length,
      headUnreleasedBullets: r.headBullets.length,
      hasOptOut: r.verdict.reason === "opted-out",
      expectedGated: r.verdict.gated,
      expectedFlagged: r.verdict.flagged,
    }));
    writeFileSync(args.emitFixture, JSON.stringify(fixtureRows, null, 2) + "\n", { encoding: "utf8" });
    console.log("");
    console.log(`wrote ${fixtureRows.length} rows to ${args.emitFixture}`);
  }
}

main();
