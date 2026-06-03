# Plan: Global Variable Scope Markers + Cascade Remove-Layer + Standalone MCP Tool (Issue #58, partial)

> Source issue: [#58](https://github.com/genvid-holdings/construct3-chef/issues/58) — "DSL: distinguish global vs sheet-local variables; add remove-layer recipe op".
> This effort ships **1a + Part 2 (2a/2b/2c)**. **1b (reference-site annotation) is DEFERRED** — gated on a c3source classifier intent request (Task 8). #58 stays **open** for 1b.

## Branch
`feature/issue-58-var-scope-cascade-remove`

## Approved scope & decisions

- **Form (1a):** keyword-prefix, mark ONLY global. Scope word is a separate leading word before the existing `const`/`static`/`var` keyword.
  - sheet-root: `global var currentLevel: number = 0`, `global static hp: number = 100`, `global const MAX: number = 5`
  - nested (local): `var temp: number = 0` (UNCHANGED — no marker)
- **2b cascade semantics:** `cascade: true` recurses sublayers but REFUSES if any instance exists anywhere in the subtree; `removeInstances: true` (only meaningful with `cascade`) is required to force-remove a subtree containing instances. Two separate optional boolean flags on `RemoveLayerOp`.
- **1b:** deferred — file a c3source intent request for an eventvar-reference classifier; implement the marker locally once it lands. Do NOT implement the marker now.
- **Tasks 1→2:** intentional TDD red→green split (Task 1 `[WIP]` red commit, Task 2 green). Safe because the PR squash-merges.

## Dependencies
None. Main is clean, no prerequisite branches.

## Counts verified at plan time
- `formatVariableDescription` call sites in `src/c3/dslFormatter.ts`: 3 (lines 55, 209, 508).
- Exact-string test assertions that will break: 5 (`dslFormatter.test.ts` lines 269, 567, 1033, 1598, 1731).
- `GENERATOR_STEPS` entries in `src/mcp/server.ts`: 6 (lines 114–123) — **unchanged** by 2c.
- `totalSteps` constants in `server.ts`: 1 active reference in `apply-recipe` at line 845 (`shouldRegenerate ? 7 : 1` = apply + 6 generators). The `remove-layer` MCP tool (2c) copies this same pattern.
- Existing `remove-layer` mutator test coverage in `test/c3/layoutMutator.test.ts`: 5 cases (lines 1522–1558), all at the mutator level — the recipe pipeline gap (validateRecipe + applyParsed path) is confirmed unexercised.
- `docs/mcp-architecture.md` does NOT enumerate tools by name; no update needed there for 2c.
- `docs/cli.md` has no `remove-layer` subcommand section; needs a new section for 2c.

---

## Tasks

### Task 1 — Add global-variable scope tests (failing) + fixture variables — `[WIP]` P-step — genvid-dev:ts-implementer
1. Add two events to `test/fixtures/sample-project/eventSheets/Event sheet 1.json`: a root-level `variable` event (global) and a variable nested inside a group (local). Write C3 JSON tab-indented + trailing newline. Use explicit, hardcoded `sid` values in the project's safe range (pick two unused values from `sid-registry.txt`) so the golden stays deterministic. Do not reformat any other fixture file.
2. Add unit tests in `test/c3/dslFormatter.test.ts` (FAIL until Task 2):
   - `renderNodeSelf` variable case: root-level (scope `global`) → `global var name: type = val`; nested (scope `local`) → `var name: type = val` unchanged.
   - `buildIndexEntry` variable case: `events[N]` jsonPath → description starts with `global `; `events[N].children[M]` → does NOT.
   - `buildShallowSidMap` variable case: same derivation from jsonPath.
   - `parseIndexText` + `resolveByName` roundtrip: a row whose description is `global var count: number = 0` parses correctly (col-5 safety) and is matched by `resolveByName("global var")`.
3. Update the 5 existing exact-string assertions (lines 269, 567, 1033, 1598, 1731) to their **new** expected strings (add `global ` only where the variable is at `events[N]` sheet-root scope; nested-variable assertions keep their current form).

**Files:** `test/fixtures/sample-project/eventSheets/Event sheet 1.json`, `test/c3/dslFormatter.test.ts`
**Commit:** `test: add failing tests for global-var scope markers + update existing assertions [WIP]`

### Task 2 — Implement global-variable scope markers (1a) — F-step — genvid-dev:ts-implementer
Change `formatVariableDescription` to `(event, scope: "global" | "local")`; prepend `"global "` when global. Thread scope through all three call sites:
1. `formatVariable` (line 55) — add `scope` param; caller `renderNodeSelf` (line 88) gains a fifth param `scope: "global" | "local" = "local"` (defaulted → backward-compatible arity; semver note). At `renderEventsInto` (line 295): pass `"global"` when `ctx.depth === 0`, else `"local"`.
2. `buildIndexEntry` variable case (line 209): scope from jsonPath — `events[N]` with no `.children` = global, else local. (`jsonPath.includes(".children")` predicate; document the assumption.)
3. `buildShallowSidMap` variable case (line 508): same `.includes(".children")` derivation from `ctx.jsonPath`.

Then regenerate the golden: `npx tsx src/cli.ts generate --project-dir test/fixtures/sample-project` and commit updated `extracted/` alongside.

**Files:** `src/c3/dslFormatter.ts`, `test/fixtures/sample-project/extracted/eventSheets/Event sheet 1.dsl.txt`, `…/Event sheet 1.dsl.idx.txt`, `test/fixtures/sample-project/extracted/sid-registry.txt`
**Verification:** `npm run lint && npm run typecheck && npm test` — Task 1 tests now green; golden passes.
**Commit:** `feat: mark global event-variable declarations with "global" keyword prefix in DSL output`
**Body:** `formatVariableDescription`/`renderNodeSelf` signature change = breaking at next semver tag; scope derived from depth (render path) and jsonPath `.children` presence (index/sids paths).

### Task 3 — Recipe-pipeline tests for remove-layer (2a) — P-step — genvid-dev:ts-implementer
Pure test addition (zero behavior change). New `describe("remove-layer recipe pipeline")` in `test/c3/dryRunValidation.test.ts`:
- Valid `{ layouts: { "layouts/Lay.json": [{ op: "remove-layer", layer: "Layer 0" }] } }` passes `validateRecipe`.
- Missing `layer` field rejected (exercises `recipeInterpreter.ts:2969–2971`).
- Applied recipe removes the layer (drive `applyRecipeInner` with `dryRun:false`; read layout back to assert).
- Dry-run log line emitted (`dryRun:true`, assert log contains `remove-layer layer="Layer 0"` or equivalent; matches `recipeApplier.ts:826–828`).

**Files:** `test/c3/dryRunValidation.test.ts`
**Commit:** `test: add recipe-pipeline coverage for remove-layer (validateRecipe + applyRecipeInner + dry-run log)`

### Task 4 — Add removeLayerCascade mutator (2b) — P-step — genvid-dev:ts-implementer
Add `removeLayerCascade(layout, layerName, opts: { removeInstances?: boolean }): void` to `src/c3/layoutMutator.ts`:
1. `findLayerEntry` (already imported) to locate; throw "not found" if missing.
2. Helper `countInstancesInSubtree(layer): number` — recursively counts `layer.instances` + all `layer.subLayers`.
3. If `countInstancesInSubtree > 0 && !opts.removeInstances` → throw (`… subtree contains N instance(s) — pass removeInstances: true to force removal`).
4. Else `entry.parent.splice(entry.index, 1)` — drops the whole subtree.

Tests in `test/c3/layoutMutator.test.ts` (new describe): removes empty subtree; refuses subtree-with-instances; removes with `removeInstances:true`; throws if not found.

**Files:** `src/c3/layoutMutator.ts`, `test/c3/layoutMutator.test.ts`
**Commit:** `feat: add removeLayerCascade mutator — splices entire layer subtree, refuses instances unless forced`

### Task 5 — Wire cascade into recipe types, validation, dispatch (2b) — F-step — genvid-dev:ts-implementer
- `src/c3/recipeInterpreter.ts`: extend `RemoveLayerOp` (394–397) with `cascade?: boolean`, `removeInstances?: boolean`. In `validateRecipe` (~2969–2971): `cascade`/`removeInstances` non-boolean → error; `removeInstances:true` without `cascade` → error ("removeInstances is only meaningful when cascade is true").
- `src/c3/recipeApplier.ts`: case `"remove-layer"` (666–669) routes to `removeLayerCascade(layout, op.layer, { removeInstances: op.removeInstances })` when `op.cascade === true`, else existing `removeLayer`; import it. Dry-run log (826–828): append `(cascade)` / `(cascade + removeInstances)`.
- Tests in `test/c3/dryRunValidation.test.ts`: cascade empty subtree applies; cascade w/ instances rejected; cascade+removeInstances succeeds; removeInstances without cascade rejected by `validateRecipe`.

**Files:** `src/c3/recipeInterpreter.ts`, `src/c3/recipeApplier.ts`, `test/c3/dryRunValidation.test.ts`
**Commit:** `feat: cascade remove-layer recipe op — extend RemoveLayerOp with cascade/removeInstances, wire dispatch`

### Task 6 — Document cascade in recipe-reference.md (2b docs) — genvid-dev:ts-implementer
Update `docs/recipe-reference.md` lines 580–586 (`remove-layer` op table): add `cascade` and `removeInstances` rows + prose explaining the semantics.

**Files:** `docs/recipe-reference.md`
**Commit:** `docs: document cascade and removeInstances fields on remove-layer op`

### Task 7 — Standalone remove-layer MCP tool + CLI subcommand (2c) — F-step — genvid-dev:ts-implementer
- `src/mcp/server.ts`: new `registerTool("remove-layer", …)` (near project-mutation tools). `annotations: MUTATE`. Inputs: `layout` (relative path within `layouts/`), `layer`, `cascade?`, `removeInstances?`, `txId?`, `regenerate?`. Handler: path-traversal guard via `resolveWithin` (read a nearby mutate tool's exact call pattern — don't guess arg order). Build recipe inline `{ layouts: { [layout]: [{ op: "remove-layer", layer, ...(cascade?{cascade}:{}), ...(removeInstances?{removeInstances}:{}) }] } }`. Call `applyParsed` inside `watcher.suppress`. `totalSteps = shouldRegenerate ? 7 : 1`. `watcher.bump()` + `extractedDirty` handling on success and `CancelledError`. **GENERATOR_STEPS/GENERATOR_NAMES untouched** — confirm by grep.
- `src/cli.ts`: `remove-layer` command. Options: `--layout` (req), `--layer` (req), `--cascade`, `--remove-instances`, `--dry-run`, `--no-regenerate`. Build recipe inline, call `applyParsed`.
- `docs/cli.md`: new `remove-layer` section.
- Grep-confirm `GENERATOR_STEPS`, `GENERATOR_NAMES`, `totalSteps`, `progressTotal`, `regenerate` tool description are all untouched.

**Files:** `src/mcp/server.ts`, `src/cli.ts`, `docs/cli.md`
**Commit:** `feat: add remove-layer MCP tool and CLI subcommand — standalone layer removal with cascade support`

### Task 8 — File c3source intent request for eventvar classifier (1b-defer) — genvid-dev:ts-implementer
No code. File a GitHub issue on `genvid-holdings/c3source` requesting `isEventVarReference(ace): { name: string } | null` (owns the System eventvar ACE-id list as a domain fact; knows which param carries the variable name). Reference construct3-chef #58. Add a tracking comment on #58 noting 1b is deferred pending the classifier, linking the c3source issue.

**Files:** none (GitHub issues only)
**Commit:** `docs: note 1b defer for eventvar-reference scope markers pending c3source classifier`

---

## Validation
Each task: `npm run lint && npm run typecheck && npm test`. `lint` runs ESLint + `prettier --check`; run `npm run format` before committing if drift. The golden test (`test/c3/sampleProjectGolden.test.ts`) is load-bearing for Task 2 — regenerate `extracted/` after Task 2's fixture+logic changes.

## PR Strategy
One PR for all 8 tasks. Body references `#58` in prose (NOT `Closes #58` — stays open for 1b); notes the semver-relevant `formatVariableDescription`/`renderNodeSelf` signature changes; confirms `GENERATOR_STEPS`/count docs untouched.

## Risks
| Risk | Mitigation |
|------|------------|
| `renderNodeSelf` exported via `src/index.ts`; adding a `scope` param changes the public signature. | Default the param to `"local"` (runtime-compatible; TS callers see no error unless they relied on old arity). Note in commit body; flag at next release tag. |
| `buildIndexEntry` scope uses `jsonPath.includes(".children")` heuristic — silently breaks if path encoding changes. | Correct for current visitEvents path format; document the assumption in a comment. Threading `ctx.depth` directly is the more robust follow-up. |
| Added fixture variables change `sid-registry.txt` + both extracted DSL files; non-deterministic SIDs would break the golden. | Hardcode explicit `sid` values for the new variables (pick two unused from `sid-registry.txt`). |
| Tasks 4 (mutator) and 5 (recipe wiring) are separate commits; between them `removeLayerCascade` is unreachable via recipe. | By design (P-step/F-step split); no mitigation needed. |
| Task 7 `resolveWithin` arg order / `PROJECT_ROOT`-relative guard. | Implementer must read the `resolveWithin` usage in a nearby mutate tool before writing — don't guess from memory. |
| Task 1 commits a red state (5 reassigned assertions before Task 2 lands). | `[WIP]` subject; PR squash-merges so the intermediate red never lands on main. |

## Session estimate
Single session. Tasks 1–7 sequential; Task 8 is a pure GitHub action. ~3–4 hours focused implementer time.
