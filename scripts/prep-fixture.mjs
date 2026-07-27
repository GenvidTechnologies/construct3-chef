#!/usr/bin/env node
// prep-fixture.mjs — materialize the working C3 test fixture from the canonical
// `construct3-sample` submodule.
//
// Copies two trees out of the submodule:
//   - `<submodule>/project/`         -> the fixture root (the canonical C3 project)
//   - `<submodule>/archive-sources/` -> `<fixture>/archive-sources/` (the bundled
//     addons' source trees, used as extracted-addon-dir test inputs)
//
// Chef's only local overlay is the `extracted/` golden read-surface, which does
// not exist in either canonical tree, so a recursive copy never overwrites it.
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
const archiveSources = path.join(submodule, "archive-sources");
const dest = path.join(repoRoot, "test", "fixtures", "construct3-chef-sample");

// 1. Self-init the submodule at its pinned gitlink commit. Idempotent: a no-op
//    when already initialized and current. No `--depth 1` — a shallow update can
//    fail with "reference is not a tree" when the pinned commit is not the remote
//    branch tip, and the fixture repo is small enough that a full fetch is cheap.
//
//    `.gitmodules` uses the ssh remote so maintainers can push straight from the
//    submodule. CI can't: the runner authenticates over https with GITHUB_TOKEN
//    and has no ssh key, so ssh would fail `Permission denied (publickey)` —
//    same-org membership grants authorization, not an ssh credential. Rewrite
//    ssh->https for this invocation only when running in CI (construct3-sample
//    is public, so anonymous https works). `-c` propagates to the child clone via
//    GIT_CONFIG_PARAMETERS and leaves the developer's config untouched.
const sshToHttps = process.env.CI
  ? `-c url."https://github.com/GenvidTechnologies/".insteadOf=git@github.com:GenvidTechnologies/ `
  : "";
execSync(`git ${sshToHttps}submodule update --init -- "${submodule}"`, { cwd: repoRoot, stdio: "inherit" });

// 2. Materialize the canonical `project/` bytes over the fixture root, then the
//    bundled addons' `archive-sources/` trees beside them. Both are name-disjoint
//    from chef's `extracted/` overlay, so it is never touched.
//
//    `archive-sources/` must land INSIDE the fixture root, not be referenced in
//    the submodule: `resolveAddonTarget` (src/c3/addonDiscovery.ts) containment-
//    guards an extracted-addon-dir path with `resolveWithin(projectRoot, ...)`,
//    so a `--from` pointing outside the root is rejected. Keeping the path at
//    `<fixture>/archive-sources/<id>` is what lets the scan-addon-usage
//    blast-radius tests address it unchanged.
cpSync(source, dest, { recursive: true });
cpSync(archiveSources, path.join(dest, "archive-sources"), { recursive: true });

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
