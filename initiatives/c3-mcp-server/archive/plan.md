# Plan: Session 16 — Param Type Safety + Include Tree

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch
`BUR-0000-c3-mcp-server-s16` (from current branch `BUR-0000-c3-mcp-server-s12-15`)

## Summary

Two themes: (1) catch C3 parameter type errors at recipe validation time instead of C3 project load, and (2) add a transitive include tree tool for layout wiring discovery. Also fixes `call` shorthand to auto-stringify numeric params and updates the initiative to reflect that `include` shorthand on `insert-event` is already implemented.

## Exploration Findings

### `include` shorthand on `insert-event` — Already Done
`extractInlineEvent()` at recipeInterpreter.ts:533 already handles `{ "include": "SheetName" }`. This was listed as the #1 "Next Up" item but is already implemented. Task 1 updates the initiative doc.

### C3 Param Type Validation — Design

**Problem:** Gotchas #31–#37, #39 document 7 categories of silent param type errors that only surface as cryptic C3 errors on project load. The recipe validator currently checks field structure but not parameter value types.

**Approach:** Define a `PARAM_TYPE_RULES` registry mapping well-known action/condition IDs to parameter type constraints. Hook into `validateRecipe()` to warn when builder shorthand params violate these rules. Start with the 5 highest-impact rules:

| Rule | Action/Condition ID | Param | Constraint | Gotcha |
|------|---------------------|-------|------------|--------|
| 1 | `compare-two-values` | `comparison` | Must be integer (0–7) | #31 |
| 2 | `callFunction` (all) | `parameters[*]` | Must be string | #39 |
| 3 | `set-layer-visible`, `layer-is-visible` | `layer` | Must be quoted expression `"\"...\""` | #33 |
| 4 | `set-layer-interactive`, `is-on-layer` | `layer` | Must be quoted expression | #33 |
| 5 | `set-layer-visible` | `visibility` | Must be `"visible"` or `"invisible"` | #34 |

**Auto-fix vs warn:** For `callFunction` params (#39), auto-stringify numeric values in the `call` builder shorthand — this eliminates the gotcha at the source. For the rest, warn at validation time (auto-fixing quoted expressions would be fragile).

**Scope boundary:** Only validate params on builder shorthand objects (what the recipe author writes), not on raw C3 JSON passthrough. The validator already walks shorthand objects for field validation (Session 15); param type checks extend that same walk.

### `list-include-tree` — Design

**Problem:** Determining which C3 functions are callable from a layout requires tracing the full transitive include tree. Currently requires multiple `search-dsl` calls.

**Approach:** New MCP read tool that:
1. Parses an eventSheet's JSON for include directives
2. Recursively resolves transitive includes (with cycle detection)
3. Optionally lists functions defined at each level
4. Returns a tree or flat list

Library function in `bin/c3/includeTree.ts`, exposed as MCP tool `list-include-tree`.

## Friction Point Audit

1. **Missing seam**: `validateRecipe()` already walks builder shorthands (Session 15 added `SHORTHAND_FIELD_SCHEMAS`). Param type checks plug into the same walk — the seam exists.
2. **Preparatory refactor**: The `call` shorthand builder (`expandAction` in recipeInterpreter.ts) constructs `callFunction` params directly. Auto-stringify is a one-line map — no refactoring needed.
3. **Tool relationships**: `list-include-tree` complements `search-dsl` (which finds patterns in DSL content) and `read-domain-index` (which shows domain groupings). Include tree answers "what functions can this layout call?" — neither existing tool answers that directly.
4. **Can tasks split into P/F-steps?** Task 2 is pure P-step (auto-stringify, no validation change). Task 3 adds the registry (P) then hooks validation (F). Task 4 is library (P) then MCP tool (F).
5. **Simpler alternatives**: Considered adding param validation inline per-op (like Session 12's `add-include` + path warning). Registry approach is better — centralized, testable, extensible.

## Tasks

### Task 1: Update initiative — `include` shorthand already implemented (and commit)

Strike `include` shorthand from "Next Up" in initiative.md. Note that `extractInlineEvent()` already handles it.

**Key files**: `initiatives/c3-mcp-server/initiative.md`

### Task 2: Auto-stringify `call` shorthand numeric params (and commit)

In the `call` builder shorthand expansion, auto-convert non-string params to strings (e.g., `0` → `"0"`). This eliminates gotcha #39 at the source — recipes with `{ "call": "func", "params": [0] }` now produce correct JSON. Add tests. Update gotcha #39 to say "fixed by auto-stringify".

**Key files**: `bin/c3/recipeInterpreter.ts`, `test/C3/recipeInterpreter.test.ts`, `docs/recipe-reference.md`

### Task 3: Add `PARAM_TYPE_RULES` and validate in `validateRecipe` (and commit)

**P-step**: Define `PARAM_TYPE_RULES` — a registry mapping action/condition IDs to param constraints (type check function + error message). Cover the 5 rules from the design table.

**F-step**: In `validateRecipe()`, when validating builder shorthand actions/conditions, check params against the rules. Emit warnings (not errors) for type mismatches. Add tests for each rule.

**Key files**: `bin/c3/recipeInterpreter.ts`, `test/C3/recipeInterpreter.test.ts`

### Task 4: Add `bin/c3/includeTree.ts` library + tests (and commit)

Create library with:
- `resolveIncludeTree(rootPath, projectDir)` — returns transitive include tree with cycle detection
- `listFunctionsInTree(tree, projectDir)` — optionally lists function names defined at each level
- Tree node type: `{ path, includes: TreeNode[], functions?: string[] }`

Tests use fixture eventSheet JSON files with include chains.

**Key files**: `bin/c3/includeTree.ts` (new), `test/C3/includeTree.test.ts` (new)

### Task 5: Add `list-include-tree` MCP tool (and commit)

Register as 22nd tool in `bin/mcp/server.ts`. Parameters: `path` (eventSheet path, bare or full), optional `functions` boolean (include function names). Read-only, uses read lock.

Update CLAUDE.md key files section for `includeTree.ts`. Update server.ts key file description (22 tools).

**Key files**: `bin/mcp/server.ts`, `CLAUDE.md`

### Task 6: Code review, final validation, initiative docs update (and commit)

Run `npm run lint && npm run test`. Code review all changes. Update initiative.md with session 16 status. Update MEMORY.md if needed. Add lessons-learned entry.

## Verification

- `npm run test` passes with new tests for auto-stringify, param type validation, and include tree
- `npm run lint` passes
- MCP server starts cleanly
- `list-include-tree` returns correct transitive includes for a real eventSheet

## Risks

| Risk | Mitigation |
|------|------------|
| Param validation false positives on C3 expressions | Only flag values that are definitively wrong types (numeric literal where string required), not expressions that might evaluate correctly |
| Include cycles in eventSheet JSON | Visited-set cycle detection; warn and stop traversal on cycle |
| Large include trees consuming context | Function listing is opt-in; tree is compact (paths only by default) |
| Auto-stringify breaking valid numeric C3 expressions | C3 `callFunction` params are always strings — numeric JSON values are never valid here |

## Execution Strategy

Single session, sequential tasks. Tasks 2–3 share `recipeInterpreter.ts` — must serialize. Task 4 is independent (new file, can run in parallel with 2–3 via worktree isolation). Task 5 depends on 4.
