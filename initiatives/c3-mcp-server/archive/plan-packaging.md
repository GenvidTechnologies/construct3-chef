# Plan: Package Extraction (construct3-chef, c3source, genvid-mcp-utils)

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch

`BUR-0000-c3-mcp-server` (current branch — domain-manager extraction already done)

## Dependencies

None. Builds on the already-committed domain-manager extraction (latest commit:
`54dcd20e9 docs - BUR-0000: [WIP] Add domain-manager to architecture docs`).

## Summary

Extract construct3-chef and its dependencies from `bin/` into three local packages under
`packages/` using pnpm workspaces with a tsc build step. Six sequential commits, each
independently verifiable. All work is TypeScript/config — no C3 event sheets or layouts
are touched.

---

## Tasks

### Phase 0: pnpm Migration

**Task 1 — Migrate from npm to pnpm** — ts-implementer

This is the riskiest task. pnpm's strict isolation may surface undeclared transitive deps
that npm was hoisting silently. Full validation after `pnpm install` is mandatory before
anything else.

Steps:
1. Run `pnpm import` to convert `package-lock.json` → `pnpm-lock.yaml`
2. Delete `node_modules/` and `package-lock.json`
3. Create root `.npmrc` with:
   ```ini
   shamefully-hoist=false
   strict-peer-dependencies=true
   ```
4. Run `pnpm install`
5. Update root `package.json` scripts: replace every `npx tsx` with `pnpm exec tsx`, every
   `npm run` with `pnpm run`
6. Update `.mcp.json`: replace `"command": "npx"` entries with `"command": "pnpm"` and add
   `"exec"` as the first arg before `tsx` (keep `playwright` entry unchanged — it uses a
   separate npx invocation that pnpm shouldn't own)
7. Update `bin/tsconfig.json`: change `"module": "CommonJS"` → `"module": "NodeNext"` and
   `"moduleResolution": "node"` → `"moduleResolution": "NodeNext"` to align with package
   tsconfig strategy (this is prep, not strictly required, but avoids a later edit to this
   file)
8. Run full validation to confirm nothing broke

**Files created/modified:**
- `pnpm-lock.yaml` (created)
- `.npmrc` (created)
- `package-lock.json` (deleted)
- `package.json` — update scripts (all `npx tsx` → `pnpm exec tsx`, `npm run` → `pnpm run`,
  `generate-all` uses `&&` not `&& pnpm run`)
- `.mcp.json` — update construct3-chef and domain-manager entries

**Verification:**
```bash
pnpm run lint && pnpm run test && pnpm run typecheck
```
All three must pass before proceeding. If pnpm strict isolation fails, add missing explicit
deps to root `package.json` until they pass.

**Commit:** `config - BUR-0000: Migrate from npm to pnpm workspaces`

---

### Phase 1: Package Scaffolding

**Task 2 — Create packages/ directory structure and workspace config** — ts-implementer

Pure additions — no source files moved, no imports changed. Zero behavioral change.

Steps:
1. Create `pnpm-workspace.yaml` at root
2. Create `packages/tsconfig.json` (references all three packages)
3. Create `packages/genvid-mcp-utils/` with:
   - `package.json` (name, version, private, type:module, exports → `./src/index.ts`,
     scripts: build/test/lint/typecheck, devDependencies)
   - `tsconfig.json` (NodeNext, composite, outDir:dist, rootDir:src, include:src)
   - `tsconfig.test.json` (extends tsconfig, noEmit, composite:false, rootDir:., include src+test)
   - `.eslintrc.cjs` (root:true, parser @typescript-eslint/parser)
   - `src/` (empty placeholder — `index.ts` added in Task 4)
   - `test/` (empty placeholder — `setup.ts` added in Task 4)
4. Create `packages/c3source/` with same set of config files
5. Create `packages/construct3-chef/` with same set plus:
   - `package.json` also has `dependencies` (genvid-mcp-utils:workspace:\*, c3source:workspace:\*,
     @modelcontextprotocol/sdk, yargs, zod), and `bin` entry pointing to `./dist/cli.js`
   - `tsconfig.json` includes `references` to genvid-mcp-utils and c3source
6. Add `packages/*/dist/` to root `.gitignore`
7. Update root `.eslintrc.cjs` to add `packages/` to `ignorePatterns`
8. Run `pnpm install` to link workspace packages
9. Run `pnpm run build` (tsc --build packages/) — should succeed trivially since src/ is
   nearly empty (or fail cleanly if index.ts stubs are missing — acceptable at this stage)

**Files created:**
- `pnpm-workspace.yaml`
- `packages/tsconfig.json`
- `packages/genvid-mcp-utils/package.json`
- `packages/genvid-mcp-utils/tsconfig.json`
- `packages/genvid-mcp-utils/tsconfig.test.json`
- `packages/genvid-mcp-utils/.eslintrc.cjs`
- `packages/c3source/package.json`
- `packages/c3source/tsconfig.json`
- `packages/c3source/tsconfig.test.json`
- `packages/c3source/.eslintrc.cjs`
- `packages/construct3-chef/package.json`
- `packages/construct3-chef/tsconfig.json`
- `packages/construct3-chef/tsconfig.test.json`
- `packages/construct3-chef/.eslintrc.cjs`

**Files modified:**
- `.gitignore` — add `packages/*/dist/`
- `.eslintrc.cjs` — add `packages/` to `ignorePatterns`
- `pnpm-lock.yaml` — updated by `pnpm install`

**Verification:**
```bash
pnpm install
# confirm packages/ symlinks exist in node_modules/
ls node_modules/genvid-mcp-utils node_modules/c3source node_modules/construct3-chef
pnpm run lint
```

**Commit:** `config - BUR-0000: Scaffold packages/ directory structure and workspace config`

---

### Phase 2: Extract genvid-mcp-utils

**Task 3 — Move genvid-mcp-utils source and tests** — ts-implementer

Moves three source files and three test files into the package. Updates all internal imports.
Creates barrel and test setup. The package must pass its own build/test/typecheck before
moving on.

Steps:
1. Create `packages/genvid-mcp-utils/src/types.ts` containing the `Logger` type extracted
   from `bin/c3/types.ts` (copy the Logger interface — `ApplyOptions` stays in bin/c3/types.ts
   for now, to be moved with construct3-chef in Task 5)
2. `git mv bin/mcp/rwlock.ts packages/genvid-mcp-utils/src/rwlock.ts`
3. `git mv bin/mcp/expectedChanges.ts packages/genvid-mcp-utils/src/expectedChanges.ts`
4. `git mv bin/c3/pagination.ts packages/genvid-mcp-utils/src/pagination.ts`
5. Create `packages/genvid-mcp-utils/src/index.ts` — barrel re-exporting:
   `ReadWriteLock`, `ExpectedChanges`, `paginateText`, `PaginationOptions`, `PaginatedResult`,
   `Logger`
6. Create `packages/genvid-mcp-utils/test/setup.ts` (copy from root `test/setup.ts`)
7. `git mv test/mcp/rwlock.test.ts packages/genvid-mcp-utils/test/rwlock.test.ts`
8. `git mv test/mcp/expectedChanges.test.ts packages/genvid-mcp-utils/test/expectedChanges.test.ts`
9. `git mv test/mcp/pagination.test.ts packages/genvid-mcp-utils/test/pagination.test.ts`
10. Update imports in moved test files: `../../bin/mcp/rwlock` → `../src/rwlock` (or import
    from package `genvid-mcp-utils`), similar for expectedChanges and pagination
11. Update `bin/mcp/server.ts`: `from "./rwlock"` → `from "genvid-mcp-utils"`,
    `from "./expectedChanges"` → `from "genvid-mcp-utils"`,
    `from "../c3/pagination"` → `from "genvid-mcp-utils"`
12. Update `bin/mcp/server.ts`: Logger import from `"../c3/types"` → `from "genvid-mcp-utils"`
    (if applicable — check if Logger is imported there)
13. Update `bin/domain/server.ts`: `from "../mcp/rwlock"` → `from "genvid-mcp-utils"`,
    `from "../mcp/expectedChanges"` → `from "genvid-mcp-utils"`,
    `from "../c3/pagination"` → `from "genvid-mcp-utils"`
14. Remove `Logger` from `bin/c3/types.ts` (it moves to genvid-mcp-utils/src/types.ts) —
    update any remaining imports of Logger in bin/c3/ to import from `"genvid-mcp-utils"`

**Files created:**
- `packages/genvid-mcp-utils/src/types.ts`
- `packages/genvid-mcp-utils/src/index.ts`
- `packages/genvid-mcp-utils/test/setup.ts`

**Files moved (git mv):**
- `bin/mcp/rwlock.ts` → `packages/genvid-mcp-utils/src/rwlock.ts`
- `bin/mcp/expectedChanges.ts` → `packages/genvid-mcp-utils/src/expectedChanges.ts`
- `bin/c3/pagination.ts` → `packages/genvid-mcp-utils/src/pagination.ts`
- `test/mcp/rwlock.test.ts` → `packages/genvid-mcp-utils/test/rwlock.test.ts`
- `test/mcp/expectedChanges.test.ts` → `packages/genvid-mcp-utils/test/expectedChanges.test.ts`
- `test/mcp/pagination.test.ts` → `packages/genvid-mcp-utils/test/pagination.test.ts`

**Files modified:**
- `bin/c3/types.ts` — remove Logger type
- `bin/mcp/server.ts` — update imports
- `bin/domain/server.ts` — update imports
- Any other files in bin/c3/ or bin/domain/ importing Logger or pagination from old paths

**Verification:**
```bash
pnpm --filter genvid-mcp-utils run build
pnpm --filter genvid-mcp-utils run test
pnpm --filter genvid-mcp-utils run typecheck
pnpm run typecheck:bin   # confirms root bin/ imports are updated
```

**Commit:** `refactor - BUR-0000: Extract genvid-mcp-utils package (rwlock, expectedChanges, pagination)`

---

### Phase 3: Extract c3source

**Task 4 — Move c3source source and tests** — ts-implementer

Moves one source file and one test file. Creates barrel and test setup.

Steps:
1. `git mv bin/c3/c3source.ts packages/c3source/src/c3source.ts`
2. Create `packages/c3source/src/index.ts` — barrel re-exporting all types and functions
   from c3source.ts (see full list in requirements-packaging.md § c3source exports)
3. Create `packages/c3source/test/setup.ts` (copy from root `test/setup.ts`)
4. `git mv test/bin/extractEventSheetScripts.test.ts packages/c3source/test/extractEventSheetScripts.test.ts`
5. Update imports in `packages/c3source/test/extractEventSheetScripts.test.ts`:
   `../../bin/c3/c3source` → `../src/c3source`
6. Update all `bin/c3/` files that import from `./c3source` → `from "c3source"`:
   - `dslFormatter.ts`, `eventSheetMutator.ts`, `generators.ts`, `includeTree.ts`,
     `instVarMutator.ts` (via sidUtils), `layoutFormatter.ts`, `layoutScaffold.ts`,
     `navigationGraph.ts`, `previewDiff.ts`, `recipeApplier.ts`, `recipeInterpreter.ts`,
     `search.ts`, `sidUtils.ts`, `spriteScaffold.ts`, `templateLister.ts`
   Note: these still live in bin/c3/ for now — they move in Task 5. The import update
   prepares them for the move.
7. Update root files that import from `./c3/c3source`:
   - `bin/checkObstacles.ts` → `from "c3source"`
   - `bin/checkOverridenLayers.ts` → `from "c3source"`
   - `bin/dropshadow.ts` → `from "c3source"`
   - `bin/loc.ts` → `from "c3source"`
   - `bin/domain/domainGenerator.ts` → `from "c3source"`

**Files created:**
- `packages/c3source/src/index.ts`
- `packages/c3source/test/setup.ts`

**Files moved (git mv):**
- `bin/c3/c3source.ts` → `packages/c3source/src/c3source.ts`
- `test/bin/extractEventSheetScripts.test.ts` → `packages/c3source/test/extractEventSheetScripts.test.ts`

**Files modified:**
- All remaining `bin/c3/*.ts` files that import from `./c3source`
- `bin/checkObstacles.ts`, `bin/checkOverridenLayers.ts`, `bin/dropshadow.ts`, `bin/loc.ts`
- `bin/domain/domainGenerator.ts`
- `packages/c3source/test/extractEventSheetScripts.test.ts` (import path fix)

**Verification:**
```bash
pnpm --filter c3source run build
pnpm --filter c3source run test
pnpm --filter c3source run typecheck
pnpm run typecheck:bin   # confirms root bin/ imports are still resolved
```

**Commit:** `refactor - BUR-0000: Extract c3source package`

---

### Phase 4: Extract construct3-chef

**Task 5 — Move construct3-chef source and tests** — ts-implementer

The largest move: 19 files from bin/c3/, 1 from bin/mcp/, the CLI, 15 test files, 2
previously-in-mcp test files, 1 root test file, and 2 fixture directories. All imports
within construct3-chef that previously used `./c3source` were already updated in Task 4;
remaining internal relative imports stay relative.

Steps:
1. Create directory structure:
   `packages/construct3-chef/src/c3/`
   `packages/construct3-chef/src/mcp/`
   `packages/construct3-chef/test/c3/`
   `packages/construct3-chef/test/mcp/`
   `packages/construct3-chef/test/fixtures/`
2. `git mv` the 19 bin/c3/ files (except c3source.ts, already moved; except pagination.ts,
   already moved) to `packages/construct3-chef/src/c3/`:
   `anchorResolver.ts`, `dslFormatter.ts`, `eventSheetMutator.ts`, `fsUtils.ts`,
   `generators.ts`, `includeTree.ts`, `instVarMutator.ts`, `layoutFormatter.ts`,
   `layoutMutator.ts`, `layoutScaffold.ts`, `navigationGraph.ts`, `previewDiff.ts`,
   `projectSync.ts`, `recipeApplier.ts`, `recipeInterpreter.ts`, `search.ts`, `sidUtils.ts`,
   `spriteScaffold.ts`, `templateLister.ts`, `types.ts`
3. `git mv bin/mcp/server.ts packages/construct3-chef/src/mcp/server.ts`
4. `git mv bin/construct3-chef.ts packages/construct3-chef/src/cli.ts`
5. Update internal imports in moved files:
   - All `from "./types"` → check they resolve within src/c3/ (no change needed if both
     files land in src/c3/)
   - `from "../c3/types"` in server.ts (ApplyOptions) → `from "./c3/types"` or relative
     equivalent from src/mcp/
   - `from "../mcp/rwlock"` etc. in server.ts already updated in Task 3 (already point to
     genvid-mcp-utils)
   - `from "./c3/*"` in cli.ts → `from "./c3/*"` (path relative from src/ should resolve
     to src/c3/ — verify depth)
   - Any remaining relative references to bin/c3/ siblings use `./sibling` which still
     resolves within src/c3/
6. Create `packages/construct3-chef/src/index.ts` (barrel — re-export public API)
7. Create `packages/construct3-chef/test/setup.ts` (copy from root `test/setup.ts`)
8. `git mv test/fixtures/anchor packages/construct3-chef/test/fixtures/anchor`
9. `git mv test/fixtures/search packages/construct3-chef/test/fixtures/search`
10. `git mv` the 15 test/c3/ files to `packages/construct3-chef/test/c3/`
    (all except domainAnalysis.test.ts, domainFormatter.test.ts, enemies.test.ts,
    heroskin.test.ts which stay in root)
11. `git mv test/mcp/anchorResolver.test.ts packages/construct3-chef/test/mcp/anchorResolver.test.ts`
12. `git mv test/mcp/search.test.ts packages/construct3-chef/test/mcp/search.test.ts`
13. `git mv test/syncC3Proj.test.ts packages/construct3-chef/test/syncC3Proj.test.ts`
14. Update imports in moved test files:
    - `../../bin/c3/foo` → `../src/c3/foo`
    - `../../bin/mcp/server` → `../src/mcp/server`
    - `../bin/construct3-chef` → `../src/cli`
    - Fixture path references: `path.resolve(__dirname, "../../test/fixtures/anchor")` →
      `path.resolve(__dirname, "../fixtures/anchor")` — verify depth in each file
15. Fix generators.test.ts integration test guard:
    - Lines that reference `projectRoot` with `existsSync("eventSheets/")` → wrap in
      `describe.skip` when directory absent (per design: guard with existsSync check for
      `eventSheets/` directory)
16. Fix syncC3Proj.test.ts: uses `tmp` package — confirm `tmp` is listed in construct3-chef
    devDependencies (it is in the package.json designed above)
17. Remove `ApplyOptions` from `bin/c3/types.ts` (it moves to
    `packages/construct3-chef/src/c3/types.ts`) — but verify nothing in root bin/ still
    imports ApplyOptions before removing it

**Files created:**
- `packages/construct3-chef/src/index.ts`
- `packages/construct3-chef/test/setup.ts`

**Files moved (git mv) — source:**
- 19 files: `bin/c3/{anchorResolver,dslFormatter,eventSheetMutator,fsUtils,generators,
  includeTree,instVarMutator,layoutFormatter,layoutMutator,layoutScaffold,navigationGraph,
  previewDiff,projectSync,recipeApplier,recipeInterpreter,search,sidUtils,spriteScaffold,
  templateLister,types}.ts` → `packages/construct3-chef/src/c3/`
- `bin/mcp/server.ts` → `packages/construct3-chef/src/mcp/server.ts`
- `bin/construct3-chef.ts` → `packages/construct3-chef/src/cli.ts`

**Files moved (git mv) — tests:**
- 15 files: `test/c3/{dslFormatter,recipeInterpreter,layoutMutator,eventSheetMutator,
  layoutFormatter,scaffoldLayout,scaffoldSprite,navigationGraph,generators,sidUtils,
  includeTree,instVarMutator,scopeTypes,previewDiff,listTemplates}.test.ts`
  → `packages/construct3-chef/test/c3/`
- `test/mcp/anchorResolver.test.ts`, `test/mcp/search.test.ts`
  → `packages/construct3-chef/test/mcp/`
- `test/syncC3Proj.test.ts` → `packages/construct3-chef/test/syncC3Proj.test.ts`

**Files moved (git mv) — fixtures:**
- `test/fixtures/anchor/` → `packages/construct3-chef/test/fixtures/anchor/`
- `test/fixtures/search/` → `packages/construct3-chef/test/fixtures/search/`

**Files modified:**
- `bin/c3/types.ts` — remove ApplyOptions (file becomes empty; delete it if so)
- All moved test files — import path corrections and fixture path corrections

**Verification:**
```bash
pnpm --filter construct3-chef run build
pnpm --filter construct3-chef run test
pnpm --filter construct3-chef run typecheck
pnpm run test   # root tests still pass (domainAnalysis, domainFormatter, enemies, heroskin)
```

**Commit:** `refactor - BUR-0000: Extract construct3-chef package (source, tests, fixtures)`

---

### Phase 5: Root Project Cleanup

**Task 6 — Update root project for extracted packages** — ts-implementer

The root project cleanup: update all scripts pointing to the old CLI path, update .mcp.json,
shrink bin/tsconfig.json, move SDK dep to construct3-chef, add build script.

Steps:
1. Update root `package.json`:
   - All scripts referencing `bin/construct3-chef.ts` → `packages/construct3-chef/src/cli.ts`
     (13 scripts: sync-c3proj, validate-c3proj, extract-scripts, generate-dsl,
     generate-layout-summaries, generate-c3, generate-sid-registry, list-templates,
     navigation-graph, scaffold-layout, scaffold-sprite, apply-recipe, rename-symbol)
   - Add `"build": "tsc --build packages/"` script
   - Update `"typecheck"` → `pnpm run typecheck:bin && pnpm run typecheck:scripts && pnpm run typecheck:extracted && pnpm --filter './packages/*' run typecheck`
   - Update `"test"` → `mocha ... 'test/**/*.test.ts' --exit && pnpm --filter './packages/*' run test`
   - Update `"lint"` → add `&& pnpm --filter './packages/*' run lint`
   - Move `@modelcontextprotocol/sdk` from root `dependencies` to
     `packages/construct3-chef/package.json` dependencies (add `zod` there too)
   - Remove `@modelcontextprotocol/sdk` from root `package.json` dependencies entirely
2. Update `.mcp.json`: update construct3-chef entry to use
   `packages/construct3-chef/src/cli.ts` path (domain-manager entry unchanged, already
   uses pnpm from Task 1)
3. Update `bin/tsconfig.json`:
   - Remove `c3/*.ts` from `include` (those files are gone)
   - Resulting include: `["*.ts", "utils/*.ts"]` (or delete `utils/*.ts` too if that
     directory is empty — verify)
4. Delete empty directories if applicable:
   - `bin/mcp/` (all files moved out in Tasks 3 and 5)
   - `bin/c3/` (all files moved out in Tasks 3, 4, and 5)
   - `test/mcp/` (all files moved in Tasks 3 and 5)
   - `test/bin/` (file moved in Task 4 — check if anything else is there first)
   - `test/fixtures/` (all fixtures moved in Task 5 — confirm nothing remains)
5. Run `pnpm install` to resync lock file (after moving @modelcontextprotocol/sdk dep)
6. Run full validation

**Files modified:**
- `package.json` — scripts, deps
- `.mcp.json` — CLI path for construct3-chef
- `bin/tsconfig.json` — remove c3/*.ts include
- `pnpm-lock.yaml` — updated by pnpm install

**Files deleted:**
- `bin/mcp/` directory (now empty)
- `bin/c3/` directory (now empty)
- `test/mcp/` directory (now empty)
- `test/bin/` directory (now empty, verify first)
- `test/fixtures/` directory (now empty, verify first)
- `bin/c3/types.ts` if empty after ApplyOptions removed in Task 5

**Verification:**
```bash
pnpm run build              # all packages compile
pnpm run test               # root + all packages
pnpm run typecheck          # root + all packages
pnpm run lint               # root + all packages
pnpm run generate-c3        # CLI works via new path
pnpm exec tsx packages/construct3-chef/src/cli.ts --help   # smoke test CLI
# Verify MCP server path works (check .mcp.json resolves):
pnpm exec tsx packages/construct3-chef/src/cli.ts server --help
```

**Commit:** `config - BUR-0000: Update root project scripts, deps, and tsconfig for extracted packages`

---

### Validation

**Task 7 — Full validation pass** — validator + code-reviewer

Run all validations in sequence and confirm the extraction is clean.

**Commands:**
```bash
# Build
pnpm run build

# Test — root then packages
pnpm run test

# Type check — root then packages
pnpm run typecheck

# Lint — root then packages
pnpm run lint

# No cross-boundary relative imports in packages/
grep -r "from.*\.\./\.\." packages/

# Confirm each package has its own tsconfig, package.json, eslintrc
ls packages/genvid-mcp-utils packages/c3source packages/construct3-chef

# Confirm workspace symlinks
ls node_modules/genvid-mcp-utils node_modules/c3source node_modules/construct3-chef

# Smoke test CLI via compiled bin (requires build to have run)
node packages/construct3-chef/dist/cli.js --help

# Confirm integration test guard (run from a directory without eventSheets/)
cd /tmp && pnpm --filter construct3-chef run test 2>&1 | grep -E "passing|pending|skip"
```

---

## Risks

| Risk | Mitigation |
|------|------------|
| pnpm strict isolation breaks existing root code | Task 1 runs full validation before any extraction; fix undeclared deps before continuing |
| pnpm symlinks on Windows require elevated permissions | Current env is Windows 11; run `pnpm install` as the first thing in Task 1 to confirm. If it fails, enable Developer Mode or use `shamefully-hoist=true` as a fallback |
| Test fixture paths break after move | Task 5 step 14 explicitly audits `__dirname` references; run per-package tests immediately after move |
| `generators.test.ts` integration tests fail when running in packages/ | Task 5 step 15 adds existsSync guard; verify the guard causes `describe.skip` correctly |
| `eventSheetMutator.ts` re-exports types from c3source — consumers may depend on old path | After Task 5, grep for `from.*eventSheetMutator` in all test files and verify type re-exports resolve via the new package path |
| `bin/c3/types.ts` still needed after Logger and ApplyOptions move out | Verify nothing else in root bin/ imports from `./c3/types` before deleting it in Task 5 |
| `tsc --build` build ordering issue | `packages/tsconfig.json` references file handles this; `construct3-chef/tsconfig.json` references both leaf packages |
| Stale `dist/` confuses tests | Tests run via tsx against source; `dist/` is only needed for the CLI bin entrypoint — stale dist only affects `node dist/cli.js` not `tsx src/cli.ts` |
| Root `test/**/*.test.ts` glob picks up package tests | After extraction, root test/ will only contain domain and Burbank-specific tests; package tests run via `pnpm --filter` — confirm the root mocha glob doesn't walk into packages/ |

## Session Estimate

Single session. The work is mechanical (file moves + import updates) but there are many
files. Recommended execution order matches task order above — do not parallelize phases.

If Task 1 (pnpm migration) surfaces undeclared dependency issues, budget extra time to
trace and fix them before proceeding. That is the only unknown that could make this a
multi-session effort.
