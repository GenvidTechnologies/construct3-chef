# Plan: Filesystem Independence (Session 17)

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch

`BUR-0000-mcp-filesystem-independence`

## Dependencies

No prerequisite branches. All work is additive to `bin/c3/` and `bin/mcp/server.ts`.

## Summary

Add three capabilities to the construct3-chef MCP server: a unified `search` tool (replaces `search-dsl`, adds file type routing, context lines, and single-file targeting), pagination on all 7 read tools (`offset`/`limit`), and a `resolve-anchor` tool for DSL line/SID/name lookup. Final tool count: 23.

This is a single-session plan covering all three phases. Phase 1 (search) is the most complex; phases 2 and 3 are independent of each other and can be parallelized after P2/P3 are done.

---

## Tasks

### P-steps (Prepare — pure additions, no behavioral change)

---

#### P1: Create `bin/c3/search.ts` library with tests — ts-implementer

The core search logic extracted from the current inline `walkSearch` closure in `server.ts`. This is the most complex P-step: type mapping, single-file vs directory prefix resolution, context-line merging with `--` separators, path traversal prevention, and the `json` type's different base directory.

**Files:**
- `bin/c3/search.ts` (new)
- `test/mcp/search.test.ts` (new)

**Test coverage required (TDD red before implementation):**
- Type filter: `type: "ts"` searches only `.ts` files, default `"dsl"` searches only `.dsl.txt`
- Single-file path: `path: "Main Menu/CommonBattleEvents"` + extension resolves to one file
- Directory prefix path: `path: "Main Menu"` walks all matching files under it
- Context lines: `context: 2` returns 2 lines before/after each match
- Context merge: overlapping windows merge into one block (no duplicate lines)
- Context separator: non-adjacent groups separated by `--` line
- `json` type requires `eventSheets/` or `layouts/` prefix in `path`, error otherwise
- `json` type with valid prefix (`path: "eventSheets/Goals"`) works, `isExtracted: false`
- Path traversal: `path: "../../etc"` rejected
- Pattern length cap: pattern > 500 chars returns error
- Match truncation: > 1000 matches truncates with notice, `truncated: true`
- `isExtracted` flag: `json` type returns `false`, all others return `true`
- Fixture: small synthetic directory of files (create under `test/fixtures/search/`)

**Commit:** `feat [WIP] - BUR-0000: Add search library with type routing, context lines, path resolution`

---

#### P2: Create `bin/c3/pagination.ts` library with tests — ts-implementer

A standalone `paginateText()` helper. No dependencies on search or anchor resolver. Can be written and committed in parallel with P1 and P3.

**Files:**
- `bin/c3/pagination.ts` (new)
- `test/mcp/pagination.test.ts` (new)

**Test coverage required (TDD red before implementation):**
- `offset: 5, limit: 10` returns lines 5–14 (1-based)
- `offset: 5` (no limit) returns lines 5 to end
- `limit: 10` (no offset) returns first 10 lines
- Neither provided: returns full text unchanged
- `totalLines` is always the total count of the input text
- `offset > totalLines`: returns empty `text`, correct `totalLines`, `hasMore: false`
- `hasMore`: true when `offset + limit - 1 < totalLines`
- Grep-then-paginate: `read-dsl-index` scenario — apply grep filter first, paginate result, `totalLines` reflects filtered count

**Commit:** `feat [WIP] - BUR-0000: Add pagination library with offset/limit and totalLines metadata`

---

#### P3: Create `bin/c3/anchorResolver.ts` library with tests — ts-implementer

Parses `.dsl.idx.txt` text (fixed-width `|`-separated columns) and resolves anchors by line, SID, or name. No dependency on P1 or P2. Can be written and committed in parallel.

**Files:**
- `bin/c3/anchorResolver.ts` (new)
- `test/mcp/anchorResolver.test.ts` (new)
- `test/fixtures/anchor/sample.dsl.idx.txt` (new — 15–20 synthetic entries covering all column variations)

**Interface** (from design):
```typescript
export interface Anchor {
  eventNumber: number | null;
  jsonPath: string;
  sid: number | undefined;
  dslLine: number;
  description: string;
}
export type AnchorLookup =
  | { by: "line"; line: number }
  | { by: "sid"; sid: number }
  | { by: "name"; name: string };
export interface AnchorResult {
  exact: boolean;
  anchor: Anchor;
  alternatives?: Anchor[];
}
export function resolveAnchor(indexText: string, lookup: AnchorLookup): AnchorResult | null;
export function parseIndexText(indexText: string): Anchor[];
```

**Test coverage required (TDD red before implementation):**
- `parseIndexText`: correctly extracts all fields (eventNumber, jsonPath, sid, dslLine, description)
- `parseIndexText`: action-level rows (no DSL line, no SID) are parsed but excluded from anchor targets
- `by: "line"` exact: entry at exact line returns `exact: true`
- `by: "line"` nearest: line inside a block (no entry) returns nearest enclosing, `exact: false`
- `by: "sid"` found: returns correct entry, `exact: true`
- `by: "sid"` not found: returns `null`
- `by: "name"` exact string: finds entry whose description contains the name
- `by: "name"` regex: `"Battle.*Events"` matches multiple entries, first in `anchor`, rest in `alternatives`
- `by: "name"` no match: returns `null`
- Action rows skipped: action-level rows never appear as `anchor` or `alternatives`

**Commit:** `feat [WIP] - BUR-0000: Add anchor resolver library with line/SID/name lookup`

---

### F-steps (Feature — wiring behavioral changes)

P-steps P1, P2, P3 are independent of each other and can be parallelized. Each F-step depends only on its corresponding P-step; F1, F2, F3 are independent of each other.

---

#### F1: Wire `search` tool in `server.ts` (replaces `search-dsl`) — ts-implementer

Depends on P1. Remove the `search-dsl` registration (including its inline `walkSearch` closure). Add `search` registration that validates params via zod and calls `search()` from the library. Wrap result with `appendStaleWarning` when `result.isExtracted`. Add `emitLog` on success (type, path, match count).

**Files:**
- `bin/mcp/server.ts` (modify)

**Schema:**
```typescript
{
  pattern: z.string().describe("Regex pattern to search for"),
  type: z.enum(["dsl","ts","layout","md","json","idx"]).optional()
         .describe("File category to search (default: dsl)"),
  path: z.string().optional()
        .describe("Single file or directory prefix. For json type, must include 'eventSheets/' or 'layouts/' prefix"),
  context: z.number().int().min(0).optional()
            .describe("Context lines around matches (like grep -C)"),
}
```

**Commit:** `feat [WIP] - BUR-0000: Replace search-dsl with search tool in server.ts`

---

#### F2: Add `offset`/`limit` pagination to all 7 read tools in `server.ts` — ts-implementer

Depends on P2. All 7 read tools follow the same integration pattern. The metadata block (`lines: X-Y / N`) is added only when at least one pagination param is provided.

**Files:**
- `bin/mcp/server.ts` (modify)

**Integration pattern** (from design):
```typescript
const paginated = paginateText(text, { offset, limit });
const content: { type: "text"; text: string }[] = [
  { type: "text", text: appendStaleWarning(paginated.text) },
];
if (offset !== undefined || limit !== undefined) {
  content.push({ type: "text", text: `lines: ${paginated.offset}-${paginated.offset + paginated.text.split("\n").filter(Boolean).length - 1} / ${paginated.totalLines}` });
}
return { content };
```

For `read-dsl-index`: apply `grep` filter first (existing behavior), then paginate the filtered result. The `totalLines` reflects the filtered count.

**Tools modified:** `read-dsl`, `read-dsl-index`, `read-scripts`, `read-layout`, `read-domain-index`, `read-template-scope`, `read-sid-registry`.

**New zod params for each tool:**
```typescript
offset: z.number().int().min(1).optional().describe("Start line (1-based). Omit to start from beginning."),
limit: z.number().int().min(1).optional().describe("Max lines to return. Omit to return all."),
```

**Commit:** `feat [WIP] - BUR-0000: Add offset/limit pagination to all 7 read tools`

---

#### F3: Add `resolve-anchor` tool in `server.ts` — ts-implementer

Depends on P3. Register `resolve-anchor` as a read-only tool (read lock). Reads the `.dsl.idx.txt` file using `readExtracted`, calls `resolveAnchor()`, formats output as human-readable text. Appends stale warning. Emits `warning` log when no match is found.

**Files:**
- `bin/mcp/server.ts` (modify)

**Tool schema:**
```typescript
{
  sheet: z.string().describe("Relative path to the event sheet, without extension"),
  by: z.enum(["line","sid","name"]).describe("Lookup key type"),
  value: z.string().describe("Line number, SID (digits only), or name/regex pattern"),
}
```

**Path construction:** `extracted/eventSheets/{sheet}.dsl.idx.txt`

**Output format** (from design):
```
DSL Line: 10
JSON Path: events[2].children[0].children[0]
SID: §406416592572883
Description: block
Match: exact

[If alternatives:]
---
Also matched:
  Line 56: block [OR] (SID: §331145262835930, Path: events[2].children[1].children[0])
```

**Commit:** `feat [WIP] - BUR-0000: Add resolve-anchor tool for DSL line/SID/name lookup`

---

#### F4: Update agent configs and docs — ts-implementer

No code dependency. Can be committed last or in parallel with F1–F3. Rename `search-dsl` to `search` across all references, add documentation for new params and tools.

**Files:**
- `.claude/agents/c3-explorer/c3-explorer.md` — `search-dsl` → `search`, document `type`, `path`, `context` params
- `.claude/agents/c3-implementer/c3-implementer.md` — `search-dsl` → `search`
- `.claude/agents/analyst/analyst.md` — `search-dsl` → `search`
- `docs/design-patterns.md` — `search-dsl` → `search`
- `docs/lessons-learned.md` — `search-dsl` → `search`, update single-file targeting note (the `glob` limitation no longer applies)
- `initiatives/c3-mcp-server/initiative.md` — update tool table (23 tools), add Session 17 entry, update Filesystem Independence section

**Commit:** `docs - BUR-0000: Update agent configs and docs for search rename and new tools`

---

### Validation

#### V1: Run lint, typecheck, and full test suite — validator + code-reviewer

**Commands:**
```
npm run lint
npm run typecheck
npm run test
```

Expected: all existing 947 tests pass, new tests pass, lint clean, no type errors.

---

## Dependency Graph

```
P1 (search.ts)       P2 (pagination.ts)     P3 (anchorResolver.ts)
       |                      |                        |
       F1 (search tool)       F2 (pagination wiring)   F3 (resolve-anchor tool)
                                    \         |        /
                                           F4 (docs)
                                              |
                                             V1
```

P1, P2, P3 are fully independent — run in parallel.
F1 depends on P1 only. F2 depends on P2 only. F3 depends on P3 only.
F4 and V1 can run after any F-step; V1 is the final gate.

## Parallelization Opportunities

- **P1 + P2 + P3**: All three P-steps are independent. Assign to parallel subagents if delegating.
- **F1 + F2 + F3**: Each F-step touches `server.ts` at different locations and can be done sequentially in one pass or split into separate commits. Because all three modify `server.ts`, serialize them to avoid merge conflicts.
- **F4**: Can be done concurrently with F1–F3 since it touches only docs and agent configs.

## Risks

| Risk | Mitigation |
|------|-----------|
| Context-line merging logic is subtle — off-by-one in window expansion or separator insertion | Write the merge tests first (TDD red). The test cases `context merge` and `context separator` cover the boundary cases before any implementation. |
| `server.ts` already 800+ lines; three F-steps add more | Commit F1, F2, F3 as sequential WIP commits on the same branch. Each commit is reviewable independently. |
| `.dsl.idx.txt` column format may have edge cases not visible from the design (e.g., long descriptions truncated, special characters in paths) | The fixture file for anchor tests should be constructed from a real `.dsl.idx.txt` sample, not purely synthetic. Read one real file during P3 to validate the parser covers real format variations. |
| `json` type traversal prevention needs a different base directory (`PROJECT_ROOT`) than all other types (`EXTRACTED_DIR`) | The `SearchConfig` passes both `projectRoot` and `extractedDir`; the library selects based on `TYPE_MAP[type].baseDir`. The traversal test (`path: "../../etc"`) must be in the test suite. |
| Agent configs (`c3-explorer`, `c3-implementer`) may reference `search-dsl` in tool usage examples, not just the tool name | During F4, grep all agent config files for `search-dsl` to catch all occurrences, not just known locations. |
| `paginateText` line counting: empty trailing newline may inflate `totalLines` | Nail down the contract in the test: does `"a\nb\n"` have 2 or 3 lines? Decide and document in the function's JSDoc. |

## Session Estimate

Single session. All three phases together are approximately:
- P1: ~2 hours (context-line logic is nontrivial)
- P2: ~30 minutes (straightforward)
- P3: ~1 hour (index parsing + lookup semantics)
- F1–F3: ~1 hour (mechanical wiring once libraries exist)
- F4: ~30 minutes (text replacements + doc updates)
- V1: ~15 minutes

Total: ~5–5.5 hours of focused work. Fits in one session if P-steps are parallelized across subagents.

If splitting, natural break point is after P1+F1 (search feature complete and tested) with P2+F2 and P3+F3 as Session 18.
