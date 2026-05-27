# Design: C3 MCP Server Session 18

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

## Requirements Summary

From [requirements-next-session.md](requirements-next-session.md):

- **R1**: Fix `replace-action` silent failures (gotchas #41, #46)
- **R2**: New `wrap-in-group` recipe operation
- **R3**: Additional `PARAM_TYPE_RULES` entries (`on-touched-object`, `callFunction`)

## R1: `replace-action` Silent Failures -- Root Cause Analysis

### Investigation Results

Tracing through the current code reveals that **both bugs (#41 and #46) do not reproduce** against the current codebase. Verified by running targeted tests that exercise all four combinations:

1. Path-based call-to-call replacement: **passes** (params fully replaced)
2. Path-based call-to-script replacement: **passes** (action type changed)
3. SID-based call-to-call replacement: **passes** (params fully replaced)
4. SID-based call-to-script replacement: **passes** (action type changed)

The code at `recipeInterpreter.ts:845` (`actions[op.index] = action`) performs a straight array element assignment. The `expandAction` function at line 413 creates an entirely new action object from the builder shorthand. There is no SID-preservation logic, no Object.assign merging, and no type-checking gate that would prevent cross-type replacement.

The `replaceAction` function in `eventSheetMutator.ts:235` (path-based path) also does a straight `actions[index] = action` assignment at line 245.

### Likely Explanation

Per [feedback memo: verify gotchas against code before committing](../../.claude/projects/C--repos-burbank/memory/feedback_verify_gotchas.md), gotchas written during debugging sessions may be incomplete or wrong. These gotchas were likely observed when:

1. The recipe was malformed (e.g., using `"actions"` instead of `"action"` -- gotcha #30)
2. The dry-run preview showed "MODIFIED" based on file touch, not content diff
3. Some other recipe op in the same batch interfered

### Design Decision

Since the bugs don't reproduce, the design for R1 shifts from "fix bugs" to "harden against the documented failure modes":

1. **Add explicit test coverage** for cross-type action replacement and call-to-call param replacement (both path-based and SID-based). This proves the behavior works and prevents future regressions.
2. **Mark gotchas #41 and #46 as fixed/verified** in `recipe-reference.md` with strikethrough, similar to how gotchas #39, #44, #47 are marked.
3. **No code changes needed** in `recipeInterpreter.ts` or `eventSheetMutator.ts` for R1.

## R2: `wrap-in-group` Recipe Operation

### Schema

```typescript
export interface WrapInGroupOp {
  op: "wrap-in-group";
  in?: string;          // parent container SID ref (e.g., "sid:X") -- default: root
  events: string[];     // list of SID refs to wrap (e.g., ["sid:100", "sid:200"])
  title: string;        // group title
  id?: string;          // optional $symbol assignment (e.g., "$myGroup")
  activeOnStart?: boolean;  // default: true
  disabled?: boolean;       // default: false
}
```

### OP_FIELD_SCHEMAS entry

```typescript
"wrap-in-group": {
  required: ["events", "title"],
  optional: ["in", "id", "activeOnStart", "disabled"],
  misspellings: { event: "events", name: "title" },
},
```

### FileOp union addition

Add `WrapInGroupOp` to the `FileOp` union type.

### Interpreter Logic

The `wrap-in-group` case in `executeOp` performs these steps:

1. **Resolve parent container.** If `in` is specified, resolve via `resolveNodeFromRef` and get its `children` array. If not specified, use `sheet.events` (root level).

2. **Resolve all target events.** For each ref in `op.events`, call `resolveEventRef` to get the `SidIndexEntry`. Verify all resolved events share the same parent array (the one from step 1). Collect nodes and validate they exist.

3. **Determine insertion position.** Find the minimum index among the resolved events in the parent array. This is where the new group will be inserted.

4. **Build the group node.** Call `buildGroup({ title: op.title, children: [], activeOnStart: op.activeOnStart, disabled: op.disabled })`. This generates a unique SID via `generateUniqueSid()`.

5. **Move events into the group.** Remove each target event from the parent array (using `indexOf` for current position, since earlier removals shift indices). Append to the group's `children` array in their original order.

6. **Insert the group.** Splice the group into the parent array at the position determined in step 3.

7. **Register in sidIndex.** Add the new group's SID to `_sidIndex` with correct `parentArray` and `indexInParent`.

8. **Register symbol.** If `op.id` starts with `$`, register the group's SID in `_symbolTable`.

### Design Option A: SID-refs only (recommended)

Events are addressed exclusively by SID (`"events": ["sid:100", "sid:200"]`). This is consistent with the codebase's direction toward SID-based addressing and avoids index-shift concerns.

**Tradeoffs:** Requires the caller to know SIDs from `.dsl.idx.txt`. But this is the standard workflow for all SID-based recipe ops.

### Design Option B: Mixed SID/index addressing

Allow both SID refs and position-based indices in the `events` array. Adds complexity for marginal benefit since position-based addressing is being deprecated.

**Recommendation:** Option A. Keep it simple and consistent.

### Pseudocode

```typescript
case "wrap-in-group": {
  // 1. Resolve parent container
  let parentArray: EventSheetEvent[];
  if (op.in !== undefined) {
    const containerNode = resolveNodeFromRef(sheet, op.in, undefined, _sidIndex, _symbolTable);
    if (!hasChildren(containerNode)) {
      throw new Error(`wrap-in-group: target "${op.in}" is not a container`);
    }
    parentArray = (containerNode.children ?? []) as EventSheetEvent[];
  } else {
    parentArray = sheet.events;
  }

  // 2. Resolve target events, validate same parent
  const targets: { node: EventSheetEvent; entry: SidIndexEntry }[] = [];
  for (const ref of op.events) {
    const entry = resolveEventRef(ref, _sidIndex, _symbolTable);
    if (entry.parentArray !== parentArray) {
      throw new Error(
        `wrap-in-group: event "${ref}" is not in the specified parent container`
      );
    }
    targets.push({ node: entry.node, entry });
  }
  if (targets.length === 0) {
    throw new Error("wrap-in-group: events array must not be empty");
  }

  // 3. Determine insertion position (min current index)
  const currentIndices = targets.map(t => parentArray.indexOf(t.node));
  const insertPos = Math.min(...currentIndices);

  // 4. Build group
  const group = buildGroup({
    title: op.title,
    children: [],
    activeOnStart: op.activeOnStart,
    disabled: op.disabled,
  });

  // 5. Remove events from parent and add to group children (preserve order)
  // Sort by current position to maintain relative order
  const sorted = [...targets].sort(
    (a, b) => parentArray.indexOf(a.node) - parentArray.indexOf(b.node)
  );
  for (const t of sorted) {
    const idx = parentArray.indexOf(t.node);
    parentArray.splice(idx, 1);
    group.children.push(t.node);
  }

  // 6. Insert group at original position of first event
  parentArray.splice(insertPos, 0, group);

  // 7. Register group SID in sidIndex
  _sidIndex.set(group.sid, {
    node: group,
    parentArray,
    indexInParent: insertPos,
  });

  // 8. Register symbol if requested
  if (op.id !== undefined && op.id.startsWith("$")) {
    _symbolTable.set(op.id, group.sid);
  }

  break;
}
```

### Edge Cases

1. **Empty events array** -- throw error (nothing to wrap).
2. **Single event** -- valid; wraps one event in a group.
3. **Non-contiguous events** -- valid; all listed events are removed from parent and placed in the group. The group is inserted at the position of the first (by original position) event.
4. **Events from different parents** -- throw error (same-parent only, per requirements).
5. **Wrapping a group in a group** -- valid; groups are regular events that can be children of other groups.
6. **Duplicate SID refs** -- the second `indexOf` will return -1 after the first removal. Should throw or deduplicate. Design: deduplicate silently (use a Set on resolved SIDs).

### Builder Shorthand

No builder shorthand needed for `wrap-in-group`. It is a structural operation, not a node-building operation. Builder shorthands are for actions/conditions/events that construct C3 JSON nodes.

## R3: Additional `PARAM_TYPE_RULES` Entries

### `on-touched-object` type enum

```typescript
"on-touched-object": [
  {
    param: "type",
    check: (v) => v === "start" || v === "end" || v === "move",
    message: '"type" must be "start", "end", or "move" (not "0")',
  },
],
```

This is a condition (not an action), so it needs to be checked via `validateConditionParams`. The existing `validateConditionParams` function already shares the same `PARAM_TYPE_RULES` registry, so the entry works for both.

### `callFunction` array-not-object check

This is different from the other rules because it validates the `call` builder shorthand, not a named-params action. The `call` shorthand auto-stringifies params (gotcha #39 fix), but if someone passes `params` as an object with numeric keys (`{ "0": "arg1" }`), `expandAction` would pass it through to `buildCallAction` as an array-like object.

Actually, looking at the code more carefully:

```typescript
// expandAction line 420:
parameters: shorthand.params?.map((p) => (typeof p === "string" ? p : String(p))),
```

The `.map()` call only works on arrays. If `params` is an object (`{ "0": "arg1" }`), `.map` is undefined and this throws a runtime error. So the `callFunction` array check is about catching this **before** the cryptic TypeError.

**Design:** Add validation in `validateActionParams` specifically for `call` shorthand:

```typescript
// In validateActionParams, after the existing id-based check:

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

This goes in `validateActionParams` rather than `PARAM_TYPE_RULES` because `PARAM_TYPE_RULES` is keyed by action `id` (string), and `call` shorthand uses a different key (`call`).

## Consumer Workflow

### Using `wrap-in-group`

1. Agent reads `.dsl.idx.txt` to identify events to wrap
2. Agent notes the SIDs of target events (e.g., three blocks at `events[3]`, `events[4]`, `events[5]`)
3. Agent writes recipe:
   ```json
   {
     "files": {
       "Goals/GoalsEvents": [
         {
           "op": "wrap-in-group",
           "events": ["sid:100234567890123", "sid:100234567890456", "sid:100234567890789"],
           "title": "Level Progression",
           "id": "$levelGroup"
         },
         {
           "op": "insert-actions",
           "in": "$levelGroup",
           "after": -1,
           "actions": [{ "comment": "Wrapped for organization" }]
         }
       ]
     }
   }
   ```
4. Agent runs `validate-recipe` (dry-run) to check
5. Agent runs `apply-recipe`
6. The three events are removed from root and placed inside a new group at the position of the first event

### Using new PARAM_TYPE_RULES

No explicit workflow change -- validation happens automatically during `validate-recipe` and emits warnings if `on-touched-object` uses `"0"` or `callFunction` uses object-keyed params.

## Friction Audit

### Missing seams

- **None identified.** The `executeOp` switch statement is the natural extension point for new ops. The `OP_FIELD_SCHEMAS` registry and `FileOp` union type are the standard registration points.

### Preparatory refactors

- **None needed.** The existing patterns (SID resolution, symbol table, buildGroup) provide all the building blocks.

### P-steps vs F-steps split

**P-steps (pure additions, zero behavioral change):**
1. Add `WrapInGroupOp` interface to type definitions
2. Add `"wrap-in-group"` entry to `OP_FIELD_SCHEMAS`
3. Add `WrapInGroupOp` to `FileOp` union
4. Add `PARAM_TYPE_RULES` entries for `on-touched-object`
5. Add `callFunction` params-type check in `validateActionParams`
6. Add test cases for all existing `replace-action` cross-type scenarios (proving current behavior)

**F-steps (wiring / behavioral change):**
1. Add `case "wrap-in-group"` to `executeOp` switch
2. Update gotchas #41 and #46 in docs to strikethrough
3. Add tests for `wrap-in-group` operation

### Useful tooling

- No new tooling needed. Existing `makeSheet`/`makeBlock` test helpers and `buildSidIndex` are sufficient.

### Observability

- `wrap-in-group` should log the group SID and number of wrapped events (consistent with other ops that modify structure).

## Test Criteria

| Requirement | Verification | Type |
|-------------|-------------|------|
| R1.1: `replace-action` call-to-call replaces params | Test: replace FunctionCallAction with `{ call: "newFunc", params: ["new"] }`, assert new params | Unit test |
| R1.2: `replace-action` call-to-script changes type | Test: replace FunctionCallAction with `{ script: ["code();"] }`, assert result is ScriptAction | Unit test |
| R1.3: `replace-action` call-to-call via SID-based `in` | Same as R1.1 but using `in: "sid:X"` instead of `path` | Unit test |
| R1.4: `replace-action` call-to-script via SID-based `in` | Same as R1.2 but using `in: "sid:X"` | Unit test |
| R1.5: Existing replace-action tests still pass | `npm run test -- --grep "replace-action"` | Unit test |
| R2.1: Wraps listed events into new group | Create sheet with 3 blocks, wrap 2 by SID, assert group contains both | Unit test |
| R2.2: Group inserted at position of first wrapped event | Assert group index equals original first-event index | Unit test |
| R2.3: Group gets unique SID | Assert group has numeric SID, not 0, not duplicate | Unit test |
| R2.4: Children preserve original order | Wrap events at indices 2, 4, 6 (non-contiguous), assert children order matches original | Unit test |
| R2.5: `$symbol` assignment works | Use `id: "$grp"`, then `in: "$grp"` in subsequent op | Unit test |
| R2.6: Fails if events span different parents | Wrap one root event and one child event, assert throws | Unit test |
| R2.7: Fails if event SID not found | Pass invalid SID in events array, assert throws | Unit test |
| R2.8: Fails on empty events array | Pass `events: []`, assert throws | Unit test |
| R2.9: Single-event wrap works | Wrap one event, assert group has one child | Unit test |
| R2.10: `in` field targets non-root container | Create group with children, wrap children using `in: "sid:groupSid"` | Unit test |
| R2.11: Registered in OP_FIELD_SCHEMAS | Assert `OP_FIELD_SCHEMAS["wrap-in-group"]` exists with correct fields | Unit test |
| R2.12: Deduplicates repeated SID refs | Pass same SID twice in events array, assert group has one child (not crash) | Unit test |
| R3.1: `on-touched-object` warns on `"0"` | `validateConditionParams({ id: "on-touched-object", params: { type: "0" } })` returns warning | Unit test |
| R3.2: `on-touched-object` accepts `"start"` | Same with `type: "start"`, no warning | Unit test |
| R3.3: `callFunction` params-as-object warns | `validateActionParams({ call: "func", params: { "0": "x" } })` returns warning | Unit test |
| R3.4: `callFunction` params-as-array no warning | `validateActionParams({ call: "func", params: ["x"] })` no warning | Unit test |
| R3.5: `PARAM_TYPE_RULES` coverage check updated | Add `"on-touched-object"` to the expected IDs list in existing coverage test | Unit test |

## Cross-Domain Boundary

All changes are TypeScript-only. No C3 event sheet or layout changes.

**Files modified:**
- `bin/c3/recipeInterpreter.ts` -- `WrapInGroupOp` type, `FileOp` union, `executeOp` case, `OP_FIELD_SCHEMAS`, `PARAM_TYPE_RULES`, `validateActionParams`
- `test/c3/recipeInterpreter.test.ts` -- new test cases for R1, R2, R3
- `docs/recipe-reference.md` -- document `wrap-in-group` op, strikethrough gotchas #41/#46

**Files NOT modified:**
- `bin/c3/eventSheetMutator.ts` -- `buildGroup` already exists, `replaceAction` works correctly
- `bin/c3/sidUtils.ts` -- `generateUniqueSid` already exists
- `bin/mcp/server.ts` -- no MCP tool changes (recipe ops are exposed through existing `apply-recipe` and `validate-recipe`)

## Risks

1. **Gotchas #41/#46 might be real in a scenario not covered by investigation.** Mitigation: the new tests cover the documented failure modes. If a user reports the bug again, the tests will help narrow the scope.

2. **`wrap-in-group` sidIndex staleness.** After wrapping events, the `_sidIndex` entries for moved events still point to the old `parentArray` and `indexInParent`. This is the same pattern as `remove-event` (which also doesn't update moved nodes in the index). Subsequent ops targeting the wrapped events by SID may get stale index data. Mitigation: other ops using `in: "sid:X"` resolve via `resolveNodeFromRef` which re-resolves from the index. The `parentArray` reference for the wrapped events is stale, but `node` is still the same object reference. If a subsequent op needs the parent, it would need the group's SID, not the child's.

3. **Non-contiguous event wrapping leaves gaps.** Wrapping events at positions 1, 3, 5 removes them from the parent, shifting all intermediate events. The group is inserted at position 1. The remaining events (originally at 0, 2, 4) end up at 0, 1, 2 (after the group at position 1, they shift to 0, 2, 3). This is correct behavior but may surprise users who expect the "gap" events to remain in their original positions. The DSL output will make this clear.
