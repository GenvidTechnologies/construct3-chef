#!/usr/bin/env node
// Deterministically (re)generates the `GCoreV1.c3addon`/`GCoreV2.c3addon`
// fixtures under `addons/plugin/` used by `test/c3/addonAceDiff.test.ts`'s
// resolveAceSource/diffAddonAces integration coverage. Both packages share
// the same addon.json `id` ("GCore") — differing only in `version` — and are
// named after a version suffix (`GCoreV1`/`GCoreV2`), mirroring the real-world
// motivating case (e.g. `GCore-1.0.c3addon` vs `GCore-2.0.c3addon`) where the
// two archives' `.c3addon` filenames/DiscoveredAddon `name`s differ even
// though they're the same addon. V1 -> V2 exercises every diff bucket:
//   - "sync" action: present in both, UNCHANGED (identical params)
//   - "login" action: present in both, CHANGED (V2 drops the `region` param)
//   - "is-legacy-account" condition: present ONLY in V1 (removed in V2)
//   - "sdk-version" expression: present ONLY in V2 (added)
// Run with: `node test/fixtures/addon-ace-diff/build-archive.mjs`.
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
buildFullAddon("GCoreV1", "GCoreV1");
buildFullAddon("GCoreV2", "GCoreV2");

console.log("Rebuilt GCoreV1/GCoreV2 .c3addon fixtures");
