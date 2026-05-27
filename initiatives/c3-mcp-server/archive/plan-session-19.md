# Plan: C3 MCP Server Session 19

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch
`BUR-0000-c3-mcp-server-s19` — branch from `main`

## Dependencies
No prerequisite branches. Session 18 is already merged. Branch from `main`.

## Summary
Three user-facing deliverables: `read-event-sids` MCP tool (reads SIDs directly from source JSON, no regeneration needed), mtime-based staleness detection for read tools that serve from `extracted/`, and initiative housekeeping (R1 + R4). All TypeScript; no C3 changes.

---

## Tasks

### P-steps (Prepare)

#### P1. Add `SidMapEntry` type and `buildShallowSidMap` library function — ts-implementer

Adds the pure traversal function to `dslFormatter.ts`. No callers yet. The recursive walk mirrors `formatEvent`'s switch on `eventType`, collecting `jsonPath`, `sid`, and `description` for every node. Include events emit `sid: undefined`. Groups recurse into `children`.

**Files:**
- `bin/c3/dslFormatter.ts` — add `SidMapEntry` interface + `buildShallowSidMap` export

**Commit:** `feat [WIP] - BUR-0000: Add buildShallowSidMap library function to dslFormatter`

**Depends on:** nothing

**Verification:** `npm run typecheck`

---

#### P2. Write unit tests for `buildShallowSidMap` — ts-implementer

TDD phase. Covers:
1. Variable event — emits `sid`, description as `var name: type = value`
2. Group event — emits `sid`, description as `group "title"`, recurses into children
3. Block/function-block/custom-ace-block events — each emits `sid`, description
4. Include event — emits `sid: undefined`, description as `include SheetName`
5. Comment event — emits `sid: undefined`, description as `// text`
6. Grep filter — only matching entries returned
7. Nested children — `jsonPath` is `events[1].children[0]`

**Files:**
- `test/c3/dslFormatter.test.ts` — append new `describe("buildShallowSidMap", ...)` block

**Commit:** `test - BUR-0000: Add unit tests for buildShallowSidMap`

**Depends on:** P1

**Verification:** `npm run test -- --grep "buildShallowSidMap"`

---

#### P3. Add `checkSourceFreshness` helper to server.ts — ts-implementer

Pure addition — a module-level function, not yet called. Compares `fs.statSync().mtimeMs` on source file vs extracted file. If source is newer and `extractedDirty` is false: sets `extractedDirty = true`, increments `txId`, emits a warning log. No-ops if already dirty or if either file is missing.

**Files:**
- `bin/mcp/server.ts` — add `checkSourceFreshness` function

**Commit:** `feat [WIP] - BUR-0000: Add checkSourceFreshness helper (unwired)`

**Depends on:** nothing (parallel with P1/P2)

**Verification:** `npm run typecheck`

---

### F-steps (Feature)

#### F1. Make `buildShallowSidMap` tests pass — ts-implementer

Complete the implementation so all P2 tests go green. The `description` field mirrors what `formatEvent` produces in `DslIndexEntry.description`.

**Files:**
- `bin/c3/dslFormatter.ts` — complete `buildShallowSidMap` implementation

**Commit:** `feat - BUR-0000: Implement buildShallowSidMap (tests green)`

**Depends on:** P1, P2

**Verification:** `npm run test -- --grep "buildShallowSidMap"` all pass; `npm run lint`

---

#### F2. Register `read-event-sids` MCP tool — ts-implementer

Wire `buildShallowSidMap` into a new tool handler. The tool:
- Reads `eventSheets/{sheet}.json` directly from disk (not `readExtracted`)
- Returns pipe-delimited table matching `.dsl.idx.txt` format
- `sid: undefined` (includes) renders as `(no SID)`
- Annotations: `READ_ONLY`
- Tool count: 23 → 24

**Files:**
- `bin/mcp/server.ts` — add `read-event-sids` tool registration

**Commit:** `feat - BUR-0000: Register read-event-sids MCP tool (tool #24)`

**Depends on:** F1

**Verification:** `npm run typecheck && npm run lint`

---

#### F3. Wire `checkSourceFreshness` into read tool handlers — ts-implementer

Call `checkSourceFreshness` at top of five handler bodies:

| Tool | Source | Extracted |
|------|--------|-----------|
| `read-dsl` | `eventSheets/{sheet}.json` | `extracted/eventSheets/{sheet}.dsl.txt` |
| `read-dsl-index` | `eventSheets/{sheet}.json` | `extracted/eventSheets/{sheet}.dsl.idx.txt` |
| `read-scripts` | `eventSheets/{sheet}.json` | `extracted/eventSheets/{sheet}.ts` |
| `resolve-anchor` | `eventSheets/{sheet}.json` | `extracted/eventSheets/{sheet}.dsl.idx.txt` |
| `read-layout` | `layouts/{layout}.json` | `extracted/layouts/{layout}.layout.txt` |

**Files:**
- `bin/mcp/server.ts` — add `checkSourceFreshness(...)` call in each handler

**Commit:** `feat - BUR-0000: Wire checkSourceFreshness into read tool handlers (R3)`

**Depends on:** P3

**Verification:** `npm run typecheck && npm run lint && npm run test`

---

#### F4. Initiative housekeeping: R1 + R4 — ts-implementer

R1 — Strikethrough 5 completed Future items with session references:
1. "Reject unknown fields on typed ops" (S12)
2. "Warn on `add-include` + path-based targeting" (S12)
3. "Document `include` in create mode" (S12)
4. "`remove-layer`" (S13)
5. "`remove-instance` layer filter" (S13)

Update stats (tool count = 24, test count from final run). Reconcile Next Up / Future.

R4 — Append `## Closing Assessment (Session 19)` with What's Complete / What Remains / Recommendation.

**Files:**
- `initiatives/c3-mcp-server/initiative.md`

**Commit:** `docs - BUR-0000: Session 19 retro — initiative housekeeping + closing assessment`

**Depends on:** F2, F3 (needs final counts)

**Verification:** review diff

---

### Validation

#### V1. Full validation pass — validator

```bash
npm run lint
npm run test
npm run typecheck
```

---

## Commit Order Summary

```
P3  feat [WIP]  - Add checkSourceFreshness helper (unwired)
P1  feat [WIP]  - Add buildShallowSidMap library function
P2  test        - Add unit tests for buildShallowSidMap
F1  feat        - Implement buildShallowSidMap (tests green)
F2  feat        - Register read-event-sids MCP tool (#24)
F3  feat        - Wire checkSourceFreshness into read tool handlers (R3)
F4  docs        - Session 19 retro — initiative housekeeping + closing assessment
```

P1 and P3 can be authored in either order (no dependency). P2 depends on P1.

---

## Risks

| Risk | Mitigation |
|------|------------|
| `buildShallowSidMap` description strings diverge from `.dsl.idx.txt` | Copy description logic from `formatEvent`'s index entries |
| `fs.statSync` throws on missing dirs (first run) | Wrap in try/catch, return cleanly |
| `read-event-sids` output column widths ragged for deep nesting | Match `formatIndex` padding from `dslFormatter.ts` |
| F3 touches 5 handlers — copy-paste path error | Each path reuses the same `sheet`/`layout` param already validated |
| R1 wrong items struck | Cross-check each candidate against session commit history |

---

## Session Definition of Done

- [ ] `npm run test` all green (no regressions)
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `buildShallowSidMap` has unit tests covering all 7 event types + grep filter
- [ ] `read-event-sids` registered as tool #24, reads from source JSON not `extracted/`
- [ ] `checkSourceFreshness` called in all 5 read handlers
- [ ] `checkSourceFreshness` is a no-op when extracted file is missing (first-run safe)
- [ ] Initiative.md has 5 Future items struck, updated stats, and `## Closing Assessment` section
- [ ] All commits follow `{type} - BUR-0000: Description` format
