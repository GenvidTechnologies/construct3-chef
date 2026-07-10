#!/usr/bin/env node
// Deterministically (re)generates the `.c3addon` fixtures under
// `addons/plugin/` used by a future aces.json/properties <-> lang consistency
// check (issue #98). Unlike `test/fixtures/addon-validate/build-archive.mjs`
// (which hardcodes the entry list), this script recursively walks each
// `archive-sources/<Name>/` directory and zips EVERY file it finds -- so the
// root `plugin.js` and the whole `lang/` subtree are included alongside
// `addon.json`/`aces.json` without needing to be named individually. Two
// addons are built:
//
//   - `LangClean`  -- a single `lang/en-US.json` that fully covers every ACE,
//     param, property, and combo item declared in `aces.json`/`plugin.js`.
//     Proves the checker reports zero findings on a consistent addon.
//   - `LangDefects` -- `lang/en-US.json` deliberately omits an expression, an
//     action param, a property, and a combo item; `lang/fr-FR.json` is fully
//     consistent. Proves the checker finds exactly those four gaps, scoped to
//     the `en-US` locale only.
//
// Zip entries are written with a fixed mtime (DOS zip timestamps only cover
// 1980-2099, so the Unix epoch isn't valid) so re-running this script on
// unchanged sources produces byte-identical archives. Run with:
// `node test/fixtures/addon-validate-lang/build-archive.mjs`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcesDir = path.join(here, "archive-sources");
const pluginDir = path.join(here, "addons", "plugin");

const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

/**
 * Recursively collects every regular file under `dir`, returning a map of
 * POSIX-relative path (relative to `dir`) -> absolute file path.
 */
function walkFiles(dir, relPrefix = "") {
  const entries = {};
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      Object.assign(entries, walkFiles(abs, rel));
    } else if (dirent.isFile()) {
      entries[rel] = abs;
    }
  }
  return entries;
}

/**
 * Zips every file under `archive-sources/<sourceName>/` into a single
 * deterministic buffer, keyed by each file's POSIX-relative path.
 */
function buildZipData(sourceName) {
  const srcDir = path.join(sourcesDir, sourceName);
  const files = walkFiles(srcDir);
  const zipInput = {};
  for (const [relPath, absPath] of Object.entries(files)) {
    zipInput[relPath] = [fs.readFileSync(absPath), { mtime: FIXED_MTIME }];
  }
  return zipSync(zipInput, { mtime: FIXED_MTIME });
}

function buildFullAddon(sourceName, outName) {
  fs.writeFileSync(path.join(pluginDir, `${outName}.c3addon`), buildZipData(sourceName));
}

fs.mkdirSync(pluginDir, { recursive: true });
buildFullAddon("LangClean", "LangClean");
buildFullAddon("LangDefects", "LangDefects");

console.log("Rebuilt LangClean/LangDefects .c3addon fixtures");
