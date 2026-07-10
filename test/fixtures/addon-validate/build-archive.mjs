#!/usr/bin/env node
// Deterministically (re)generates the `.c3addon` fixtures under
// `addons/plugin/` used by `test/c3/addonValidator.test.ts`. Archives are
// produced: five real zip addons built from `archive-sources/` (a clean one,
// one whose manifest version drifts from project.c3proj, one whose
// addon.json id doesn't match its package filename, one clean-but-orphaned
// package with no matching `usedAddons` entry, and one clean package
// duplicated at both `addons/plugin/Dup.c3addon` and
// `addons/plugin/nested/Dup.c3addon` — identical bytes, to exercise the
// recursive duplicate-id walk), one real zip archive deliberately missing its
// `aces.json` entry, one corrupt (non-zip) archive, and one un-materialized
// git-lfs pointer file. Run with:
// `node test/fixtures/addon-validate/build-archive.mjs`.
//
// Zip entries are written with a fixed mtime (DOS zip timestamps only cover
// 1980-2099, so the Unix epoch isn't valid) so re-running this script on
// unchanged sources produces byte-identical archives.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcesDir = path.join(here, "archive-sources");
const pluginDir = path.join(here, "addons", "plugin");

const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

function readEntry(dir, entryName) {
  return fs.readFileSync(path.join(dir, entryName));
}

/**
 * Zips `archive-sources/<sourceName>/`'s `addon.json`, `aces.json`, and
 * `c3runtime/plugin.js` into a single deterministic buffer.
 */
function buildZipData(sourceName) {
  const srcDir = path.join(sourcesDir, sourceName);
  return zipSync(
    {
      "addon.json": [readEntry(srcDir, "addon.json"), { mtime: FIXED_MTIME }],
      "aces.json": [readEntry(srcDir, "aces.json"), { mtime: FIXED_MTIME }],
      "c3runtime/plugin.js": [readEntry(srcDir, path.join("c3runtime", "plugin.js")), { mtime: FIXED_MTIME }],
    },
    { mtime: FIXED_MTIME },
  );
}

/**
 * Builds a `<name>.c3addon` zip from `archive-sources/<sourceName>/`,
 * including `addon.json`, `aces.json`, and `c3runtime/plugin.js`.
 */
function buildFullAddon(sourceName, outName) {
  fs.writeFileSync(path.join(pluginDir, `${outName}.c3addon`), buildZipData(sourceName));
}

/**
 * Dup.c3addon (+ nested/Dup.c3addon) — a clean addon written to two
 * locations with byte-identical content, to exercise the recursive
 * duplicate-id detection (which the flat `addons/plugin/` walk alone can't).
 */
function buildDup() {
  const zipData = buildZipData("Dup");
  fs.writeFileSync(path.join(pluginDir, "Dup.c3addon"), zipData);
  const nestedDir = path.join(pluginDir, "nested");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, "Dup.c3addon"), zipData);
}

/**
 * MissingAces.c3addon — a real, valid zip archive that deliberately has no
 * `aces.json` entry. Proves the "missing required entry" integrity check.
 */
function buildMissingAces() {
  const srcDir = path.join(sourcesDir, "MissingAces");
  const zipData = zipSync(
    {
      "addon.json": [readEntry(srcDir, "addon.json"), { mtime: FIXED_MTIME }],
    },
    { mtime: FIXED_MTIME },
  );
  fs.writeFileSync(path.join(pluginDir, "MissingAces.c3addon"), zipData);
}

/**
 * CorruptZip.c3addon — raw bytes that are not a valid zip at all. Proves the
 * malformed-zip integrity check.
 */
function buildCorruptZip() {
  fs.writeFileSync(path.join(pluginDir, "CorruptZip.c3addon"), Buffer.from("this is not a zip file\n", "utf-8"));
}

/**
 * LfsPointer.c3addon — an un-materialized git-lfs pointer file (what you get
 * when a repo has git-lfs-tracked `.c3addon` archives and `git lfs pull` was
 * never run). Proves the LFS-pointer integrity check.
 */
function buildLfsPointer() {
  const text =
    "version https://git-lfs.github.com/spec/v1\n" +
    "oid sha256:0000000000000000000000000000000000000000000000000000000000000000\n" +
    "size 4096\n";
  fs.writeFileSync(path.join(pluginDir, "LfsPointer.c3addon"), Buffer.from(text, "utf-8"));
}

fs.mkdirSync(pluginDir, { recursive: true });
buildFullAddon("Complete", "Complete");
buildFullAddon("CleanControl", "CleanControl");
buildFullAddon("Misnamed", "Misnamed");
buildFullAddon("Orphan", "Orphan");
buildMissingAces();
buildCorruptZip();
buildLfsPointer();
buildDup();

console.log(
  "Rebuilt Complete/CleanControl/Misnamed/Orphan/MissingAces/CorruptZip/LfsPointer/Dup(+nested/Dup) .c3addon fixtures",
);
