# Analysis: C3 MCP Server -- Next Session Scope

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

## Current State

**Stats:** 23 MCP tools, 1032 tests (1 pending), 1274 lines in `bin/mcp/server.ts`.

**Completed sessions:** 1-4, 6-8, 11-13, 16-17. Last session (17) implemented Filesystem Independence -- unified `search` tool, read tool pagination, and `resolve-anchor` for bidirectional DSL anchor lookup.

**Recent non-MCP work:** The story-battle-menu initiative applied 12+ recipe-driven commits converting NotEnoughGemsLayer to `toggleInteractiveLayers`. This was a heavy recipe consumer session -- any friction encountered there is real signal.

**No TODOs or FIXMEs** remain in `bin/mcp/server.ts`.

## Remaining Items Assessment

### 1. `replace-action` Silent Failure Bugs (Gotchas #41, #46)

**What:** Two documented bugs where `replace-action` silently fails:
- **#41**: `replace-action` with `call` shorthand on a FunctionCallAction preserves the original params instead of replacing them. File reports "MODIFIED" but params are unchanged.
- **#46**: `replace-action` silently fails when replacing a FunctionCallAction with a different action type entirely (e.g., replacing a `call` with a `script`). Reports "MODIFIED" but nothing changes.

**Impact:** Silent failures are the worst failure mode -- agents believe the change succeeded. Both have workarounds (`patch-action-param` for #41, `remove-action` + `insert-actions` for #46), but agents must know about the workarounds to use them.

**Session readiness:** High. The bugs are in `recipeInterpreter.ts` lines 834-852. The SID-based path (line 845: `actions[op.index] = action`) should already work correctly for full replacement, so the bug likely lives in the `replaceAction` path-based function or in how SID preservation interacts with action type changes. Diagnosable with targeted tests.

**Size:** Small-medium. Fix + tests for two related bugs in one function.

### 2. Structural Refactoring: `wrap-in-group`

**What:** A recipe operation that wraps a range of events in a new group node. Handles SID generation for the new group, preserves child SIDs, maintains JSON formatting.

**Impact:** Medium. This is a recurring manual operation during event sheet organization. Without it, agents must either hand-edit JSON or write complex multi-op recipes (remove events, create group, re-insert events).

**Session readiness:** Medium. No existing code. Requires:
- Defining the recipe op schema (target events by SID range or indices, group title)
- SID generation for the new group node
- Array manipulation to splice events out, wrap in group, splice group in
- Validator updates (`OP_FIELD_SCHEMAS`)
- Integration with the interpreter loop

**Size:** Medium. One new recipe op with builder, interpreter case, validator schema, and tests.

### 3. Remaining `PARAM_TYPE_RULES` Gaps

**What:** Two uncovered parameter type validations:
- `on-touched-object` `type` must be `"start"` / `"end"` / `"move"` (not `"0"`)
- `callFunction` object-keyed params (gotcha #32) -- should be array, not object

**Impact:** Low. Both are uncommon action/condition IDs. Gotcha #32 is already auto-fixed by the `call` builder shorthand (auto-stringifies params). The `on-touched-object` enum is rarely used.

**Session readiness:** Very high. Adding entries to `PARAM_TYPE_RULES` is a 3-line change per rule (registry pattern, no structural changes). But too small for a standalone session.

### 4. Mid-Session SID Discovery

**What:** A `read-event-sids` tool that reads source JSON directly (not `extracted/`) to return SIDs for events without needing `regenerate`.

**Impact:** Low-medium. The `$symbol` feature handles within-recipe chaining. `regenerate` handles cross-recipe SID discovery. The remaining gap is a convenience optimization (avoid regenerate between recipes).

**Session readiness:** Medium. Requires parsing raw event sheet JSON and building a SID map -- similar logic to what `generateDslIndex` does but reading from source instead of extracted.

**Size:** Small-medium.

### 5. Staleness Detection

**What:** Read tools compare source mtimes against extracted mtimes before serving.

**Impact:** Low. The `[Warning: extracted files may be stale]` banner already exists. The remaining gap is that `git checkout` may not trigger `fs.watch`.

**Session readiness:** High but narrow impact.

**Size:** Small.

### 6. C3 Editor Browser Automation (Playwright)

**Impact:** Not blocking current workflows. Would enable save/preview/error-check from MCP but all current work is file-based.

**Session readiness:** Low. Requires exploration phase first (DOM selectors).

**Size:** Large (multi-session).

### 7. `move-variable` Scope Tool

**Impact:** Low-medium. Cross-cutting refactoring (variable declaration + all script references + type declarations). Rarely needed.

**Session readiness:** Low. Touches multiple file types and domains.

**Size:** Large.

### 8. SID Uniqueness Validation Gap (validate ≠ apply)

**What:** `validate-recipe` (dry-run) does not call `buildSidIndex` on the target event sheet, so it returns "Validation passed" for files that `apply-recipe` will reject with `Duplicate SID NNN found in event sheet "X"`. Confirmed during the equipment-response-integration work on `BUR-0000-network-calls-cleanup-4` (2026-04-21): a dormant duplicate SID from unrelated PR #4077 (months earlier) made it past validate but blocked apply. Required a separate prep commit (`89f3c1b8a`) to unblock — the agent had no way to detect the problem without attempting a real apply.

**Impact:** High. This is the classic "validation is a lie" failure mode — the dry-run's whole purpose is to detect what the real path would reject. Every precondition that can crash `apply-recipe` must also crash `validate-recipe`, or "validated" means nothing.

**Session readiness:** Very high. Same code path (`buildSidIndex`) already exists and runs during apply; the fix is moving it earlier so `validateRecipe()` invokes it for every target event sheet. Could be TDD'd with a regression fixture (file with two identical SIDs).

**Size:** Small. Likely 20-40 lines in `bin/c3/recipeInterpreter.ts` + one regression test.

### 9. Duplicate SID Detection in `generate-c3`

**What:** `generate-c3` walks every event sheet and emits `extracted/sid-registry.txt`, so it already has full knowledge of every SID in the project. Today it silently lists duplicate SIDs in the registry without any warning. PR #4077 introduced the duplicate caught in item 8 months before anyone hit the apply-recipe failure — a `[warn]` or `[error]` at generation time would have surfaced it in that PR's branch and spared the subsequent unrelated-branch fix.

**Impact:** Medium-high. Catches the defect at its origin (the PR that introduces it) rather than at the first downstream recipe attempt. Low implementation cost.

**Session readiness:** High. During registry emission, group entries by SID value and emit a warning line for any group with more than one occurrence. Optional `--strict` flag to fail the run for CI consumers.

**Size:** Small. ~15-30 lines in the registry generator plus a test.

### 10. Preflight Tool: `check-sid-uniqueness`

**What:** A cheap read-only MCP tool that scans event sheets (or a subset) and returns duplicate SIDs with file paths and JSON paths. Complements items 8 and 9 by exposing the check as an ad-hoc preflight agents can run at the top of a recipe session, and as an investigation tool when items 8/9 fire.

**Shape:**

```json
{
  "duplicates": [
    {
      "sid": 104831747914076,
      "occurrences": [
        { "file": "eventSheets/Main Menu/EquipmentMenuEvents.json", "jsonPath": "events[3].children[22]" },
        { "file": "eventSheets/Main Menu/EquipmentMenuEvents.json", "jsonPath": "events[3].children[23]" }
      ]
    }
  ]
}
```

**Impact:** Medium. Supporting tool for items 8 and 9 — not strictly needed once those land, but useful during triage.

**Session readiness:** High once items 8/9 are in; reuses the same duplicate-detection pass. Can also be implemented standalone.

**Size:** Small. Tool handler + shared detection helper.

### 11. Enrich the Duplicate SID Error Payload

**What:** When `buildSidIndex` throws on a duplicate, the current error reports the SID and file only. Enriching the error with both occurrence paths (file + JSON path) would spare agents a manual grep step during diagnosis. The generator already has both paths at throw time.

**Impact:** Low — polish. Valuable in combination with items 8-10.

**Session readiness:** Very high. Trivial extension of the existing error message.

**Size:** Tiny. Handful of lines in `buildSidIndex`.

**Bundling note for items 8-11:** These four are tightly related and share diagnostic scaffolding. A single session targeting the theme "SID uniqueness: catch at source, validate before apply, surface clearly" could land all of them with shared tests. Estimated size: medium (comparable to the items 1+2 bundle above).

### 12. `add-function` Builder Shorthand Drops `category`

**What:** The `add-function` recipe builder shorthand accepts a `category` field but emits the resulting `function-block` with `"functionCategory": ""`. The category silently disappears between the recipe input and the applied JSON. `generate-c3` then produces DSL output with a bare `category:` line (empty value) rather than `category: Decisions` (or whatever was specified).

**Impact:** Medium. Silent drop — no validation error, no warning. Forces manual JSON patching post-`apply-recipe` to restore the intended `functionCategory`. The DSL diff becomes noisy (extracted-text shows an "empty category" that doesn't match the source intent). This is the same category of failure as items 1 and 8 — the contract "what I wrote is what got applied" is quietly broken. Confirmed during Iteration 3 of the cloudscript-query-cache initiative (2026-04-23): both `CallGetCurrentDecisions` and `CallGetCurrentDecisionsForced` in the new `DecisionsCommonEvents.json` emitted with empty categories and required a manual JSON patch before the regenerate step.

**Session readiness:** High. The shorthand-to-JSON mapping for `function-block` in the chef's builder layer needs to honor the `category` input — likely a one-line omission in the builder function. The path-based operation presumably works; the bug is in the builder.

**Size:** Small. Fix the builder mapping, add a regression test that asserts `functionCategory` survives round-trip for a recipe specifying a category.

**Lesson source:** `docs/lessons-learned.md` entry BUR-0000 (2026-04-23); captured as c3-implementer gotcha #16.

## Recommendation

### Primary: `replace-action` Bug Fixes + `wrap-in-group` Recipe Op

**Justification:** These two items complement each other well for a single session:

1. **`replace-action` fixes** are the highest-impact remaining bugs. Silent failures are worse than errors -- they waste agent time on phantom changes and require knowledge of obscure workarounds. The fix is well-scoped (two related bugs in one function area) and enables TDD (write failing tests first, then fix).

2. **`wrap-in-group`** is the highest-value remaining structural tool. It directly enables event sheet organization, which is a recurring need as sheets grow. It is self-contained (one new recipe op) and follows the established pattern (builder + interpreter case + validator schema + tests).

Together these fill the "recipe reliability" gap (fixing silent failures) and the "recipe capability" gap (adding a missing structural operation). Both are in `recipeInterpreter.ts` and share test infrastructure.

### Bundled: Remaining `PARAM_TYPE_RULES` entries

Too small for a standalone session but easy to include. Add `on-touched-object` type enum and `callFunction` array-not-object check. 15-minute addition during the session.

## Requirements

### R1: `replace-action` Must Not Silently Fail (Gotchas #41, #46)

1. When `replace-action` replaces a FunctionCallAction with a `call` shorthand, the new action's parameters must overwrite the original parameters completely -- not preserve the old ones.
2. When `replace-action` replaces an action with a different action type (e.g., FunctionCallAction to ScriptAction), the replacement must succeed -- the new action must fully replace the old one in the actions array.
3. If replacement cannot succeed for a structural reason, the operation must throw an error -- never report "MODIFIED" without actually modifying.
4. Existing tests for `replace-action` must continue to pass (backward compatibility for working cases).

### R2: `wrap-in-group` Recipe Operation

1. The operation must accept: a target event sheet, a list of event references (SIDs or indices), and a group title.
2. The operation must create a new group node with a unique SID (using the project SID registry).
3. The referenced events must be moved from their current position into the new group's `children` array, preserving their order and all existing SIDs.
4. The new group must be inserted at the position of the first referenced event.
5. The operation must work with SID-based addressing (`in: "sid:X"` for parent container) and support `$symbol` assignment (`id: "$myGroup"`).
6. The operation must be registered in `OP_FIELD_SCHEMAS` with proper required/optional field validation.
7. The operation must fail clearly if any referenced event is not found, or if referenced events span different parent containers.

### R3: Additional `PARAM_TYPE_RULES` Entries

1. `on-touched-object` condition: `type` parameter must be one of `"start"`, `"end"`, `"move"` -- not a numeric string like `"0"`.
2. `callFunction` action: `parameters` field must be an array, not an object with numeric keys -- warn when object form is detected.

## Constraints

- All changes are in `bin/c3/recipeInterpreter.ts` and its test file -- no MCP server changes needed (recipe ops are exposed through existing `apply-recipe` and `validate-recipe` tools).
- `OP_FIELD_SCHEMAS` must be updated for the new `wrap-in-group` op.
- SID generation for the new group must use the existing `sidUtils.ts` collision-checked generator.
- Existing recipe tests must continue to pass -- no behavioral regressions.
- The `wrap-in-group` op must not require `regenerate` to work (it modifies source JSON directly, like all recipe ops).

## Touch Points

- `bin/c3/recipeInterpreter.ts` -- interpreter loop, `expandAction`, `replaceAction`, `PARAM_TYPE_RULES`, `OP_FIELD_SCHEMAS`
- `bin/c3/eventSheetMutator.ts` -- `replaceAction` function (for the path-based replace bug)
- `bin/c3/sidUtils.ts` -- SID generation for new group nodes
- `test/c3/recipeInterpreter.test.ts` -- new test cases for all three requirements
- `docs/recipe-reference.md` -- document `wrap-in-group` op, update gotchas #41/#46 as fixed

## Open Questions

1. **Gotcha #46 root cause:** The code at line 845 (`actions[op.index] = action`) appears to do a straight array assignment, which should work regardless of action type. The bug may be in the path-based `replaceAction` function, or in how the action is serialized back to JSON, or in an edge case where SID preservation interferes. Need to write a failing test to confirm before fixing.

2. **`wrap-in-group` scope:** Should the op support wrapping events that are already children of a group (moving them into a subgroup)? Or only root-level events? The initiative description says "range of events (by SID or index)" without specifying depth. The simpler initial scope is same-parent events only.

3. **`wrap-in-group` naming:** Recipe op name `wrap-in-group` vs `create-group-from`? The initiative uses `wrap-in-group`. Recommend keeping it since it describes the action from the user's perspective.

## What to Defer

- **Mid-Session SID Discovery** -- `$symbol` and `regenerate` workarounds are adequate. Address when the friction increases.
- **Staleness Detection** -- The stale warning banner is sufficient. `git checkout` edge case is rare.
- **C3 Editor Browser Automation** -- Not blocking. Requires exploration first.
- **`move-variable`** -- Cross-cutting, touches multiple domains. Needs its own analysis session.
- **`extracted/` directory transition** -- Architectural change, not blocking.
- **Configuration layer** -- For standalone package use, not blocking.
