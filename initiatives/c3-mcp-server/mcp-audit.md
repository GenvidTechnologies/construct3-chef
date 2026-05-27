# MCP Server Audit Report

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

Date: 2026-03-09 (updated 2026-03-09 post-session-6)
Sources: Official MCP specification (2025-03-26, 2025-06-18), security best practices guide, server concepts docs

## What's Done Well

| Practice | Implementation |
|---|---|
| **Library/CLI separation** | Server is a thin adapter over `recipeApplier`, `generators`, `projectSync`, etc. |
| **Read/write lock** | Write-preferring `ReadWriteLock` prevents concurrent reads/writes and write starvation |
| **Path traversal protection** | Checked on `readExtracted`, `read-addon`, `scaffold-layout` (source + output), `scaffold-sprite`, `search-dsl` glob |
| **Optimistic concurrency** | `txId` returned from validate tools, checked on write tools — prevents stale applies |
| **Input validation** | Zod schemas on all tools with `.describe()` on every parameter |
| **Error handling** | Two-tier model: exceptions caught → `isError: true` with messages; protocol errors for bad input |
| **Tool naming** | Consistent `` namespace prefix, kebab-case, descriptive names |
| **Title + description** | Every tool has both `title` (UI label) and `description` (LLM guidance) |
| **Tool annotations** | All 20 tools declare `readOnlyHint`, `destructiveHint`, `idempotentHint` via READ_ONLY/REGENERATE/MUTATE constants |
| **Stale data warnings** | `appendStaleWarning` on read tools when `extractedDirty` is true |
| **Self-write suppression** | `ExpectedChanges` with TTL prevents double `txId` increments from own writes; `suppressWatcherDepth` counter for nested safety |
| **Stdio transport** | Correct choice for a local dev server — inherently secure, no network exposure |
| **Startup validation** | Warns on stderr if `project.c3proj` or `extracted/` missing |
| **Graceful shutdown** | SIGINT/SIGTERM handlers close transport cleanly |
| **ReDoS mitigation** | Pattern length cap (500 chars) + match count cap (1000) on `search-dsl` |

## Issues Found

Issues are assessed at two severity levels: current dev-only context, and future standalone package context (used by other projects, including non-dev users).

### 1. ~~Missing Tool Annotations~~ ✅ Fixed (Session 6)

All 20 tools now declare annotations via module-level constants: `READ_ONLY` (13 tools), `REGENERATE` (1 tool), `MUTATE` (4 tools), plus 2 new domain analysis tools with `READ_ONLY`.

### 2. ~~Path Traversal Gap in `search-dsl`~~ ✅ Fixed (Session 6)

Added `path.relative()` + `startsWith("..")` containment check on the `glob` parameter before it reaches `path.dirname()`. Same pattern as `read-addon` and `scaffold-layout`.

### 3. ~~ReDoS Risk in `search-dsl`~~ ✅ Fixed (Session 6)

Added `MAX_PATTERN_LENGTH = 500` cap and `MAX_MATCHES = 1000` cap with truncation message. Proportionate to the threat model (local stdio server). `re2` deferred — would add a native dependency for marginal benefit.

### 4. ~~No Progress Reporting~~ ✅ Fixed (Session 7)

Long-running tools (`regenerate`, `apply-recipe`, `scaffold-layout`) now emit `notifications/progress` when the client provides `_meta.progressToken`. Generator steps report progress as N/total with descriptive messages (e.g., "Generating DSL... 2/6"). Centralized via `sendProgress()` helper and `GENERATOR_STEPS` array.

### 5. ~~No Cancellation Support~~ ✅ Fixed (Session 7)

Long-running tools now check `extra.signal.aborted` between generator steps via `checkCancelled()`. If cancelled mid-regeneration, `extractedDirty` is set to `true` so the agent knows to re-run generation. `CancelledError` is caught and reported gracefully.

### 6. ~~No MCP Logging~~ ✅ Fixed (Session 7)

Server now declares the `logging` capability and emits `notifications/message` via `emitLog()` helper. Currently emits warning-level logs on external file changes detected by the watcher (most useful for debugging stale state).

### 7. ~~Responses Wrap Text in JSON.stringify~~ ✅ Fixed (Session 7)

Write tools now return separate content blocks: one text block for human-readable output, one for metadata (`txId: N`). `get-state` returns plain text (`txId: N\nextractedDirty: true/false`) instead of JSON.

### 8. No Pagination on List Tools (Low)

`list-event-sheets` and `list-layouts` return all entries in a single response. With ~100+ files this is manageable, but the spec recommends cursor-based pagination for list operations.

**Recommendation**: Low priority given the project size, but worth noting for future growth.

### 9. ~~No Graceful Shutdown~~ ✅ Fixed (Session 6)

Added `SIGINT`/`SIGTERM` handlers that call `server.close()` and `process.exit(0)`. Stderr diagnostic on shutdown.

### 10. ~~`suppressWatcher` Global Boolean~~ ✅ Fixed (Session 6)

Converted to `suppressWatcherDepth: number` counter with `++`/`--` in try/finally blocks.

### 11. ~~Hardcoded `process.cwd()` as Project Root~~ ✅ Fixed (Session 10)

`server.ts` now exports `startServer(projectDir?)` which sets `PROJECT_ROOT` and `EXTRACTED_DIR` from the parameter. The unified CLI's `server` subcommand forwards `--project-dir` via `resolveProjectDir(argv)`. Falls back to `process.cwd()` when run directly.

### 12. ~~No Project Validation at Startup~~ ✅ Fixed (Session 6)

Startup now checks `project.c3proj` and `extracted/` existence, logging warnings to stderr. Doesn't hard-fail (server may still be useful for `get-state` or future tools).

### 13. ~~Server Name `"c3"` Is Too Generic~~ ✅ Fixed (Session 6)

Renamed to `"construct3-chef"`. Tool prefix is now `mcp__construct3-chef__`. `.mcp.json` key updated to match.

### 14. No Configuration / Customization (N/A dev → Medium for package)

The server hardcodes several assumptions:
- `domain-config.json` location (`server.ts:469`)
- The `extracted/` output directory name
- All 18 tools are always registered

Other projects may not use domains, or may only want read tools. A configuration layer (e.g., a `mcp.config.json` or init options) would allow projects to customize behavior.

Note: Source directory names (`eventSheets`, `layouts`, `objectTypes`, etc.) are fixed by C3 itself, so hardcoding those is correct and would be the expected default.

### 15. ~~No `--version` / `--help` CLI Interface~~ ✅ Fixed (Unified CLI + Session 10)

`bin/construct3-chef.ts` provides a full yargs CLI with `--help`, 13 subcommands (including `server`), and a `--project-dir` global option. The `server` subcommand now forwards `--project-dir` to `startServer()` (see #11).

### 16. ~~Minimal stderr Diagnostics~~ ✅ Partially Fixed (Session 6)

Startup now logs `[construct3-chef] Starting server in <dir>` and warnings for missing files. Shutdown logs `[construct3-chef] Shutting down...`. Per-tool and watcher-event logging still not implemented (would benefit from MCP logging capability, see #6).

### 17. ~~No `extracted/` Auto-Generation~~ ✅ Fixed (Session 7)

Startup now auto-generates `extracted/` via `runGenerators()` when the directory is missing. Progress logged to stderr.

## Summary Table

| # | Issue | Dev-only | Package | Effort | Status |
|---|---|---|---|---|---|
| 11 | Hardcoded `process.cwd()` | N/A | **High** | Medium | ✅ Fixed |
| 12 | No project validation at startup | N/A | **High** | Low | ✅ Fixed |
| 2 | Path traversal in `search-dsl` | **High** | **Critical** | Low | ✅ Fixed |
| 1 | Missing tool annotations | Medium | **High** | Low | ✅ Fixed |
| 3 | ReDoS in `search-dsl` | Medium | **High** | Medium | ✅ Fixed |
| 4 | No progress reporting | Low-Med | **Medium** | Medium | ✅ Fixed |
| 13 | Generic server name `"c3"` | N/A | Medium | Trivial | ✅ Fixed |
| 14 | No configuration layer | N/A | Medium | High | Open |
| 15 | No CLI interface | N/A | Medium | Medium | ✅ Fixed |
| 5 | No cancellation support | Low-Med | Medium | Medium | ✅ Fixed |
| 16 | Minimal stderr diagnostics | N/A | Low-Med | Low | ✅ Partial |
| 17 | No `extracted/` auto-generation | N/A | Low-Med | Low | ✅ Fixed |
| 6 | No MCP logging | Low | Low | Low-Med | ✅ Fixed |
| 7 | JSON-wrapped text responses | Low | Low | Low | ✅ Fixed |
| 8 | No pagination on lists | Low | Low | Low | Open |
| 9 | No graceful shutdown | Low | Low-Med | Low | ✅ Fixed |
| 10 | `suppressWatcher` as boolean | Low | Low | Trivial | ✅ Fixed |

## Best Practices Reference (Sources)

- Official MCP spec (2025-03-26, 2025-06-18): Tool annotations, output schemas, progress/cancellation, content annotations
- MCP Security Best Practices: Input validation, path traversal, rate limiting, output sanitization
- MCP Server Concepts: Library/CLI separation, capability declaration, lifecycle management
- MCP Transport Spec: Stdio (no non-MCP stdout), HTTP (Origin validation, session management)
- MCP Inspector: Testing methodology for all tools with valid and invalid inputs
