# 0004. Recipe pipeline split: pure interpreter vs. I/O applier

- **Status:** Accepted (retroactively documented)
- **Date:** 2026-06-18

## Context

This decision predates ADR 0001 and is recorded retroactively.

Recipe execution has two distinct requirements: (1) it must be unit-testable and support dry-run preview without writing any files; (2) it must perform the actual I/O — reading project files, writing mutations, triggering regeneration, and syncing `project.c3proj`. Combining these in one layer would make the dry-run path indistinguishable from the write path and force filesystem mocking in unit tests.

## Decision

The recipe pipeline is split across two modules:

- **`recipeInterpreter.ts`** — holds the `Recipe` type, all op shorthands, `validateRecipe`, and the **pure** execution functions (`executeRecipe`, `executeFileOps`, `applyReplacements`) that transform in-memory `EventSheet` objects with **no I/O**. This layer is fully unit-testable without filesystem mocking.

- **`recipeApplier.ts`** — the orchestrator **with** I/O. `applyRecipeInner` applies in a fixed order: `objectTypes` → `addInstVars` → `layouts` → `files`, then writes files and triggers regeneration. Workflow ops expand to primitive layout ops in a `workflowExpansion.ts` pre-pass before the layout-file loop runs.

**Two validation chokepoints** fire in both `validate-recipe` dry-run and `apply-recipe`, before any disk write:

1. `assertEditorValid` (wrapping c3source's `validateForEditor`) — checks that the C3 editor will accept the resulting event sheet on import.
2. `validateInsertedCustomActions` (`src/c3/customAceIndex.ts`) — project-context-aware check that rejects a recipe-inserted family-provided custom-action lacking `customActionObjectClass`.

These are different layers: a runtime-resolution defect (chokepoint 2) passes editor validation (chokepoint 1) and renders byte-identical DSL — invisible until C3 runtime.

See [CLAUDE.md](../../CLAUDE.md) § "Recipe pipeline" and [docs/recipe-reference.md](../recipe-reference.md) for full detail.

## Compromise

**A monolithic applier mixing transformation with I/O** was rejected. A single module cannot support dry-run (no-write) validation: the only way to "dry-run" would be to mock the filesystem. It also makes the transformation logic harder to unit-test and makes it impossible to validate before writing.

## Consequences

- Dry-run = run the pure layer + both chokepoints with no write; `validate-recipe` and `apply-recipe` both pass through the same chokepoints.
- Both chokepoints are at the `writeEventSheet` call site — they guard every event-sheet write regardless of which higher-level op triggered it.
- `workflowExpansion.ts` expands composite ops to primitives in a pre-pass; dispatch and dry-run logging iterate the expanded `Map`, so workflow ops are validated as their primitive sequence.
- `assertEditorValid` is not on the `src/index.ts` barrel — it is an internal enforcement point, not public API.
