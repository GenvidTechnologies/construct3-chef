# Plan: C3 MCP Server Session 18

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch

`BUR-0000-c3-mcp-server-s18`

## Dependencies

No prerequisite branches. This session builds on merged work from sessions 1–17
(all merged to `main`). Branch from `main`.

## Summary

Add the `wrap-in-group` recipe operation (R2), harden `replace-action` with
regression tests (R1), and add two `PARAM_TYPE_RULES` entries for
`on-touched-object` and `callFunction` param validation (R3). All changes are
TypeScript-only: `bin/c3/recipeInterpreter.ts`,
`test/c3/recipeInterpreter.test.ts`, and `docs/recipe-reference.md`.

---

## Tasks

### P-steps (Prepare — pure additions, zero behavioral change)

#### P1. Add `WrapInGroupOp` interface and register in type system — ts-implementer

Add the interface adjacent to the other Op interfaces and wire it into `FileOp`.
This is a pure type addition: no runtime behavior changes.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/bin/c3/recipeInterpreter.ts`
  - Add `WrapInGroupOp` interface after `PatchFunctionBlockOp` (line ~248)
  - Add `WrapInGroupOp` to the `FileOp` union (line ~74–92)

**Commit:** `feat [WIP] - BUR-0000: Add WrapInGroupOp interface to FileOp union`

**Verification:** `npm run typecheck` — no new errors. The new union member must
not break any existing exhaustive-switch type guards (TypeScript will report
unhandled cases).

---

#### P2. Register `"wrap-in-group"` in `OP_FIELD_SCHEMAS` — ts-implementer

Add the schema entry. This enables the validator to check required/optional
fields and catch misspellings (`event` → `events`, `name` → `title`) without
executing any operation logic.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/bin/c3/recipeInterpreter.ts`
  - Add entry to `OP_FIELD_SCHEMAS` (line ~1659+)

**Schema to add:**
```typescript
"wrap-in-group": {
  required: ["events", "title"],
  optional: ["in", "id", "activeOnStart", "disabled"],
  misspellings: { event: "events", name: "title" },
},
```

**Commit:** `feat [WIP] - BUR-0000: Register wrap-in-group in OP_FIELD_SCHEMAS`

**Depends on:** P1 (the FileOp union must include WrapInGroupOp before the
schema entry is meaningful — TypeScript will not enforce this, but keep the
logical order).

**Verification:** `npm run typecheck && npm run test` — all 221 existing tests
pass.

---

#### P3. Add `on-touched-object` to `PARAM_TYPE_RULES` — ts-implementer

Add the enum check for the `type` parameter. This is a pure addition to an
existing registry; no callers change.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/bin/c3/recipeInterpreter.ts`
  - Add entry to `PARAM_TYPE_RULES` (line ~1788+)

**Entry to add (after existing `"set-animation"` block):**
```typescript
"on-touched-object": [
  {
    param: "type",
    check: (v) => v === "start" || v === "end" || v === "move",
    message: '"type" must be "start", "end", or "move" (not "0")',
  },
],
```

**Commit:** `feat [WIP] - BUR-0000: Add on-touched-object PARAM_TYPE_RULES entry`

**Depends on:** Nothing. Fully independent addition.

**Verification:** `npm run typecheck` — no errors.

---

#### P4. Add `callFunction` params-as-object check in `validateActionParams` — ts-implementer

Add a guard for the `call` shorthand form (`{ call: "...", params: [...] }`)
that emits a warning when `params` is an object instead of an array. This
catches the mistake before the cryptic `.map is not a function` TypeError.

The check goes in `validateActionParams` (line ~1847), not in `PARAM_TYPE_RULES`,
because `PARAM_TYPE_RULES` is keyed by action `id` and the `call` shorthand uses
a different key.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/bin/c3/recipeInterpreter.ts`
  - In `validateActionParams`, after the existing id-based check block

**Code to add:**
```typescript
// Call shorthand: { call: "funcName", params: [...] }
if (typeof action.call === "string" && action.params !== undefined) {
  if (!Array.isArray(action.params)) {
    warnings.push(
      `${prefix}: "call" shorthand "params" must be an array, not ${typeof action.params}. ` +
      `Use ["arg1", "arg2"], not {"0": "arg1", "1": "arg2"}`
    );
  }
}
```

**Commit:** `feat [WIP] - BUR-0000: Add callFunction params-as-object warning in validateActionParams`

**Depends on:** Nothing. Fully independent addition.

**Verification:** `npm run typecheck && npm run test` — all existing tests pass.

---

#### P5. Add regression tests for `replace-action` cross-type scenarios — ts-implementer

Write the four test cases that prove the documented failure modes (gotchas #41
and #46) do not reproduce. These tests are the R1 deliverable: they document
correct behavior and guard against future regressions. Tests must pass green on
first run (no code fixes needed).

Add inside the existing `describe("executeOp: replace-action", ...)` block
(line ~577).

**Test cases to add:**

1. **R1.1** — path-based call-to-call: replace a `FunctionCallAction` with a
   `{ call: "newFunc", params: ["newArg"] }` shorthand; assert new params are
   present and old params are gone.

2. **R1.2** — path-based call-to-script: replace a `FunctionCallAction` with
   `{ script: ["code();"] }`; assert result is a `ScriptAction` (has `script`
   array, no `callFunction`).

3. **R1.3** — SID-based call-to-call (`in: "sid:X"`): same assertion as R1.1
   but addressing the block by SID.

4. **R1.4** — SID-based call-to-script (`in: "sid:X"`): same assertion as R1.2
   but addressing by SID.

Note: `buildCallAction` is already imported in the test file. Check for
`FunctionCallAction` type import before adding — add if missing.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/test/c3/recipeInterpreter.test.ts`

**Commit:** `test - BUR-0000: Add replace-action cross-type regression tests (R1)`

**Depends on:** Nothing (tests existing behavior; independent of P1–P4).

**Verification:** `npm run test -- --grep "replace-action"` — all tests green,
221 + 4 = 225 total tests.

---

#### P6. Add R3 tests for `on-touched-object` and `callFunction` validation — ts-implementer

Write the five test cases for R3 validation rules. These test the behavior added
in P3 and P4. Tests are written before the F-steps (TDD: red first, then green
in F1 for any that need it, but P3/P4 are pure additions — tests will be green
immediately after P3/P4 are committed).

Add near the existing `PARAM_TYPE_RULES` validation tests (search for
`"compare-two-values"` or `validateActionParams` in the test file to find the
right location).

**Test cases to add:**

- R3.1: `validateConditionParams({ id: "on-touched-object", params: { type: "0" } }, "prefix")` returns a warning containing `"start", "end", or "move"`.
- R3.2: `validateConditionParams({ id: "on-touched-object", params: { type: "start" } }, "prefix")` returns no warnings.
- R3.3: `validateActionParams({ call: "func", params: { "0": "x" } }, "prefix")` returns a warning containing `"params" must be an array`.
- R3.4: `validateActionParams({ call: "func", params: ["x"] }, "prefix")` returns no warnings.
- R3.5: The existing `PARAM_TYPE_RULES` coverage test (if one exists) is updated
  to include `"on-touched-object"` in its expected IDs list. If no coverage test
  exists, skip this.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/test/c3/recipeInterpreter.test.ts`

**Commit:** `test [WIP] - BUR-0000: Add R3 validation tests for on-touched-object and callFunction`

**Depends on:** P3 and P4 (tests P3/P4 behavior; commit after P3 and P4 are in
place so tests run green).

**Verification:** `npm run test -- --grep "on-touched-object\|callFunction\|PARAM_TYPE_RULES"` — all R3 tests green.

---

### F-steps (Feature — wiring and behavioral change)

#### F1. Implement `case "wrap-in-group"` in `executeOp` — ts-implementer

Add the switch case following the pseudocode from the design. The case goes in
the `executeOp` function (line ~674+), adjacent to structural ops like
`"remove-event"` (line ~884).

Implementation steps within the case (per design pseudocode):

1. Resolve parent container (`op.in` → `resolveNodeFromRef`, or use `sheet.events`).
2. Resolve all target events via `resolveEventRef`; validate same-parent.
3. Deduplicate SID refs (use a `Set` on resolved SID values before adding to targets).
4. Reject empty events array.
5. Determine insertion position (`Math.min` of current indices).
6. Build group via `buildGroup({ title, children: [], activeOnStart, disabled })`.
7. Sort targets by current position; remove from parent and push to `group.children`.
8. Splice group into parent at insertion position.
9. Register group SID in `_sidIndex`.
10. Register `$symbol` if `op.id` starts with `"$"`.

Add a console log: `console.log(\`wrap-in-group: created group SID ${group.sid}, wrapped ${targets.length} event(s)\`)` — consistent with other structural ops.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/bin/c3/recipeInterpreter.ts`

**Commit:** `feat - BUR-0000: Implement wrap-in-group executeOp case`

**Depends on:** P1 (type), P2 (schema). Should be committed after P1–P2 and
after the wrap-in-group tests (F2) are written (TDD order: tests first, then
implementation).

**Verification:** `npm run typecheck && npm run test` — all tests pass including F2.

---

#### F2. Add tests for `wrap-in-group` operation — ts-implementer

Write the twelve test cases from the design (R2.1–R2.12). Add a new
`describe("executeOp: wrap-in-group", ...)` block near the other structural op
tests.

**Test cases:**
- R2.1: Wraps listed events into new group (2 of 3 blocks)
- R2.2: Group inserted at position of first wrapped event
- R2.3: Group has non-zero unique SID
- R2.4: Children preserve original order (non-contiguous indices 0, 2, 4)
- R2.5: `$symbol` assignment enables subsequent `in: "$grp"` targeting
- R2.6: Throws when events span different parents
- R2.7: Throws when event SID not found
- R2.8: Throws on empty events array
- R2.9: Single-event wrap produces group with one child
- R2.10: `in` field targets non-root container (wrapping grandchildren)
- R2.11: `OP_FIELD_SCHEMAS["wrap-in-group"]` exists with correct required/optional fields
- R2.12: Deduplicates repeated SID refs (same SID twice → one child in group)

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/test/c3/recipeInterpreter.test.ts`

**Commit:** `test [WIP] - BUR-0000: Add wrap-in-group tests (R2)`

**Ordering note:** Per TDD protocol, write this commit before F1 (tests fail
red), then F1 makes them pass. In practice, both F1 and F2 can be committed
together if the implementer finds it easier to develop them in tandem — the
`[WIP]` tag on the test commit makes the red state explicit.

**Depends on:** P1, P2 (types and schema must exist for the test assertions on
`OP_FIELD_SCHEMAS` and the `WrapInGroupOp` type).

**Verification (after F1):** `npm run test -- --grep "wrap-in-group"` — all 12 green.

---

#### F3. Update docs: strikethrough gotchas #41/#46 and document `wrap-in-group` — ts-implementer

Two changes in one doc commit:

1. **Strikethrough gotchas #41 and #46** in `docs/recipe-reference.md`.
   Use the same format as #39, #44, #47 — wrap title in `~~...~~` and add a
   "Fixed (Session 18)" suffix explaining what proved it. Example for #41:
   ```
   | 41 | ~~**`replace-action` doesn't change FunctionCallAction params**~~
   | ✅ Fixed (Session 18): Regression tests confirm params are fully replaced.
   Use `patch-action-param` for individual param updates. |
   ```

2. **Add `wrap-in-group` operation documentation.** Add a new section in the
   recipe operations reference (after the `rename-symbol` section, or wherever
   structural ops are grouped). Include: schema fields table, behavior
   description, edge cases (deduplication, non-contiguous, single-event), and a
   worked example matching the consumer workflow from the design.

**Files:**
- `/c/repos/burbank/worktrees/BUR-0000-c3-mcp-part3/docs/recipe-reference.md`

**Commit:** `docs - BUR-0000: Document wrap-in-group op, mark gotchas #41/#46 as fixed`

**Depends on:** F1 (implementation must exist before documenting behavior).

**Verification:** Review that gotcha table rows 41 and 46 now match the
`~~...~~` format of rows 39, 44, 47.

---

### Validation Checkpoint

#### V1. Full validation pass — validator

Run after all F-steps are complete.

**Commands:**
```bash
npm run lint
npm run typecheck
npm run test
```

**Expected state:**
- Lint: no errors or warnings
- Typecheck: no errors
- Tests: all pass (target ~233 tests: 221 existing + 4 R1 + 5 R3 + 12 R2 = 242,
  minus any existing R3 tests that may already exist)

---

## Commit Order Summary

```
P1  feat [WIP]  - Add WrapInGroupOp interface to FileOp union
P2  feat [WIP]  - Register wrap-in-group in OP_FIELD_SCHEMAS
P3  feat [WIP]  - Add on-touched-object PARAM_TYPE_RULES entry
P4  feat [WIP]  - Add callFunction params-as-object warning in validateActionParams
P5  test        - Add replace-action cross-type regression tests (R1)
P6  test [WIP]  - Add R3 validation tests for on-touched-object and callFunction
F2  test [WIP]  - Add wrap-in-group tests (R2)       ← red until F1
F1  feat        - Implement wrap-in-group executeOp case
F3  docs        - Document wrap-in-group op, mark gotchas #41/#46 as fixed
```

P1–P5 are fully independent of each other (except P2 depends on P1 for type
coherence). P6 depends on P3 and P4 being in place to run green. F2 is written
before F1 (TDD), using `[WIP]` to mark the expected red state. F3 is the final
commit; no tests depend on it.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `_sidIndex` entries for wrapped events become stale (`parentArray` points to old location) | Per design: same pattern as `remove-event`. Subsequent ops target events by SID and use `resolveNodeFromRef` which traverses from the index node reference, not the parentArray. Document the limitation in the `wrap-in-group` doc section. |
| `FileOp` union addition causes TypeScript exhaustiveness errors in existing switch statements | Check `getShiftInfo` (line ~1443) and `getOpPaths` (line ~1476) — both switch on `op.op`. Add `"wrap-in-group"` cases returning `null` / `[]` respectively, or add to the default/fallthrough branches. |
| `executeOp` switch has a TypeScript exhaustive check | If the switch uses a `never` assertion for unhandled cases, adding `WrapInGroupOp` to `FileOp` will cause a compile error until F1 is committed. P1 commit may temporarily break `typecheck`. Use `[WIP]` tag and note the gap. Alternatively, add the stub case in P1. |
| Gotchas #41/#46 might reproduce in scenarios not covered by the R1 tests | The four new test cases cover both path-based and SID-based addressing for both cross-type scenarios. If a user reports the bug again, the tests narrow the scope to untested scenarios. |
| Non-contiguous event removal shifts indices mid-loop | The pseudocode sorts by current position and uses `indexOf` on each iteration (not a cached index), so each removal correctly accounts for earlier shifts. Covered by R2.4 test. |

---

## Session Definition of Done

- [ ] `npm run lint` passes with no errors
- [ ] `npm run typecheck` passes with no errors
- [ ] `npm run test` passes with all tests green (zero failures, zero unexpected skips)
- [ ] `replace-action` cross-type scenarios are covered by passing tests (R1.1–R1.4)
- [ ] `wrap-in-group` operation is implemented and all 12 R2 tests pass
- [ ] `on-touched-object` and `callFunction` validation tests pass (R3.1–R3.4)
- [ ] Gotchas #41 and #46 are marked with strikethrough in `docs/recipe-reference.md`
- [ ] `wrap-in-group` is documented in `docs/recipe-reference.md` with worked example
- [ ] No existing tests regress
