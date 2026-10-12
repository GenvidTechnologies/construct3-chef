import { describe, it } from "mocha";
import { assert } from "chai";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { seedLayoutSids } from "../../src/c3/layoutSidSeed.js";
import { applyParsed } from "../../src/c3/recipeApplier.js";
import { collectLayoutSids } from "../../src/c3/layoutScaffold.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const MIN_SID = 1e14;
const MAX_SID = 1e15;

/**
 * Run `applyParsed` on a synthetic temp copy of the fixture with a BARE layout key while Math.random is rigged to
 * propose `target` (an SID already on disk in that layout) on every other draw. If applyParsed seeded the layout's
 * SIDs, the minter rejects `target` and the new instance gets a fresh SID; if the bare key was joined raw (the former
 * inline loop) nothing was seeded and the new instance takes `target`, so it appears twice in the written layout.
 *
 * The copy carries an EMPTY `extracted/sid-registry.txt` (required to exist) so the registry cannot seed the layout's
 * SIDs: only the layout-file seed under test can.
 */
function occurrencesOfTargetAfterBareKeyApply(): number {
  const tmp = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-sid-seed-"));
  const realRandom = Math.random;
  try {
    for (const entry of ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"]) {
      cpSync(path.join(FIXTURE_ROOT, entry), path.join(tmp, entry), { recursive: true });
    }
    mkdirSync(path.join(tmp, "extracted"));
    writeFileSync(path.join(tmp, "extracted/sid-registry.txt"), "");
    const layoutFile = path.join(tmp, "layouts/Gameplay/Main Layout.json");
    const target = [...collectLayoutSids(JSON.parse(readFileSync(layoutFile, "utf-8")) as Record<string, unknown>)][0];
    assert.isDefined(target, "fixture layout carries at least one SID");
    const before = readFileSync(layoutFile, "utf-8");
    let calls = 0;
    Math.random = () =>
      calls++ % 2 === 0
        ? (target - MIN_SID + 0.5) / (MAX_SID - MIN_SID)
        : (200 + calls / 10) / (MAX_SID - MIN_SID) + 0.1;
    applyParsed(
      tmp,
      {
        layouts: {
          "Gameplay/Main Layout": [
            { op: "copy-instance", from: "Gameplay/Main Layout", type: "Sprite3", targetLayer: "layer 0" },
          ],
        },
      },
      {
        regenerate: false,
        log: () => {},
      },
    );
    Math.random = realRandom;
    const written = readFileSync(layoutFile, "utf-8");
    assert.notEqual(written, before, "the copy-instance op landed");
    return written.split(`"sid": ${target}`).length - 1;
  } finally {
    Math.random = realRandom;
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("layoutSidSeed (#253)", () => {
  it("SS1: a bare layout key is seeded from its canonical layouts/ path", () => {
    const read: string[] = [];
    const used = new Set<number>();
    seedLayoutSids("/root", { "Gameplay/Main Layout": {} }, used, (p) => {
      read.push(p);
      return JSON.stringify({ sid: 123456789012345 });
    });
    assert.deepEqual(read, [path.join("/root", "layouts/Gameplay/Main Layout.json")]);
    assert.isTrue(used.has(123456789012345));

    // Production path: applyParsed itself must seed from the bare key, so an SID already in that layout is never
    // re-minted for a new node.
    assert.equal(occurrencesOfTargetAfterBareKeyApply(), 1, "an on-disk SID was minted again by a bare-key apply");
  });

  it("SS2: an escaping key is skipped without a read", () => {
    const read: string[] = [];
    seedLayoutSids("/root", { "../x": {} }, new Set<number>(), (p) => {
      read.push(p);
      return undefined;
    });
    assert.deepEqual(read, []);
  });
});
