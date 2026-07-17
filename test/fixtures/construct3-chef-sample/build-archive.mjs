#!/usr/bin/env node
// Deterministically (re)generates the `MyCompany_MyEffect.c3addon` fixture
// under `addons/effect/` used by the scan-addon-usage effect test suite
// (#125). The archive is built from `archive-sources/MyCompany_MyEffect/` —
// a copy of the Construct effect SDK's `sample-tint` example (real C3-export
// content, including the UTF-8 BOM on `addon.json`, which exercises the
// reader's BOM-stripping path).
//
// The four entries mirror the addon.json `file-list`: addon.json, effect.fx,
// effect.wgsl, lang/en-US.json. Effects have no `aces.json` — presence
// (application) is the whole story for effect usage scans, so none is needed.
//
// Run with: `node test/fixtures/construct3-chef-sample/build-archive.mjs`.
//
// Zip entries use a fixed mtime (DOS zip timestamps only cover 1980-2099, so
// the Unix epoch isn't valid) so re-running on unchanged sources produces a
// byte-identical archive.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "archive-sources", "MyCompany_MyEffect");
const effectDir = path.join(here, "addons", "effect");

const FIXED_MTIME = new Date("2020-01-01T00:00:00Z");

function entry(relPath) {
  return [fs.readFileSync(path.join(srcDir, relPath)), { mtime: FIXED_MTIME }];
}

const zipData = zipSync(
  {
    "addon.json": entry("addon.json"),
    "effect.fx": entry("effect.fx"),
    "effect.wgsl": entry("effect.wgsl"),
    "lang/en-US.json": entry(path.join("lang", "en-US.json")),
  },
  { mtime: FIXED_MTIME },
);

fs.mkdirSync(effectDir, { recursive: true });
fs.writeFileSync(path.join(effectDir, "MyCompany_MyEffect.c3addon"), zipData);

console.log("Rebuilt MyCompany_MyEffect.c3addon fixture (from archive-sources/MyCompany_MyEffect)");
