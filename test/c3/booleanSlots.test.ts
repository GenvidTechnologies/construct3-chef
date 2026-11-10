import { describe, it } from "mocha";
import { assert } from "chai";
import * as c3source from "@genvidtech/c3source";
import { BUILTIN_PARAM_SLOTS, builtinParamSlot } from "../../src/c3/builtinBooleanParams.js";

// Tests for the built-in boolean-slot table (a local bridge until c3source ships it).

describe("builtin boolean param table", () => {
  it("I371-R12: the table has 117 rows with a known paramType", () => {
    assert.equal(BUILTIN_PARAM_SLOTS.length, 117);
    for (const s of BUILTIN_PARAM_SLOTS) {
      assert.include(["boolean", "combo-bool"], s.paramType, `${s.owner}/${s.aceId}/${s.paramId}`);
    }
  });

  it("I371-R12: the full tuple is unique and resolves to its own row", () => {
    const keys = new Set<string>();
    for (const s of BUILTIN_PARAM_SLOTS) {
      keys.add(JSON.stringify([s.ownerKind, s.owner, s.kind, s.aceId, s.paramId]));
      assert.strictEqual(builtinParamSlot(s.ownerKind, s.owner, s.kind, s.aceId, s.paramId), s);
    }
    assert.equal(keys.size, BUILTIN_PARAM_SLOTS.length);
    assert.isUndefined(builtinParamSlot("plugin", "no-such-owner", "action", "x", "y"));
  });

  it("I371-R12: the rows split into the expected classes", () => {
    const counts: Record<string, number> = {};
    for (const s of BUILTIN_PARAM_SLOTS) {
      const k = `${s.ownerKind}/${s.paramType}/${s.kind}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    assert.deepEqual(counts, {
      "plugin/combo-bool/action": 10,
      "plugin/boolean/action": 67,
      "plugin/boolean/condition": 2,
      "behavior/boolean/action": 24,
      "common/boolean/condition": 2,
      "common/combo-bool/action": 1,
      "common/boolean/action": 11,
    });
  });
});

// One predicate serves the real check and the synthetic positive control.
// Add the name of an export that matches but is not the boolean-slot table.
const ALLOWED_EXPORT_NAMES: readonly string[] = [];

function tableLikeExports(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((name) => /bool|param|combo/i.test(name) && !ALLOWED_EXPORT_NAMES.includes(name));
}

describe("c3source boolean-slot tripwire", () => {
  it("I371-T1: c3source does not yet export a boolean-slot table", () => {
    assert.deepEqual(
      tableLikeExports({ ACE_PARAM_TYPES: [] }),
      ["ACE_PARAM_TYPES"],
      "the predicate must flag a synthetic table-like export",
    );
    const mod = c3source as unknown as Record<string, unknown>;
    assert.isAtLeast(
      Object.keys(mod).filter((n) => /eventvar/i.test(n)).length,
      1,
      "positive control: /eventvar/i must match a real export, or the export enumeration is broken",
    );
    const found = tableLikeExports(mod);
    assert.deepEqual(
      found,
      [],
      `c3source now exports ${JSON.stringify(found)}, which may be the boolean-slot table (c3source#132). Retire the local bridge:\n` +
        "  1. Check that the matched export is the boolean-slot table. If it is not, add its name to ALLOWED_EXPORT_NAMES in this test and stop.\n" +
        "  2. Delete src/c3/builtinBooleanParams.ts, its import in src/c3/booleanSlots.ts, and the I371-T1: and I371-R12: tests.\n" +
        "  3. Switch the lookup to the upstream export.\n" +
        "  4. Revert-confirm that I371-R3:, I371-R4:, I371-R6: and I371-R7: stay green.",
    );
  });
});
