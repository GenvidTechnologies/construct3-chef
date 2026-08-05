#!/usr/bin/env node
// verify-fixture-parity.mjs — prove the materialized C3 test fixture still equals
// the canonical `construct3-sample` submodule, modulo chef's own overlay.
//
// `prep-fixture.mjs` is copy-only (`fs.cpSync`) and never deletes, so a canonical
// pin bump that *removes* a file leaves the stale copy on disk — gitignored, and
// therefore invisible to `git status`. This script is the oracle for that drift:
// run it after every `npm run fixture:prep`, and unconditionally as step 0 of the
// canonical pin-update protocol (see CLAUDE.md § Fixture materialization).
//
// Four assertions, all of which always run (no short-circuit — the point is a
// complete report). Exit code is 1 if any of them fails:
//   1. zero `*.uistate.json` files under the fixture
//   2. zero directories named `uistate` under the fixture
//   3. exactly 12 git-tracked overlay files under the fixture
//   4. the strong oracle — a recursive path-set + byte compare of the submodule's
//      `project/` tree against the fixture, excluding chef's overlay basenames
//
// Node rather than `find`/`diff -rq` on purpose: the shell-agnostic form is the
// only one runnable from both PowerShell and bash, and `prep-fixture.mjs` is the
// precedent. It is not a mocha test — it depends on the submodule already being
// materialized, which is `pretest`'s (i.e. `prep-fixture.mjs`'s) job.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const submodule = path.join(repoRoot, "test", "fixtures", "construct3-sample");
const source = path.join(submodule, "project");
const fixture = path.join(repoRoot, "test", "fixtures", "construct3-chef-sample");
const fixtureRel = "test/fixtures/construct3-chef-sample";

// Chef's own overlay / separately-copied trees. Excluded from the strong oracle by
// BASENAME at any depth: `extracted/` is the generated read surface (it exists in
// neither canonical tree), `archive-sources/` is copied out of the submodule ROOT
// rather than out of `project/`, and `c3-reference` is reference material.
const OVERLAY_BASENAMES = new Set(["extracted", "archive-sources", "c3-reference"]);

const EXPECTED_TRACKED_FILES = 12;

// Walk a tree, returning project-relative POSIX paths for every file and every
// directory, sorted. `exclude` is matched on the entry's basename at any depth.
function walk(root, exclude = new Set()) {
	const files = [];
	const dirs = [];
	const recurse = (abs, rel) => {
		for (const entry of readdirSync(abs, { withFileTypes: true })) {
			if (exclude.has(entry.name)) continue;
			const childAbs = path.join(abs, entry.name);
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				dirs.push(childRel);
				recurse(childAbs, childRel);
			} else {
				files.push(childRel);
			}
		}
	};
	recurse(root, "");
	files.sort();
	dirs.sort();
	return { files, dirs };
}

// Each assertion reports as { name, ok, details } — `details` is a flat list of
// pre-formatted lines printed under a failure.
const results = [];
function report(name, ok, details = []) {
	results.push({ name, ok, details });
}

if (!existsSync(fixture)) {
	console.error(`verify-fixture-parity: ${fixtureRel} does not exist — run \`npm run fixture:prep\` first.`);
	process.exit(1);
}

const fixtureTree = walk(fixture);

// 1. Stale editor-local `*.uistate.json` files. The canonical `project/` tree
//    carries none; any hit is a leftover from a pre-#130 pin.
const uistateFiles = fixtureTree.files.filter((p) => path.basename(p).endsWith(".uistate.json"));
report(
	"no *.uistate.json files under the fixture",
	uistateFiles.length === 0,
	[`found ${uistateFiles.length}:`, ...uistateFiles.map((p) => `  ${fixtureRel}/${p}`)],
);

// 2. Stale editor-local `uistate/` directories, same provenance as (1).
const uistateDirs = fixtureTree.dirs.filter((p) => path.basename(p) === "uistate");
report(
	"no uistate/ directories under the fixture",
	uistateDirs.length === 0,
	[`found ${uistateDirs.length}:`, ...uistateDirs.map((p) => `  ${fixtureRel}/${p}`)],
);

// 3. The tracked overlay. Everything else under the fixture is gitignored; chef
//    tracks only its own `extracted/` rendering, nothing canonical.
const tracked = execFileSync("git", ["ls-files", fixtureRel], { cwd: repoRoot })
	.toString()
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);
report(
	`exactly ${EXPECTED_TRACKED_FILES} tracked overlay files under the fixture`,
	tracked.length === EXPECTED_TRACKED_FILES,
	[`found ${tracked.length}:`, ...tracked.map((p) => `  ${p}`)],
);

// 4. THE STRONG ORACLE — the submodule's `project/` tree is the source of truth.
//    Both directions are reported separately because they mean different things:
//      - `only in submodule` => materialization is BROKEN (prep didn't copy it)
//      - `only in fixture`   => copy-only leftovers from an earlier pin
//    Bytes are compared too: a path-set match alone would miss a partial copy.
if (!existsSync(source) || walk(source).files.length === 0) {
	report("fixture matches the canonical submodule tree (paths + bytes)", false, [
		`the canonical submodule tree is missing or empty: ${path.relative(repoRoot, source).replace(/\\/g, "/")}`,
		"run `npm run fixture:prep` to initialize and materialize it.",
	]);
} else {
	const canonical = walk(source, OVERLAY_BASENAMES);
	const compared = walk(fixture, OVERLAY_BASENAMES);
	const canonicalSet = new Set(canonical.files);
	const comparedSet = new Set(compared.files);

	const onlyInSubmodule = canonical.files.filter((p) => !comparedSet.has(p));
	const onlyInFixture = compared.files.filter((p) => !canonicalSet.has(p));

	const byteMismatches = [];
	for (const rel of canonical.files) {
		if (!comparedSet.has(rel)) continue;
		const a = path.join(source, rel);
		const b = path.join(fixture, rel);
		// Cheap size pre-check before reading both files.
		if (statSync(a).size !== statSync(b).size || Buffer.compare(readFileSync(a), readFileSync(b)) !== 0) {
			byteMismatches.push(rel);
		}
	}

	const details = [];
	const section = (label, entries) => {
		if (entries.length === 0) return;
		details.push(`${label} (${entries.length}):`);
		details.push(...entries.map((p) => `  ${p}`));
	};
	section("only in submodule (materialization is broken)", onlyInSubmodule);
	section("only in fixture (copy-only leftovers)", onlyInFixture);
	section("byte mismatch", byteMismatches);
	report(
		"fixture matches the canonical submodule tree (paths + bytes)",
		onlyInSubmodule.length === 0 && onlyInFixture.length === 0 && byteMismatches.length === 0,
		details,
	);
}

// Report every assertion, passing or failing, in declaration order.
console.log(`verify-fixture-parity: ${fixtureRel} vs test/fixtures/construct3-sample/project`);
console.log("");
results.forEach(({ name, ok, details }, i) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${i + 1}. ${name}`);
	if (!ok) {
		for (const line of details) console.log(`        ${line}`);
	}
});

const failed = results.filter((r) => !r.ok).length;
console.log("");
if (failed > 0) {
	console.log(`verify-fixture-parity: ${failed} of ${results.length} assertions FAILED.`);
	console.log(
		"remediate with `git clean -fdX -- test/fixtures/construct3-chef-sample/` then `npm run fixture:prep` " +
			"(prep is copy-only and never deletes).",
	);
	process.exitCode = 1;
} else {
	console.log(`verify-fixture-parity: all ${results.length} assertions passed.`);
}
