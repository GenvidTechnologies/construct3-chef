# Analysis: Filesystem Independence for construct3-chef MCP Server

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

## Problem Statement

The construct3-chef MCP server provides 22 tools for reading, searching, and mutating C3 project files. However, clients that cannot directly access the `extracted/` directory (e.g., remote MCP clients, sandboxed environments, or subagents without filesystem tools) currently lose functionality because:

1. **Search is limited to DSL files only.** The `search-dsl` tool searches `*.dsl.txt` files. To search extracted TypeScript, layout summaries, domain index pages, DSL index files, or raw C3 JSON, an agent must fall back to filesystem tools (Grep/Read). This breaks the abstraction boundary the MCP server is supposed to provide.

2. **Read tools return entire files.** Large DSL files, layout summaries, and extracted TypeScript files can be hundreds or thousands of lines. There is no way to request a specific line range, forcing agents to consume full file contents even when they need only a small section. This wastes context window budget.

3. **DSL anchor resolution requires manual scanning.** Agents frequently need to convert between DSL line numbers (from search results), SIDs (for recipe targeting), function/group names (human-readable), and JSON paths (for raw file access). Currently this requires reading `read-dsl-index` output and manually scanning — a recurring tax on every planning session that produces recipes.

4. **`read-sid-registry` was missing** but has been implemented (Session 13). This component is complete.

The goal is that a client with access only to MCP tools (no filesystem) loses no read/search functionality compared to a client with direct `extracted/` access.

## Current State

### Server Architecture

- **File:** `bin/mcp/server.ts` (22 registered tools)
- **Root resolution:** `PROJECT_ROOT = process.cwd()`, `EXTRACTED_DIR = PROJECT_ROOT/extracted`
- **Read pattern:** `readExtracted(relPath)` resolves against `EXTRACTED_DIR`, checks path traversal, reads file as UTF-8
- **Concurrency:** All read tools wrapped in `rwlock.read()`, write tools in `rwlock.write()`
- **Staleness:** `appendStaleWarning(text)` appends a warning if `extractedDirty` flag is set

### Existing Read Tools (7 tools)

| Tool | Input | Reads | Pagination |
|------|-------|-------|------------|
| `read-dsl` | `sheet: string` | `extracted/eventSheets/{sheet}.dsl.txt` | None |
| `read-dsl-index` | `sheet: string, grep?: string` | `extracted/eventSheets/{sheet}.dsl.idx.txt` | grep filter only |
| `read-scripts` | `sheet: string` | `extracted/eventSheets/{sheet}.ts` | None |
| `read-layout` | `layout: string` | `extracted/layouts/{layout}.layout.txt` | None |
| `read-template-scope` | (none) | `extracted/template-scope.txt` | None |
| `read-sid-registry` | (none) | `extracted/sid-registry.txt` | None |
| `read-domain-index` | `domain?: string` | `extracted/domain-index/{domain}.md` or `index.md` | None |

None of these tools support `offset`/`limit` parameters.

### Existing Search Tool (1 tool)

**`search-dsl`** parameters:
- `pattern: string` -- regex pattern (required)
- `glob?: string` -- directory path relative to `extracted/` to restrict search scope

Implementation details:
- Searches only `*.dsl.txt` files via recursive directory walk
- Path traversal check on glob parameter (must stay within `extracted/`)
- ReDoS mitigation: pattern length capped at 500 chars
- Output format: `{relPath}:{lineNum}: {lineContent}` (grep-style)
- Truncation: max 1000 matches, with truncation notice
- No context lines around matches

### Extracted Directory Structure (542 files)

| Pattern | Count | Location |
|---------|-------|----------|
| `*.dsl.txt` | 166 | `extracted/eventSheets/` |
| `*.dsl.idx.txt` | 166 | `extracted/eventSheets/` |
| `*.ts` | 116 | `extracted/eventSheets/` |
| `*.layout.txt` | 68 | `extracted/layouts/` |
| `*.md` | 22 | `extracted/domain-index/` |
| `*.txt` (other) | 3 | `extracted/` root (`template-scope.txt`, `sid-registry.txt`, `containers.txt`) |

### Raw C3 JSON (not in extracted/)

| Directory | Count | Max file size |
|-----------|-------|---------------|
| `eventSheets/*.json` | 332 | ~8,200 lines |
| `layouts/*.json` | 136 | ~64,800 lines |

### References to `search-dsl` in Codebase

The tool name `search-dsl` is referenced in 3 agent config files:
- `.claude/agents/c3-explorer/c3-explorer.md`
- `.claude/agents/c3-implementer/c3-implementer.md`
- `.claude/agents/analyst/analyst.md`

Also referenced in `docs/design-patterns.md` and `docs/lessons-learned.md`.

### Known Limitation (from lessons-learned)

> `search-dsl` glob is a directory prefix, not a file filter: `glob: "eventSheets/Main Menu/StoryBattleEvents"` searches the whole `Main Menu/` directory. To search a single file, use `Grep` on the `.dsl.txt` file directly

This is a known gap that falls back to filesystem access -- exactly the problem Filesystem Independence aims to eliminate.

## Requirements

### R1. Unified Search Tool (`search`)

Rename `search-dsl` to `search`. No backward compatibility alias needed (we are the only user).

1. The tool must search across all extracted file types and raw C3 JSON, not just DSL files.
2. The tool must accept a `type` parameter that selects which file category to search:
   - `dsl` (default) -- `*.dsl.txt` in `extracted/eventSheets/`
   - `ts` -- `*.ts` in `extracted/eventSheets/`
   - `layout` -- `*.layout.txt` in `extracted/layouts/`
   - `md` -- `*.md` in `extracted/domain-index/`
   - `json` -- `*.json` in `eventSheets/` and `layouts/` (raw C3 source, NOT extracted)
   - `idx` -- `*.dsl.idx.txt` in `extracted/eventSheets/`
3. The tool must accept a `pattern` parameter (regex, same as current `search-dsl`).
4. The tool must accept an optional `path` parameter that targets a single file (e.g., `Main Menu/CommonBattleEvents`) or a subdirectory prefix. When a path matches a single file exactly, only that file is searched.
5. The tool must accept an optional `context` parameter (integer) for context lines around matches. Follow `grep -C` behavior: merge overlapping context windows, use `--` separator between non-adjacent groups.
6. The tool must preserve existing safety checks: path traversal prevention, pattern length cap, match count truncation.
7. Output format: `{relPath}:{lineNum}: {lineContent}` (grep-style, same as current).
8. When `type` is `json`, the `path` parameter must include the directory prefix (`eventSheets/` or `layouts/`) for disambiguation. The search base is `PROJECT_ROOT`.
9. Stale warning appended for extracted file types but NOT for `json` type (raw source files are always current).

### R2. Read Tool Pagination

10. All read tools must accept optional `offset` and `limit` parameters (1-based line numbers):
    - `read-dsl`
    - `read-dsl-index`
    - `read-scripts`
    - `read-layout`
    - `read-domain-index`
    - `read-template-scope`
    - `read-sid-registry`
11. When `offset` is provided, output starts from that line number (1-based).
12. When `limit` is provided, output includes at most that many lines.
13. When neither is provided, behavior is identical to today (return full file).
14. The total line count of the file must be included in the response, following MCP tool response conventions (structured metadata via multi-block content).

### R3. DSL Anchor Resolution

DSL output contains multiple anchor systems that agents need to convert between: DSL line numbers (from search results or prior analysis), SIDs (for recipe targeting), function/group names (human-readable), and JSON paths (for raw file access). Currently these conversions require manually reading `read-dsl-index` output and scanning — a recurring tax on every planning session.

15. The server must provide tools to resolve between DSL anchor types:
    - **Line → anchor:** given a sheet and DSL line number, return the SID, JSON path, and human-readable description at or nearest that line. Primary use: converting search results to recipe targets.
    - **SID → anchor:** given a sheet and SID, return the current DSL line number, JSON path, and description. Primary use: verifying a recipe target's location after other changes may have shifted lines.
    - **Name → anchor:** given a sheet and a function/group/variable name, return its SID, line number, and JSON path. Primary use: targeting named elements without index lookup.
16. All anchor data already exists in `.dsl.idx.txt` files — these tools are a lookup interface, not new indexing.
17. Results should include enough context (the description column from the index) to confirm the match without requiring a separate `read-dsl` call.
18. When a line number falls between indexed entries (e.g., inside a block's actions), the tool should return the nearest enclosing entry (parent block/function).
19. Staleness warning must apply (anchors are from `extracted/` data).

### R4. Completed

20. `read-sid-registry` is already implemented (Session 13). No further work needed.

## Constraints

1. **Security model.** Path traversal prevention must be maintained. The `json` type introduces a new base directory (`PROJECT_ROOT` instead of `EXTRACTED_DIR`) -- the traversal check must be adapted accordingly.
2. **Performance.** Raw C3 JSON files can be very large (layout JSON up to 64K lines, 468 total JSON files). The `json` type requires a directory prefix (`eventSheets/` or `layouts/`) to avoid searching everything at once.
3. **Concurrency model.** All new/modified tools must respect the existing `rwlock` read/write locking pattern.
4. **Test infrastructure.** The server currently has no tool-level integration tests (only unit tests for `rwlock` and `expectedChanges`). Any testing strategy must account for this.

## Touch Points

### Must change

- `bin/mcp/server.ts` -- search tool rename + extension, read tool pagination, anchor resolution tools
- `.claude/agents/c3-explorer/c3-explorer.md` -- `search-dsl` → `search`
- `.claude/agents/c3-implementer/c3-implementer.md` -- `search-dsl` → `search`
- `.claude/agents/analyst/analyst.md` -- `search-dsl` → `search`
- `docs/design-patterns.md` -- `search-dsl` → `search`
- `docs/lessons-learned.md` -- `search-dsl` → `search`
- `initiatives/c3-mcp-server/initiative.md` -- update tool table and Filesystem Independence section

### May need updates

- `CLAUDE.md` -- if tool discovery guidance changes
- `docs/construct3-guide.md` -- if MCP tool usage patterns are documented there

## Scope Boundaries

### In scope

- Unified search tool (`search`) with file type filter, context lines, single-file targeting
- Read tool pagination (offset/limit) for all 7 read tools
- DSL anchor resolution tools (line↔SID↔name↔path bidirectional lookup)
- Rename `search-dsl` → `search` across all references

### Out of scope

- Adding write/mutation capabilities to any read tools
- Searching `scripts/` source TypeScript (as opposed to `extracted/` TypeScript)
- Full-text indexing or caching
- Streaming/chunked responses
- New generators or extracted file types

## Resolved Questions

1. **Tool naming:** Rename to `search`. No backward compatibility alias needed.
2. **Single-file targeting:** `path` accepts a single file path (less confusing, easy to handle).
3. **Context lines:** Follow `grep -C` behavior (merge overlapping windows, `--` separator).
4. **JSON type disambiguation:** `path` must include directory prefix (`eventSheets/` or `layouts/`).
5. **Pagination scope:** All 7 read tools get pagination, for consistency.
6. **Line count metadata:** Follow MCP tool response conventions (multi-block content).

## Recommended Phasing

All three phases address direct client needs (agents falling back to filesystem tools). They are independent and can be done in any order.

### Phase 1: Unified Search Tool

- Rename `search-dsl` → `search`, add `type` parameter
- Add `context` parameter with grep-style behavior
- Add single-file targeting via `path` parameter
- Handle `json` type with mandatory directory prefix
- Update all agent configs and docs
- Estimated scope: 1 session

### Phase 2: DSL Anchor Resolution

- Implement anchor lookup tools (line→anchor, SID→anchor, name→anchor)
- Data source: existing `.dsl.idx.txt` files
- Eliminates the most common manual step in the analysis → recipe pipeline
- Estimated scope: 0.5–1 session

### Phase 3: Read Tool Pagination

- Add `offset`/`limit` to all 7 read tools
- Add total line count to response (MCP multi-block convention)
- Estimated scope: 0.5 session (could combine with another phase)
