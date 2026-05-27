# Design: Filesystem Independence for construct3-chef

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

## Requirements Summary

Enable MCP-only clients to access all read/search functionality currently requiring direct filesystem access. Three features: unified search tool (R1), read tool pagination (R2), and DSL anchor resolution (R3). Full requirements: [filesystem-independence-requirements.md](filesystem-independence-requirements.md).

## Feature 1: Unified Search Tool (`search`)

### Option A: Library + Thin MCP Wrapper (recommended)

Extract search logic into `bin/c3/search.ts` following the Library/CLI Separation pattern. The MCP tool becomes a thin wrapper that validates params and calls the library.

**Library API** (`bin/c3/search.ts`):

```typescript
/** File category for search operations. */
export type SearchType = "dsl" | "ts" | "layout" | "md" | "json" | "idx";

export interface SearchOptions {
  /** Regex pattern to search for. */
  pattern: string;
  /** File category. Default: "dsl". */
  type?: SearchType;
  /** Single file path or directory prefix to restrict scope. */
  path?: string;
  /** Context lines around matches (grep -C behavior). */
  context?: number;
}

export interface SearchConfig {
  projectRoot: string;
  extractedDir: string;
  maxMatches?: number;       // default 1000
  maxPatternLength?: number; // default 500
}

export interface SearchResult {
  lines: string[];
  truncated: boolean;
  /** True when search targeted extracted/ files (stale warning applies). */
  isExtracted: boolean;
}

export function search(config: SearchConfig, options: SearchOptions): SearchResult;
```

**Type-to-path mapping** (internal to search.ts):

```typescript
const TYPE_MAP: Record<SearchType, { baseDir: "extracted" | "project"; subDir: string; ext: string }> = {
  dsl:    { baseDir: "extracted", subDir: "eventSheets", ext: ".dsl.txt" },
  ts:     { baseDir: "extracted", subDir: "eventSheets", ext: ".ts" },
  layout: { baseDir: "extracted", subDir: "layouts",     ext: ".layout.txt" },
  md:     { baseDir: "extracted", subDir: "domain-index", ext: ".md" },
  idx:    { baseDir: "extracted", subDir: "eventSheets", ext: ".dsl.idx.txt" },
  json:   { baseDir: "project",  subDir: "",             ext: ".json" },
};
```

For `json` type, `subDir` is empty because the `path` param must include `eventSheets/` or `layouts/` prefix. The library validates this: if `type === "json"` and `path` does not start with `eventSheets/` or `layouts/`, return an error.

**Context lines implementation**: When `context > 0`, after collecting matching line indices per file, expand each match into a window `[match - context, match + context]`, merge overlapping windows, and format with `--` separators between non-adjacent groups.

**MCP wrapper** (in server.ts): Replaces `search-dsl` registration. Validates params via zod, calls `search()`, wraps result with `appendStaleWarning` when `result.isExtracted`.

**Tool signature**:

```
search(
  pattern: string,        // "Regex pattern to search for"
  type?: "dsl" | "ts" | "layout" | "md" | "json" | "idx",
                          // "File category to search (default: dsl)"
  path?: string,          // "Single file or directory prefix (e.g. 'Main Menu/CommonBattleEvents' or 'Goals'). For json type, must include 'eventSheets/' or 'layouts/' prefix"
  context?: number,       // "Context lines around matches (like grep -C)"
)
```

**Path resolution for single-file targeting**: The library resolves `path` as follows:
1. Join `path` with the type's extension to form a candidate file path.
2. If that file exists, search only that file.
3. Otherwise, treat `path` as a directory prefix and walk all matching files under it.

This eliminates the current `glob` parameter's ambiguity (documented in lessons-learned) where `eventSheets/Main Menu/StoryBattleEvents` would search the entire `Main Menu/` directory.

### Option B: Inline in server.ts

Keep all search logic in server.ts, refactoring the current `search-dsl` handler to accept the new params.

**Tradeoffs vs Option A**:
- (+) Fewer files to change (no new module)
- (-) Cannot unit test search logic without MCP server harness
- (-) server.ts is already 800+ lines; adding context-line logic increases complexity
- (-) Breaks the established Library/CLI pattern

**Recommendation**: Option A. The context-line merging logic alone justifies extraction for testability.

### Tool Count Impact

Net zero: `search-dsl` is removed, `search` is added.

## Feature 2: Read Tool Pagination

### Option A: Shared Pagination Helper (recommended)

Add a `paginateText` helper in `bin/c3/pagination.ts`:

```typescript
export interface PaginationOptions {
  offset?: number;  // 1-based start line (default: 1)
  limit?: number;   // max lines to return (default: all)
}

export interface PaginatedResult {
  text: string;
  totalLines: number;
  offset: number;     // actual offset used (1 if not specified)
  limit: number;      // actual limit used (totalLines if not specified)
  hasMore: boolean;   // true if there are more lines after this page
}

export function paginateText(fullText: string, options: PaginationOptions): PaginatedResult;
```

**MCP response format**: Use multi-block content (same pattern as `validate-recipe` with txId):

```typescript
return {
  content: [
    { type: "text", text: appendStaleWarning(paginated.text) },
    { type: "text", text: `lines: ${paginated.offset}-${paginated.offset + actualCount - 1} / ${paginated.totalLines}` },
  ],
};
```

The metadata block format `lines: 1-50 / 347` is human-readable and machine-parseable. The `hasMore` boolean is implicit: if the range end < totalLines, there's more.

**Schema changes**: All 7 read tools add two optional zod params:

```typescript
offset: z.number().int().min(1).optional().describe("Start line (1-based). Omit to start from beginning."),
limit: z.number().int().min(1).optional().describe("Max lines to return. Omit to return all."),
```

**Integration pattern**: Each read tool follows the same flow:

```typescript
// Before (current):
return { content: [{ type: "text", text: appendStaleWarning(text) }] };

// After:
const paginated = paginateText(text, { offset, limit });
const content: { type: "text"; text: string }[] = [
  { type: "text", text: appendStaleWarning(paginated.text) },
];
if (offset !== undefined || limit !== undefined) {
  content.push({ type: "text", text: `lines: ${paginated.offset}-${paginated.offset + Math.max(0, paginated.text.split("\n").length - 1)} / ${paginated.totalLines}` });
}
return { content };
```

The metadata block is only added when pagination params are provided. When neither offset nor limit is given, behavior is identical to today (single text block, no metadata).

### Option B: Inline per tool

Duplicate the slicing logic in each handler.

**Tradeoffs vs Option A**:
- (+) No new module
- (-) 7x duplication of identical logic
- (-) Harder to test, harder to keep consistent

**Recommendation**: Option A. A shared helper eliminates duplication and is trivially testable.

### `read-dsl-index` special case

`read-dsl-index` already has a `grep` parameter. When both `grep` and `offset`/`limit` are provided, apply `grep` first (filtering), then paginate the result. The `totalLines` in metadata reflects the filtered result, not the original file. This is the intuitive behavior: "filter first, then page through results."

### Tool Count Impact

Zero. No new tools, only new optional params on existing tools.

## Feature 3: DSL Anchor Resolution

### Design Decision: Single Tool with `by` Parameter (recommended)

A single `resolve-anchor` tool with a `by` parameter that selects the lookup key type. This keeps the tool count at +1 instead of +3.

**Why not separate tools**: The three lookups (by-line, by-sid, by-name) share the same data source (`.dsl.idx.txt`), the same output format, and the same index-parsing logic. Separate tools would triple the registration boilerplate for no user benefit.

### Option A: Parse `.dsl.idx.txt` text at query time (recommended)

Parse the existing formatted index text on each call. The index files are small (a few hundred lines) and parsing is fast.

**Library API** (`bin/c3/anchorResolver.ts`):

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
  exact: boolean;        // true if lookup matched exactly, false if nearest-enclosing
  anchor: Anchor;
  /** For by-name, there may be multiple matches (e.g., overloaded function names). */
  alternatives?: Anchor[];
}

/**
 * Parse a .dsl.idx.txt file and resolve an anchor lookup.
 * Returns null if no match found.
 */
export function resolveAnchor(indexText: string, lookup: AnchorLookup): AnchorResult | null;

/**
 * Parse a .dsl.idx.txt file into structured entries.
 * Reuses the column layout from formatIndex output.
 */
export function parseIndexText(indexText: string): Anchor[];
```

**Parsing strategy**: The `.dsl.idx.txt` format has fixed-width columns with `|` separators. The parser splits each non-header line on `|`, trims each field, and extracts:
- Event number (integer or `-` for non-counting)
- JSON path (or `action[N]` for action rows)
- SID (paragraph sign `§` prefix + 15-digit number, or blank)
- DSL line number (integer, or blank for action rows)
- Description (remainder)

Action-level rows (no DSL line, no SID) are skipped for anchor resolution since they cannot be recipe targets.

**Lookup semantics**:

- **`by: "line"`**: Find the entry whose `dslLine` is closest to and <= the given line. This gives the "nearest enclosing" behavior for lines that fall inside a block's actions (which don't have their own index entry). Set `exact: true` only when `dslLine` matches exactly.

- **`by: "sid"`**: Find the entry whose `sid` matches exactly. SIDs are unique within a sheet. Return `exact: true` always (SID lookup is always exact or not found).

- **`by: "name"`**: Regex-match the `description` field. Return the first match as primary, any additional matches as `alternatives`. This handles both exact names (e.g., `toggleInteractiveLayers`) and partial patterns (e.g., `toggle.*Layers`).

**MCP tool signature**:

```
resolve-anchor(
  sheet: string,     // "Relative path to the event sheet, without extension"
  by: "line" | "sid" | "name",  // "Lookup key type"
  value: string,     // "The value to look up: a line number, SID (digits only), or name/pattern"
)
```

`value` is always a string to keep the schema simple (zod union types on inputSchema are awkward). The library parses it based on `by`:
- `by: "line"` -> `parseInt(value)`, error if NaN
- `by: "sid"` -> `parseInt(value)`, error if NaN
- `by: "name"` -> used as regex pattern against description field

**Output format** (text, human-readable):

```
DSL Line: 10
JSON Path: events[2].children[0].children[0]
SID: §406416592572883
Description: block
Match: exact

[If alternatives exist:]
---
Also matched:
  Line 56: block [OR] (SID: §331145262835930, Path: events[2].children[1].children[0])
```

### Option B: Reuse `DslIndexEntry[]` from generator

Instead of parsing `.dsl.idx.txt` text, import `formatEventSheet` from `dslFormatter.ts`, re-generate the `DslIndexEntry[]` array from the source JSON, and query that directly.

**Tradeoffs vs Option A**:
- (+) Uses typed `DslIndexEntry` objects directly, no text parsing
- (-) Reads and parses the full source event sheet JSON (potentially large)
- (-) Couples anchor resolution to the generator pipeline
- (-) More expensive per call (JSON parse + DSL generation vs. text line parsing)
- (-) Result could differ from what's in the `.dsl.idx.txt` if extracted files are stale (but we already warn about staleness)

**Recommendation**: Option A. Parsing the text file is simpler, faster, and correctly reflects what the user sees in `read-dsl-index`.

### Tool Count Impact

+1: `resolve-anchor`.

## Consumer Workflow

### Search workflow (agent using MCP tools only)

1. Agent wants to find all uses of `toggleInteractiveLayers` across event sheets.
2. Calls `search(pattern: "toggleInteractiveLayers")` -- defaults to `type: "dsl"`.
3. Gets grep-style output: `eventSheets/Main Menu/CommonBattleEvents.dsl.txt:14: ...`
4. Wants context: calls `search(pattern: "toggleInteractiveLayers", context: 3)`.
5. Gets surrounding lines with `--` separators between groups.
6. Wants to check the raw JSON: calls `search(pattern: "toggleInteractiveLayers", type: "json", path: "eventSheets/Main Menu")`.
7. Wants to search a single file: calls `search(pattern: "block", type: "dsl", path: "Main Menu/CommonBattleEvents")`.
   - Library resolves to `extracted/eventSheets/Main Menu/CommonBattleEvents.dsl.txt`, single file match.

### Pagination workflow (reading a large file in chunks)

1. Agent calls `read-dsl(sheet: "Main Menu/CommonBattleEvents")` without pagination -- gets full file + no metadata block.
2. File is 500 lines. Agent realizes it only needs lines 100-150.
3. Calls `read-dsl(sheet: "Main Menu/CommonBattleEvents", offset: 100, limit: 50)`.
4. Gets content for lines 100-149 plus metadata block: `lines: 100-149 / 500`.
5. Agent knows there are 351 more lines and can request the next page if needed.

### Anchor resolution workflow (converting search hit to recipe target)

1. Agent searches for a function: `search(pattern: "function handleBattleEnd")`.
2. Gets match at `CommonBattleEvents.dsl.txt:87`.
3. Needs the SID for a recipe: calls `resolve-anchor(sheet: "Main Menu/CommonBattleEvents", by: "line", value: "87")`.
4. Gets: `SID: §123456789012345, JSON Path: events[5].children[2], Description: function handleBattleEnd()`.
5. Uses the SID in a recipe: `"in": "sid:123456789012345"`.

Alternative: agent knows a function name, not a line number:
1. Calls `resolve-anchor(sheet: "Main Menu/CommonBattleEvents", by: "name", value: "handleBattleEnd")`.
2. Gets same result without needing a search first.

## Friction Audit

### Missing seams

1. **`readExtracted` returns `string | null`** -- no way to get the file path back for error messages. The pagination helper needs the text content, not the path, so this is fine. No change needed.

2. **`globRelative` is coupled to single extension** -- the unified search needs it to accept compound extensions like `.dsl.idx.txt`. The current `ext` parameter uses `endsWith()`, which already handles compound extensions. No change needed.

3. **No `readProjectFile` helper** -- the `json` type in search needs to read from `PROJECT_ROOT` instead of `EXTRACTED_DIR`. The search library takes both roots as config, so the library handles this internally. No new helper needed in server.ts.

### Preparatory refactors

1. **Extract `walkSearch` into the search library**. The current inline `walkSearch` closure in server.ts becomes the core of `bin/c3/search.ts`. This is the main structural change.

2. **No refactoring needed for pagination** -- the helper is purely additive.

3. **No refactoring needed for anchor resolution** -- parsing `.dsl.idx.txt` is new code with no existing entanglements.

### P-steps vs F-steps split

**P-steps** (pure additions, zero behavioral change):
- P1: Create `bin/c3/search.ts` with `search()` function and tests
- P2: Create `bin/c3/pagination.ts` with `paginateText()` function and tests
- P3: Create `bin/c3/anchorResolver.ts` with `resolveAnchor()` and `parseIndexText()` functions and tests

**F-steps** (wiring, behavioral change):
- F1: Replace `search-dsl` with `search` in server.ts, calling the library
- F2: Add `offset`/`limit` params to all 7 read tools, using the pagination helper
- F3: Add `resolve-anchor` tool registration in server.ts
- F4: Update agent configs and docs (`search-dsl` -> `search`, new tools)

Each P-step is independently committable and testable. Each F-step depends on its corresponding P-step but is independent of other F-steps.

### Useful tooling

- **Test fixture**: A small synthetic `.dsl.idx.txt` file (10-20 entries) for anchor resolution tests. Better than depending on real extracted files that change with the project.
- **Search test fixture**: A small directory of synthetic files (one `.dsl.txt`, one `.ts`, one `.layout.txt`) for search tests.

### Simpler alternatives to async joins

No async joins needed. All operations are synchronous file reads wrapped in `rwlock.read()`.

### Observability

- **emitLog on search**: Log `info` with type, path, and match count (like current search-dsl doesn't, but useful for debugging).
- **emitLog on anchor miss**: Log `warning` when resolve-anchor finds no match (likely stale data or typo).

## Test Criteria

| Requirement | Verification | Type |
|------------|-------------|------|
| R1 (search type filter) | `search({pattern: "x", type: "ts"})` searches only `.ts` files | Unit test |
| R1 (default type) | `search({pattern: "x"})` searches only `.dsl.txt` files | Unit test |
| R1 (single-file path) | `search({..., path: "Main Menu/CommonBattleEvents"})` searches one file only | Unit test |
| R1 (directory prefix path) | `search({..., path: "Main Menu"})` searches all files in `Main Menu/` | Unit test |
| R1 (context lines) | `search({..., context: 2})` returns 2 lines before/after each match | Unit test |
| R1 (context merge) | Adjacent matches with overlapping context windows merge into one block | Unit test |
| R1 (context separator) | Non-adjacent context groups separated by `--` line | Unit test |
| R1 (json type requires prefix) | `search({type: "json", path: "SomeSheet"})` returns error | Unit test |
| R1 (json type valid) | `search({type: "json", path: "eventSheets/Goals"})` works | Unit test |
| R1 (path traversal) | `search({..., path: "../../etc"})` is rejected | Unit test |
| R1 (pattern length cap) | Pattern > 500 chars returns error | Unit test |
| R1 (match truncation) | > 1000 matches truncates with notice | Unit test |
| R1 (isExtracted flag) | `json` type returns `isExtracted: false`, others return `true` | Unit test |
| R2 (offset/limit) | `paginateText(text, {offset: 5, limit: 10})` returns lines 5-14 | Unit test |
| R2 (offset only) | `paginateText(text, {offset: 5})` returns lines 5 to end | Unit test |
| R2 (limit only) | `paginateText(text, {limit: 10})` returns first 10 lines | Unit test |
| R2 (neither) | `paginateText(text, {})` returns full text | Unit test |
| R2 (totalLines) | Result includes correct total line count | Unit test |
| R2 (offset past end) | `offset > totalLines` returns empty text with correct metadata | Unit test |
| R2 (metadata block) | When pagination params provided, response has 2 content blocks | Manual (MCP client) |
| R2 (no metadata without params) | When no pagination params, response has 1 content block | Manual (MCP client) |
| R2 (grep + pagination on read-dsl-index) | grep filters first, then pagination applies to filtered result | Unit test |
| R3 (by line exact) | `resolveAnchor(text, {by: "line", line: 10})` returns entry at line 10 | Unit test |
| R3 (by line nearest) | `resolveAnchor(text, {by: "line", line: 12})` returns nearest enclosing entry | Unit test |
| R3 (by sid) | `resolveAnchor(text, {by: "sid", sid: 406416592572883})` returns correct entry | Unit test |
| R3 (by sid not found) | `resolveAnchor(text, {by: "sid", sid: 999})` returns null | Unit test |
| R3 (by name exact) | `resolveAnchor(text, {by: "name", name: "Battle Icon Events"})` finds the group | Unit test |
| R3 (by name regex) | `resolveAnchor(text, {by: "name", name: "Battle.*Events"})` finds matches | Unit test |
| R3 (by name multiple) | When name matches multiple entries, `alternatives` is populated | Unit test |
| R3 (action rows skipped) | Action-level rows (no DSL line) are not returned as anchor targets | Unit test |
| R3 (parseIndexText) | Correctly parses all fields from formatted `.dsl.idx.txt` text | Unit test |
| R3 (staleness warning) | resolve-anchor response includes stale warning when `extractedDirty` | Manual (MCP client) |
| All: lint passes | `npm run lint` passes after all changes | Validation |
| All: typecheck passes | `npm run typecheck` passes after all changes | Validation |
| All: existing tests pass | `npm run test` passes with no regressions | Validation |

## Cross-Domain Boundary

### TypeScript changes (3 new library files + server.ts modifications)

| File | Change |
|------|--------|
| `bin/c3/search.ts` | **New.** Search library with `search()` function, type mapping, context lines, path resolution. |
| `bin/c3/pagination.ts` | **New.** `paginateText()` helper. |
| `bin/c3/anchorResolver.ts` | **New.** `resolveAnchor()`, `parseIndexText()`. |
| `bin/mcp/server.ts` | Remove `search-dsl` registration. Add `search` registration (calls library). Add `offset`/`limit` params to 7 read tools (calls pagination helper). Add `resolve-anchor` registration (calls library). |
| `test/mcp/search.test.ts` | **New.** Unit tests for search library. |
| `test/mcp/pagination.test.ts` | **New.** Unit tests for pagination helper. |
| `test/mcp/anchorResolver.test.ts` | **New.** Unit tests for anchor resolver. |

### C3 changes

None. This feature is entirely within the MCP server and TypeScript tooling.

### Documentation changes

| File | Change |
|------|--------|
| `.claude/agents/c3-explorer/c3-explorer.md` | `search-dsl` -> `search`, document new params |
| `.claude/agents/c3-implementer/c3-implementer.md` | `search-dsl` -> `search` |
| `.claude/agents/analyst/analyst.md` | `search-dsl` -> `search` |
| `docs/design-patterns.md` | `search-dsl` -> `search` |
| `docs/lessons-learned.md` | `search-dsl` -> `search`, update glob limitation note |
| `initiatives/c3-mcp-server/initiative.md` | Update tool table, Filesystem Independence section |

### Connection point

The MCP server (`server.ts`) imports from the three new library modules. No C3 editor changes, no event sheet changes, no layout changes. Documentation updates are independent of code changes and can be committed separately.

## Summary of Tool Changes

| Before | After | Change |
|--------|-------|--------|
| `search-dsl(pattern, glob?)` | `search(pattern, type?, path?, context?)` | Renamed + extended |
| `read-dsl(sheet)` | `read-dsl(sheet, offset?, limit?)` | +2 optional params |
| `read-dsl-index(sheet, grep?)` | `read-dsl-index(sheet, grep?, offset?, limit?)` | +2 optional params |
| `read-scripts(sheet)` | `read-scripts(sheet, offset?, limit?)` | +2 optional params |
| `read-layout(layout)` | `read-layout(layout, offset?, limit?)` | +2 optional params |
| `read-domain-index(domain?)` | `read-domain-index(domain?, offset?, limit?)` | +2 optional params |
| `read-template-scope()` | `read-template-scope(offset?, limit?)` | +2 optional params |
| `read-sid-registry()` | `read-sid-registry(offset?, limit?)` | +2 optional params |
| *(new)* | `resolve-anchor(sheet, by, value)` | New tool |

**Final tool count**: 22 - 1 (`search-dsl`) + 1 (`search`) + 1 (`resolve-anchor`) = **23 tools**.
