#!/usr/bin/env node
// Deterministically (re)generates the bundled `.c3addon` fixtures under
// `addons/{plugin,behavior}/` used by the scan-addon-usage test suite
// (#110/#123). Each archive is built from an `archive-sources/<name>/` tree by
// zipping that source's ACTUAL file set (recursively), so a plugin source with
// a `c3runtime/plugin.js` and a behavior source with just `addon.json`/
// `aces.json` both build correctly.
//
// `archive-sources/GCoreOld/` deliberately stays an unzipped source tree: the
// diff-addon-aces `--from` side accepts a bare directory via
// `resolveAddonTarget`'s path-mode, so no archive is needed for it.
//
// GCoreOld -> GCoreNew exercises the diff buckets the usage-scan tests rely on:
//   - "is-logged-in" / "login" conditions: UNCHANGED
//   - "login" action: CHANGED (New drops the `region` param)
//   - "logout" action: REMOVED in New (the dangling call-site case)
//   - "sync" action: UNCHANGED
//   - "SessionLength" expression: CHANGED (New drops the `format` param)  [#123]
//   - "Rank" expression: REMOVED in New (dangling expression reference)   [#123]
// GTrack is a behavior addon declaring a single "TrackedTime" expression,
// referenced from a family member in the event sheet (#123 behavior-expr case).
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
const addonsDir = path.join(here, "addons");

const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

/** Recursively collect every file under `dir` as POSIX-relative entry names. */
function collectEntries(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectEntries(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Zip `archive-sources/<sourceName>/`'s entire file tree into one deterministic buffer. */
function buildZipData(sourceName) {
  const srcDir = path.join(sourcesDir, sourceName);
  const files = {};
  for (const rel of collectEntries(srcDir)) {
    files[rel] = [fs.readFileSync(path.join(srcDir, ...rel.split("/"))), { mtime: FIXED_MTIME }];
  }
  return zipSync(files, { mtime: FIXED_MTIME });
}

/** Build `addons/<kind>/<outName>.c3addon` from `archive-sources/<sourceName>/`. */
function buildFullAddon(sourceName, outName, kind) {
  const outDir = path.join(addonsDir, kind);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${outName}.c3addon`), buildZipData(sourceName));
}

buildFullAddon("GCoreNew", "GCore", "plugin");
buildFullAddon("GTrack", "GTrack", "behavior");

console.log("Rebuilt GCore.c3addon (plugin) + GTrack.c3addon (behavior) fixtures");
