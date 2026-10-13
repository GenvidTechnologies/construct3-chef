import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import { rmSync } from "node:fs";
import * as path from "node:path";

import { applyParsed } from "../../src/c3/recipeApplier.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import type { ApplyOptions } from "../../src/c3/types.js";
import { copyFixture, makeReadOnly, snapshotTree } from "../helpers/applyFixtures.js";

// T15: `beforeSourceWrite` fires once per replay-loop write entry, before the write, and never otherwise.

function run(root: string, recipe: unknown, extra: ApplyOptions = {}): { calls: number; err?: Error } {
  let calls = 0;
  try {
    applyParsed(root, recipe as Recipe, {
      regenerate: false,
      log: () => {},
      ...extra,
      beforeSourceWrite: () => {
        calls++;
      },
    });
    return { calls };
  } catch (e) {
    return { calls, err: e as Error };
  }
}

describe("beforeSourceWrite hook (T15)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = copyFixture("c3chef-apply-hook-");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const x2 = {
    addInstVars: [{ type: "Text", instanceVariables: [{ name: "probeIv", type: "number" }] }],
    layouts: { "layouts/UI/Second Layout.json": [{ op: "add-layer", name: "PIV" }] },
  };

  it("T15(a1): dry-run makes 0 calls", () => {
    const r = run(tmp, x2, { dryRun: true });
    assert.isUndefined(r.err);
    assert.equal(r.calls, 0);
  });

  it("T15(a2): preview makes 0 calls", () => {
    const r = run(tmp, x2, { preview: true });
    assert.isUndefined(r.err);
    assert.equal(r.calls, 0);
  });

  it("T15(b): a single-layout NoSuchLayer rename throws and makes 0 calls", () => {
    const r = run(tmp, {
      layouts: { "layouts/UI/Second Layout.json": [{ op: "rename-layer", currentName: "NoSuchLayer", newName: "X" }] },
    });
    assert.isDefined(r.err);
    assert.include(r.err!.message, 'renameLayer: layer "NoSuchLayer" not found in layout');
    assert.equal(r.calls, 0);
  });

  it("T15(c): a failure after an earlier valid layout op is refused during compute with 0 calls", () => {
    const r = run(tmp, {
      layouts: {
        "layouts/Templates Layout.json": [{ op: "add-layer", name: "P" }],
        "layouts/UI/Second Layout.json": [{ op: "rename-layer", currentName: "NoSuchLayer", newName: "X" }],
      },
    });
    assert.isDefined(r.err);
    assert.include(r.err!.message, 'renameLayer: layer "NoSuchLayer" not found in layout');
    assert.equal(r.calls, 0);
  });

  it("T15(d): an editor-invalid CREATE throws and makes 0 calls", () => {
    const r = run(tmp, {
      files: {
        "eventSheets/NewFolder278/Bad.json": {
          create: true,
          events: [{ "custom-ace-block": { object: "Text", aceType: "action" } }],
        },
      },
    });
    assert.isDefined(r.err);
    assert.include(r.err!.message, "Editor-validation failed");
    assert.equal(r.calls, 0);
  });

  it("T15(e): a successful apply calls once per journaled write (4: Second Layout is written by both the addInstVars and layout steps)", () => {
    const before = snapshotTree(tmp);
    const r = run(tmp, x2);
    assert.isUndefined(r.err);
    const after = snapshotTree(tmp);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    assert.sameMembers(changed, [
      "layouts/UI/Second Layout.json",
      "objectTypes/Text.json",
      "scripts/ts-defs/instanceTypes.d.ts",
    ]);
    // 3 distinct files changed, but Second Layout has two write entries (addInstVars step, then layout step).
    assert.equal(r.calls, changed.length + 1);
  });

  it("T15(f): a write that throws mid-replay still had its hook called first", function () {
    if (process.getuid?.() === 0) this.skip();
    const second = path.join(tmp, "eventSheets", "UI", "Event sheet 2.json");
    const restore = makeReadOnly(second);
    try {
      const r = run(tmp, {
        files: {
          "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", comment: "HOOK1" }],
          "eventSheets/UI/Event sheet 2.json": [{ op: "insert-event", comment: "HOOK2" }],
        },
      });
      assert.isDefined(r.err);
      assert.match((r.err as NodeJS.ErrnoException).code ?? "", /^(EPERM|EACCES)$/);
      // Sheet 1 write, then the hook fires for sheet 2 before its write throws.
      assert.equal(r.calls, 2);
    } finally {
      restore();
    }
  });
});
