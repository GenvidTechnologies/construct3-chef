#!/usr/bin/env node
// Deterministically (re)generates the `.c3addon` zip fixtures under
// `addons/plugin/` from the plain source files in `archive-sources/`, so the
// committed binaries are reviewable/reproducible instead of hand-crafted
// black boxes. Run with: `node test/fixtures/addon-sample/build-archive.mjs`.
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
 * FixtureClockArchived.c3addon — a real, valid addon archive with NO
 * extracted directory beside it. Proves the zip-read fallback path in
 * `readAddonEntry`/`readAddonMetadata`/`readAddonAces`, and that the
 * extracted-only `buildAddonAceRegistry` aggregate correctly skips it.
 */
function buildFixtureClockArchived() {
  const srcDir = path.join(sourcesDir, "FixtureClockArchived");
  const zipData = zipSync(
    {
      "addon.json": [readEntry(srcDir, "addon.json"), { mtime: FIXED_MTIME }],
      "aces.json": [readEntry(srcDir, "aces.json"), { mtime: FIXED_MTIME }],
    },
    { mtime: FIXED_MTIME },
  );
  fs.writeFileSync(path.join(pluginDir, "FixtureClockArchived.c3addon"), zipData);
}

/**
 * FixtureClockMalicious.c3addon — a valid `addon.json` PLUS a zip entry
 * literally named `../../evil.txt`. Entry names are looked up by exact
 * string match only (never passed through `resolveWithin` or written to
 * disk), so the traversal name is inert: `readAddonEntry(addon,"addon.json")`
 * still returns the good entry, and nothing is ever written outside the
 * fixture tree.
 */
function buildFixtureClockMalicious() {
  const srcDir = path.join(sourcesDir, "FixtureClockMalicious");
  const zipData = zipSync(
    {
      "addon.json": [readEntry(srcDir, "addon.json"), { mtime: FIXED_MTIME }],
      "../../evil.txt": [Buffer.from("this should never be written to disk\n", "utf-8"), { mtime: FIXED_MTIME }],
    },
    { mtime: FIXED_MTIME },
  );
  fs.writeFileSync(path.join(pluginDir, "FixtureClockMalicious.c3addon"), zipData);
}

fs.mkdirSync(pluginDir, { recursive: true });
buildFixtureClockArchived();
buildFixtureClockMalicious();

console.log("Rebuilt FixtureClockArchived.c3addon and FixtureClockMalicious.c3addon");
