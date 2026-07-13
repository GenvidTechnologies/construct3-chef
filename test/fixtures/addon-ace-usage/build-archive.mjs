#!/usr/bin/env node
// Deterministically (re)generates the `GCore.c3addon` fixture under
// `addons/plugin/` used by the scan-addon-usage test suite (#110).  The
// archive is built from `archive-sources/GCoreNew/` — the "current"/bundled
// side.  `archive-sources/GCoreOld/` deliberately stays an unzipped source
// tree: the diff-addon-aces `--from` side accepts a bare directory via
// `resolveAddonTarget`'s path-mode, so no archive is needed for it.
//
// GCoreOld -> GCoreNew exercises the exact diff buckets the usage-scan tests
// rely on:
//   - "is-logged-in" condition: present in both, UNCHANGED
//   - "login" condition: present in both, UNCHANGED (shares an `id` with the
//     "login" ACTION below — proves (kind, id) identity keeps them distinct)
//   - "login" action: present in both, CHANGED (New drops the `region` param)
//   - "logout" action: present ONLY in Old (REMOVED in New) — the dangling
//     call-site case a usage scan must surface via `diff.removed`
//   - "sync" action: present in both, UNCHANGED
//
// Run with: `node test/fixtures/addon-ace-usage/build-archive.mjs`.
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

fs.mkdirSync(pluginDir, { recursive: true });
buildFullAddon("GCoreNew", "GCore");

console.log("Rebuilt GCore.c3addon fixture (from archive-sources/GCoreNew)");
