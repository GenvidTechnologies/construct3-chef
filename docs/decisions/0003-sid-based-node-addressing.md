# 0003. SID-based node addressing

- **Status:** Accepted (retroactively documented)
- **Date:** 2026-06-18

## Context

This decision predates ADR 0001 and is recorded retroactively.

Recipes must target event-tree and layout nodes stably. C3 event sheets are mutable trees: inserting, removing, or reordering events changes every positional index and JSON path for all subsequent siblings and descendants. Within a single recipe batch, an earlier op can splice an array before a later op resolves its target — making positional addressing unsafe for multi-op recipes.

## Decision

Every C3 node carries a stable `sid` (a random integer in `[1e14, 1e15)`). Recipes address nodes via `"in": "sid:…"` rather than JSON paths or array positions. SIDs are discovered from the `.dsl.idx.txt` index (which lists every node's SID with a `§` prefix) or via the `resolve-anchor` MCP tool.

A **module-level SID context** (`initSidContext` / `resetSidContext` in `src/c3/sidUtils.ts`) is initialized from `sid-registry.txt` before any SID is generated and reset after, guaranteeing that every newly generated SID is globally unique against the project's existing registry. `recipeApplier.applyParsed` wraps the whole apply call in `initSidContext`/`resetSidContext`; tests touching SID generation must initialize the context themselves.

See [CLAUDE.md](../../CLAUDE.md) § "SIDs are the addressing system" and [docs/recipe-reference.md](../recipe-reference.md) § "SID-based addressing" for operational detail.

## Compromise

**Positional / JSON-path addressing** was rejected. Array positions shift as soon as any earlier op in the same recipe batch splices the array. The `SidIndexEntry.indexInParent` field is a snapshot taken at index-build time, not a live pointer — it goes stale the moment an earlier op mutates the parent array. Any op that positions relative to a resolved node (`insert-after`, `remove`, `move`) must therefore recompute position via `parentArray.indexOf(node)`, never trust `indexInParent` for placement. This was concretely demonstrated in recipe-reference gotcha #34 (`insert-event after: "sid:X"` used the stale snapshot and misplaced/appended).

## Consequences

- Recipes survive tree reshaping within a batch, because SIDs are stable across mutations.
- The SID context must be initialized before any new SID is generated; uninitialized generation risks SID collision with the existing project.
- The `.dsl.idx.txt` index is the primary read-surface for SID discovery; `resolve-anchor` provides a search interface over it.
- When a new SID is generated (e.g. for a newly inserted event), the `sid-registry.txt` must be regenerated to keep the context current for subsequent applies.
