#!/usr/bin/env node
// Deterministically (re)generates the `.c3addon` fixtures under `addons/*`
// used by `test/c3/addonValidator.test.ts`. Each `archive-sources/<Source>/`
// tree is zipped up and written under `addons/<kind>/`, where `<kind>` is
// "plugin" | "effect" | "behavior", read from that source's own `addon.json`
// `type` field (mirroring `readAddonKind` in `src/c3/addonDiscovery.ts`;
// defaults to "plugin" when absent/other). The zipped file set is whatever
// actually exists under the source directory (a plain recursive walk) rather
// than a hardcoded list — so a future effect source with `addon.json` +
// `effect.fx` and no `aces.json`, or a behavior source with
// `c3runtime/behavior.js`, work without touching this script.
//
// Archives produced today (all plugins, so all land in `addons/plugin/`):
// four real zip addons built from `archive-sources/` (a clean one, one whose
// manifest version drifts from project.c3proj, one whose addon.json id
// doesn't match its package filename, one clean-but-orphaned package with no
// matching `usedAddons` entry), one clean package duplicated at both
// `addons/plugin/Dup.c3addon` and `addons/plugin/nested/Dup.c3addon`
// (identical bytes, to exercise the recursive duplicate-id walk), one real
// zip archive deliberately missing its `aces.json` entry, one corrupt
// (non-zip) archive, and one un-materialized git-lfs pointer file. Run with:
// `node test/fixtures/addon-validate/build-archive.mjs`.
//
// Zip entries are written with a fixed mtime (DOS zip timestamps only cover
// 1980-2099, so the Unix epoch isn't valid) so re-running this script on
// unchanged sources produces byte-identical archives. Byte-identity also
// depends on zip *entry order*: `orderedSourceFiles` walks each source
// directory alphabetically but hoists `addon.json` then `aces.json` to the
// front when present, reproducing the historical fixed 3-entry order
// (`addon.json`, `aces.json`, `c3runtime/plugin.js`) for the existing plugin
// sources.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcesDir = path.join(here, "archive-sources");
const addonsRootDir = path.join(here, "addons");

const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

/**
 * Recursively lists every file under `dir`, as POSIX-relative paths from
 * `dir`, in alphabetical order at each level (directories sorted alongside
 * their sibling files by name).
 */
function walkFilesSorted(dir, base = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFilesSorted(full, base));
    } else {
      results.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return results;
}

/**
 * Returns `srcDir`'s files (POSIX-relative paths) in deterministic zip-entry
 * order: `addon.json` then `aces.json` (when present at the source root),
 * then everything else in alphabetical walk order. This reproduces the
 * historical hardcoded `addon.json`/`aces.json`/`c3runtime/plugin.js` order
 * for the existing plugin sources without hardcoding the file set itself.
 */
function orderedSourceFiles(srcDir) {
  const all = walkFilesSorted(srcDir);
  const priority = ["addon.json", "aces.json"];
  const front = priority.filter((name) => all.includes(name));
  const rest = all.filter((name) => !priority.includes(name));
  return [...front, ...rest];
}

/**
 * Best-effort read of `<srcDir>/addon.json`'s `type` field, mirroring
 * `readAddonKind` in `src/c3/addonDiscovery.ts`. Defaults to "plugin" when
 * the file is missing, malformed, or `type` is absent/other.
 */
function detectKind(srcDir) {
  try {
    const raw = fs.readFileSync(path.join(srcDir, "addon.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      if (parsed.type === "effect") return "effect";
      if (parsed.type === "behavior") return "behavior";
    }
  } catch {
    // fall through to the "plugin" default
  }
  return "plugin";
}

function outputDirForKind(kind) {
  return path.join(addonsRootDir, kind);
}

/**
 * Zips every file under `archive-sources/<sourceName>/` into a single
 * deterministic buffer, in `orderedSourceFiles` order.
 */
function buildZipData(sourceName) {
  const srcDir = path.join(sourcesDir, sourceName);
  const files = orderedSourceFiles(srcDir);
  const zipInput = {};
  for (const rel of files) {
    zipInput[rel] = [fs.readFileSync(path.join(srcDir, ...rel.split("/"))), { mtime: FIXED_MTIME }];
  }
  return zipSync(zipInput, { mtime: FIXED_MTIME });
}

/**
 * Builds a `<outName>.c3addon` zip from `archive-sources/<sourceName>/`,
 * routed into `addons/<kind>/` per that source's own `addon.json` `type`.
 */
function buildFullAddon(sourceName, outName) {
  const srcDir = path.join(sourcesDir, sourceName);
  const kind = detectKind(srcDir);
  const outDir = outputDirForKind(kind);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${outName}.c3addon`), buildZipData(sourceName));
}

/**
 * Dup.c3addon (+ nested/Dup.c3addon) — a clean addon written to two
 * locations with byte-identical content, to exercise the recursive
 * duplicate-id detection (which the flat `addons/<kind>/` walk alone can't).
 */
function buildDup() {
  const srcDir = path.join(sourcesDir, "Dup");
  const kind = detectKind(srcDir);
  const outDir = outputDirForKind(kind);
  const zipData = buildZipData("Dup");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "Dup.c3addon"), zipData);
  const nestedDir = path.join(outDir, "nested");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(nestedDir, "Dup.c3addon"), zipData);
}

/**
 * CorruptZip.c3addon — raw bytes that are not a valid zip at all. Proves the
 * malformed-zip integrity check. Not sourced from `archive-sources/` (no
 * `addon.json` to classify), so it's written directly into `addons/plugin/`.
 */
function buildCorruptZip() {
  const outDir = outputDirForKind("plugin");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "CorruptZip.c3addon"), Buffer.from("this is not a zip file\n", "utf-8"));
}

/**
 * LfsPointer.c3addon — an un-materialized git-lfs pointer file (what you get
 * when a repo has git-lfs-tracked `.c3addon` archives and `git lfs pull` was
 * never run). Proves the LFS-pointer integrity check. Not sourced from
 * `archive-sources/`, so it's written directly into `addons/plugin/`.
 */
function buildLfsPointer() {
  const outDir = outputDirForKind("plugin");
  fs.mkdirSync(outDir, { recursive: true });
  const text =
    "version https://git-lfs.github.com/spec/v1\n" +
    "oid sha256:0000000000000000000000000000000000000000000000000000000000000000\n" +
    "size 4096\n";
  fs.writeFileSync(path.join(outDir, "LfsPointer.c3addon"), Buffer.from(text, "utf-8"));
}

fs.mkdirSync(outputDirForKind("plugin"), { recursive: true });
buildFullAddon("Complete", "Complete");
buildFullAddon("CleanControl", "CleanControl");
buildFullAddon("Misnamed", "Misnamed");
buildFullAddon("Orphan", "Orphan");
buildFullAddon("MissingAces", "MissingAces");
buildCorruptZip();
buildLfsPointer();
buildDup();

console.log(
  "Rebuilt Complete/CleanControl/Misnamed/Orphan/MissingAces/CorruptZip/LfsPointer/Dup(+nested/Dup) .c3addon fixtures",
);
