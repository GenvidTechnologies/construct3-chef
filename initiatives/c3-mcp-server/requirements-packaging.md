# Analysis: Package Extraction (construct3-chef, c3source, genvid-mcp-utils)

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

## Problem Statement

All construct3-chef code lives under `bin/` intermixed with Burbank-specific scripts. There is no package boundary, no explicit dependency declaration, and no way for another C3 project to reuse the tooling. This extraction creates three local npm packages under `packages/` with clean dependency boundaries, as a stepping stone toward separate repositories.

## Current State

### Source files

**`bin/mcp/`** (3 files, 1,390 lines):
- `rwlock.ts` (82 lines) -- self-contained, no imports from siblings
- `expectedChanges.ts` (57 lines) -- self-contained, no imports from siblings
- `server.ts` (1,251 lines) -- imports from `./rwlock`, `./expectedChanges`, `../c3/*` (12 different modules), plus `@modelcontextprotocol/sdk`, `zod`

**`bin/c3/`** (22 files, 9,466 lines):
- `c3source.ts` (536 lines) -- self-contained, only `node:fs` and `node:path`
- `pagination.ts` (64 lines) -- self-contained, no imports at all
- `types.ts` (8 lines) -- self-contained, defines `Logger` and `ApplyOptions`
- Remaining 19 files (8,858 lines) -- internal dependency graph rooted at `c3source.ts`

**`bin/construct3-chef.ts`** (375 lines) -- CLI entry point, imports from `./c3/*` (7 modules), `yargs`

### Internal dependency graph (bin/c3/)

```
recipeApplier -> c3source, generators, instVarMutator, layoutMutator,
                 layoutScaffold, previewDiff, recipeInterpreter, sidUtils, types
recipeInterpreter -> c3source, eventSheetMutator, sidUtils
generators -> c3source, dslFormatter, fsUtils, layoutFormatter, types
dslFormatter -> c3source
eventSheetMutator -> c3source, sidUtils
layoutFormatter -> c3source
layoutScaffold -> c3source
navigationGraph -> c3source
templateLister -> c3source
includeTree -> c3source
previewDiff -> c3source
instVarMutator -> sidUtils
projectSync -> types
anchorResolver -- (no internal imports)
layoutMutator -- (no internal imports)
search -- (no internal imports)
fsUtils -- (no internal imports)
sidUtils -- (no internal imports)
```

All 19 remaining files import from `c3source` either directly or transitively. After extraction, these become cross-package imports from the `c3source` package.

### Test files

**`test/mcp/`** (5 files, 781 lines):
| Test file | Tests code in | Package destination |
| --- | --- | --- |
| `rwlock.test.ts` (187 lines) | `bin/mcp/rwlock.ts` | genvid-mcp-utils |
| `expectedChanges.test.ts` (76 lines) | `bin/mcp/expectedChanges.ts` | genvid-mcp-utils |
| `pagination.test.ts` (98 lines) | `bin/c3/pagination.ts` | genvid-mcp-utils |
| `anchorResolver.test.ts` (188 lines) | `bin/c3/anchorResolver.ts` | construct3-chef |
| `search.test.ts` (232 lines) | `bin/c3/search.ts` | construct3-chef |

**`test/c3/`** (19 files, 9,919 lines):
| Test file | Tests code in | Package destination |
| --- | --- | --- |
| `dslFormatter.test.ts` (1,591 lines) | `bin/c3/dslFormatter.ts` + types from `c3source` | construct3-chef |
| `recipeInterpreter.test.ts` (3,521 lines) | `bin/c3/recipeInterpreter.ts` | construct3-chef |
| `layoutMutator.test.ts` (1,492 lines) | `bin/c3/layoutMutator.ts` | construct3-chef |
| `eventSheetMutator.test.ts` (767 lines) | `bin/c3/eventSheetMutator.ts` | construct3-chef |
| `layoutFormatter.test.ts` (591 lines) | `bin/c3/layoutFormatter.ts` | construct3-chef |
| `scaffoldLayout.test.ts` (503 lines) | `bin/c3/layoutScaffold.ts` | construct3-chef |
| `scaffoldSprite.test.ts` (441 lines) | `bin/c3/spriteScaffold.ts` | construct3-chef |
| `navigationGraph.test.ts` (392 lines) | `bin/c3/navigationGraph.ts` | construct3-chef |
| `generators.test.ts` (283 lines) | `bin/c3/generators.ts` | construct3-chef (*) |
| `sidUtils.test.ts` (242 lines) | `bin/c3/sidUtils.ts` | construct3-chef |
| `includeTree.test.ts` (246 lines) | `bin/c3/includeTree.ts` | construct3-chef |
| `instVarMutator.test.ts` (192 lines) | `bin/c3/instVarMutator.ts` | construct3-chef |
| `scopeTypes.test.ts` (180 lines) | `bin/c3/generators.ts` | construct3-chef |
| `previewDiff.test.ts` (104 lines) | `bin/c3/previewDiff.ts` | construct3-chef |
| `listTemplates.test.ts` (145 lines) | `bin/c3/templateLister.ts` | construct3-chef |
| `domainAnalysis.test.ts` (279 lines) | `bin/domain/domainAnalysis.ts` | **stays in root** (domain-manager) |
| `domainFormatter.test.ts` (649 lines) | `bin/domain/domainFormatter.ts` | **stays in root** (domain-manager) |
| `enemies.test.ts` (57 lines) | Burbank project data | **stays in root** |
| `heroskin.test.ts` (20 lines) | Burbank project data | **stays in root** |

**`test/bin/`** (1 file):
| Test file | Tests code in | Package destination |
| --- | --- | --- |
| `extractEventSheetScripts.test.ts` | `bin/c3/c3source.ts` (extractScriptsFromSheet, generateFunctionName, formatCondition) | c3source |

**`test/syncC3Proj.test.ts`** -- tests `bin/c3/projectSync.ts`, destination: construct3-chef

(*) `generators.test.ts` has integration tests that run against the real Burbank project (lines 234, 272 reference `projectRoot`). These tests must either stay in the root or be split.

### Test fixtures

- `test/fixtures/anchor/sample.dsl.idx.txt` -- used by `anchorResolver.test.ts` (construct3-chef)
- `test/fixtures/search/` -- used by `search.test.ts` (construct3-chef)

### Test infrastructure

- `test/setup.ts` -- Mocha root hooks (silences console.log/debug). Simple enough to duplicate per-package or factor into a shared dev dependency.
- Mocha config is inline in `package.json` scripts: `mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit`
- Test deps: `chai`, `mocha`, `@types/mocha`, `@types/chai`, `tmp` (used by syncC3Proj.test.ts)

## Requirements

### Package: genvid-mcp-utils

1. Source files: `rwlock.ts`, `expectedChanges.ts`, `pagination.ts`
2. Test files: `rwlock.test.ts`, `expectedChanges.test.ts`, `pagination.test.ts`
3. No fixture files needed
4. Runtime dependencies: none (pure Node.js)
5. Dev dependencies: `mocha`, `chai`, `@types/mocha`, `@types/chai`, `tsx`, `typescript`
6. Exports: `ReadWriteLock`, `ExpectedChanges`, `paginateText`, `PaginationOptions`, `PaginatedResult`

### Package: c3source

1. Source files: `c3source.ts`
2. Test files: `test/bin/extractEventSheetScripts.test.ts`
3. No fixture files needed
4. Runtime dependencies: none (`node:fs`, `node:path` only)
5. Dev dependencies: `mocha`, `chai`, `@types/mocha`, `@types/chai`, `tsx`, `typescript`
6. Exports: all types (`Layout`, `Layer`, `Instance`, `Effect`, `ObjectType`, `EventSheet`, `EventSheetEvent`, `BlockEvent`, `FunctionBlockEvent`, `CustomAceBlockEvent`, `GroupEvent`, `IncludeEvent`, `CommentEvent`, `EventSheetVariable`, `ScriptAction`, `Condition`, `FunctionParameter`, `ScopeSegment`, `ExtractedScript`, `InstanceVisitor`, `LayerVisitor`) and functions (`find_all_layouts_path`, `find_all_objectTypes_path`, `find_all_eventsheets_path`, `visit_layers_in_layouts`, `visit_instances_in_layouts`, `get_all_global_layers`, `normalizeLineEndings`, `formatCondition`, `formatAction`, `extractScriptsFromSheet`, `generateFunctionName`)

### Package: construct3-chef

1. Source files: all remaining `bin/c3/` files (19 files), `bin/mcp/server.ts`, `bin/construct3-chef.ts`
2. Files moving to this package:

   **`src/c3/`** (from `bin/c3/`):
   - `anchorResolver.ts`
   - `dslFormatter.ts`
   - `eventSheetMutator.ts`
   - `fsUtils.ts`
   - `generators.ts`
   - `includeTree.ts`
   - `instVarMutator.ts`
   - `layoutFormatter.ts`
   - `layoutMutator.ts`
   - `layoutScaffold.ts`
   - `navigationGraph.ts`
   - `previewDiff.ts`
   - `projectSync.ts`
   - `recipeApplier.ts`
   - `recipeInterpreter.ts`
   - `search.ts`
   - `sidUtils.ts`
   - `spriteScaffold.ts`
   - `templateLister.ts`
   - `types.ts`

   **`src/mcp/`** (from `bin/mcp/`):
   - `server.ts`

   **`src/`** (from `bin/`):
   - `cli.ts` (renamed from `construct3-chef.ts`)

3. Test files (15 from `test/c3/`, 2 from `test/mcp/`, 1 from `test/`):
   - All test/c3/ files except `domainAnalysis.test.ts`, `domainFormatter.test.ts`, `enemies.test.ts`, `heroskin.test.ts`
   - `test/mcp/anchorResolver.test.ts`, `test/mcp/search.test.ts`
   - `test/syncC3Proj.test.ts`

4. Test fixtures: `test/fixtures/anchor/`, `test/fixtures/search/`

5. Runtime dependencies: `@modelcontextprotocol/sdk`, `yargs`, `zod`, `genvid-mcp-utils` (local), `c3source` (local)
6. Dev dependencies: `mocha`, `chai`, `@types/mocha`, `@types/chai`, `@types/yargs`, `tsx`, `typescript`, `tmp`, `@types/tmp`

### Cross-boundary import updates

7. After extraction, these root-project files must update their imports:

   | File | Current import | New import |
   | --- | --- | --- |
   | `bin/checkObstacles.ts` | `./c3/c3source` | `c3source` |
   | `bin/checkOverridenLayers.ts` | `./c3/c3source` | `c3source` |
   | `bin/dropshadow.ts` | `./c3/c3source` | `c3source` |
   | `bin/loc.ts` | `./c3/c3source` | `c3source` |
   | `bin/domain/server.ts` | `../mcp/rwlock`, `../mcp/expectedChanges`, `../c3/pagination` | `genvid-mcp-utils` |
   | `bin/domain/domainGenerator.ts` | `../c3/c3source` | `c3source` (domainGenerator stays in root as integration script) |

### Root project integration

8. `package.json` must add workspace or `file:` references to all three packages
9. All existing npm scripts referencing `bin/construct3-chef.ts` must continue to work (13 scripts)
10. `.mcp.json` must be updated to launch the packaged server
11. `bin/tsconfig.json` currently includes `c3/*.ts` -- this path disappears; typecheck strategy must adapt
12. Root `npm run test` must continue to run all tests (both package tests and remaining root tests)

## Constraints

1. **Domain-manager is out of scope.** `bin/domain/` stays in the root project. It only needs import updates (requirement 7).
2. **No compile step required for local dev.** Packages must work with `tsx` (current model). A `tsc` build can be optional for distribution.
3. **Current branch has uncommitted changes** to `initiative.md`. Domain-manager extraction is complete on this branch. Packaging work builds on top.
4. **`bin/tsconfig.json` does not cover `mcp/` or `domain/` today.** Only `*.ts`, `c3/*.ts`, `utils/*.ts` are included. The `typecheck:bin` script only typechecks those paths. Moving `c3/*.ts` out will shrink this scope; packages need their own tsconfig.
5. **Node.js >= 22 required** (from `package.json` engines).
6. **No circular dependencies.** `c3source` and `genvid-mcp-utils` are independent leaves. `construct3-chef` depends on both. No package depends on construct3-chef.
7. **Git history preservation.** Use `git mv` where possible so renames are tracked.
8. **Cross-domain commit rule.** TS changes and C3 changes are separate commits. Since this is all TS/tooling, it can be a single logical change (no C3 eventSheet/layout files are modified).

## Touch Points

### Files that move
- `bin/c3/` -- 22 files (entire directory empties out)
- `bin/mcp/` -- 3 files (entire directory empties out)
- `bin/construct3-chef.ts` -- 1 file
- `test/c3/` -- 15 of 19 files move out
- `test/mcp/` -- 5 of 5 files move out (directory empties)
- `test/bin/extractEventSheetScripts.test.ts` -- 1 file
- `test/syncC3Proj.test.ts` -- 1 file
- `test/fixtures/anchor/` -- moves to construct3-chef
- `test/fixtures/search/` -- moves to construct3-chef

### Files that need import updates (stay in root)
- `bin/checkObstacles.ts`
- `bin/checkOverridenLayers.ts`
- `bin/dropshadow.ts`
- `bin/loc.ts`
- `bin/domain/server.ts`
- `bin/domain/domainGenerator.ts`

### Config files that need updates
- `package.json` -- add workspace/file deps, update scripts
- `.mcp.json` -- update server launch command
- `bin/tsconfig.json` -- remove `c3/*.ts` include (or delete if empty)
- New: `packages/genvid-mcp-utils/package.json`, `tsconfig.json`
- New: `packages/c3source/package.json`, `tsconfig.json`
- New: `packages/construct3-chef/package.json`, `tsconfig.json`

## Decisions (User Input)

1. **npm workspaces.** Enables cascading `npm test`, auto-symlinking, and maps cleanly to separate repos later (each workspace becomes its own repo with its own `package.json` already in place).

2. **CLI via `bin` entry.** Declare `bin` in construct3-chef's `package.json` so `npx construct3-chef` works. This is the standard npm pattern for CLI tools.

3. **Split integration tests or generate test data.** Integration tests that depend on Burbank project data should either be split out (staying in root) or converted to use generated/fixture data so they can move into the package.

4. **`Logger` moves to genvid-mcp-utils.** It's generic. `ApplyOptions` stays in construct3-chef (recipe-specific).

5. **Duplicate `test/setup.ts`.** Each package gets its own copy — it's 19 lines and keeps packages self-contained.

6. **Packages get their own ESLint config.** Packages must be independent of this repo's lint setup so they can be extracted to standalone repos.

7. **domain-manager renamed to ddd-utils.** The domain management package is called `ddd-utils`, not `domain-manager`.

8. **`domainGenerator.ts` stays in root.** It is NOT part of ddd-utils or c3source — it's a Burbank-specific integration script that consumes both `c3source` (for file listing) and `ddd-utils` (for classification/formatting). After extraction, its imports change to `from "c3source"` and `from "ddd-utils"`.

## Remaining Open Questions

1. **Should `c3source` eventually absorb `dslFormatter.ts`, `layoutFormatter.ts`, and other read-only formatting code?** Today these live in construct3-chef. They only format/read data and don't mutate anything. Future concern — not blocking this session.

2. **`eventSheetMutator.ts` re-exports types from `c3source`.** After extraction, this becomes a cross-package re-export (`from "c3source"`). Should be fine but worth verifying no consumer depends on the re-export path vs the original.
