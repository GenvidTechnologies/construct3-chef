#!/usr/bin/env node
// prep-fixture.mjs — materialize the working C3 test fixture from the canonical
// `construct3-sample` submodule.
//
// Copies `<submodule>/project/` over `test/fixtures/construct3-chef-sample/`,
// leaving chef's local overlay (the `extracted/` golden read-surface,
// `archive-sources/`, `build-archive.mjs`) untouched — those paths do not exist
// in the canonical `project/`, so a recursive copy never overwrites them.
//
// Wired as the `pretest` / `pretest:file` npm hook, so a plain `npm test`
// materializes the fixture even on a fresh clone that forgot
// `--recurse-submodules`, and in CI (the shared `node-gate.yml` checks out no
// submodules by default) — step 1 self-inits the submodule.
//
// KNOWN LIMITATION — stale-file drift. This is a copy-only materialization
// (`fs.cpSync`); it never deletes. If a future canonical pin *removes* a file a
// prior pin shipped, the stale copy lingers on disk (gitignored, so invisible to
// `git status`). After a pin bump that drops files, reset first with:
//   git clean -fdX -- test/fixtures/construct3-chef-sample/
// then re-run this script.

import { execSync } from "node:child_process";
import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const submodule = path.join(repoRoot, "test", "fixtures", "construct3-sample");
const source = path.join(submodule, "project");
const dest = path.join(repoRoot, "test", "fixtures", "construct3-chef-sample");

// 1. Self-init the submodule at its pinned gitlink commit. Idempotent: a no-op
//    when already initialized and current. No `--depth 1` — a shallow update can
//    fail with "reference is not a tree" when the pinned commit is not the remote
//    branch tip, and the fixture repo is small enough that a full fetch is cheap.
execSync(`git submodule update --init -- "${submodule}"`, { cwd: repoRoot, stdio: "inherit" });

// 2. Materialize the canonical `project/` bytes over the fixture root. The overlay
//    (extracted/, archive-sources/, build-archive.mjs) is name-disjoint from
//    project/, so it is never touched.
cpSync(source, dest, { recursive: true });

// 3. Report the materialized pin + file count, for operator / CI visibility.
const sha = execSync("git rev-parse HEAD", { cwd: submodule }).toString().trim();
let tag = sha;
try {
	tag = execSync("git describe --tags --exact-match HEAD", { cwd: submodule }).toString().trim();
} catch {
	// Detached at a non-tag commit — fall back to the bare SHA in the log line.
}
const fileCount = execSync("git ls-files", { cwd: source }).toString().trim().split("\n").filter(Boolean).length;
console.log(
	`prep-fixture: materialized construct3-sample@${tag} (${sha.slice(0, 10)}) — ${fileCount} files → test/fixtures/construct3-chef-sample`,
);
