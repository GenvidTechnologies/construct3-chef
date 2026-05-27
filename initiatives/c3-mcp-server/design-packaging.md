# Design: Package Extraction (construct3-chef, c3source, genvid-mcp-utils)

> _Imported from the monorepo where construct3-chef was first developed; see the [initiative repository note](initiative.md) for how `bin/c3/`→`src/c3/`, `bin/mcp/`→`src/mcp/`, shared utils → `genvid-mcp-utils`, and domain tooling → `domain-manager`. Reference/design record._

## Requirements Summary

Extract construct3-chef and its dependencies from `bin/` into three local packages under `packages/`, with clean dependency boundaries, independent test suites, and zero disruption to existing scripts. Full requirements in [initiative.md](initiative.md) and [requirements-packaging.md](requirements-packaging.md).

Key changes from the previous iteration:

- **pnpm** instead of npm workspaces (strict dependency isolation)
- **tsc build step** for each package (compiled output in `dist/`, declarations for consumers)

## Design

### Approach: pnpm Workspaces with tsc Build

#### pnpm Workspace Configuration

**`pnpm-workspace.yaml`** (root):
```yaml
packages:
  - "packages/*"
```

Root `package.json` drops the `"workspaces"` field entirely -- pnpm uses `pnpm-workspace.yaml` as the canonical source.

After `pnpm install`, pnpm creates symlinks in `node_modules/` for each workspace package, but unlike npm, it uses a strict dependency model: packages can only import dependencies they explicitly declare. Undeclared deps fail immediately, which validates our dependency boundaries without extra tooling.

#### Package Structure

```
packages/
  genvid-mcp-utils/
    package.json
    tsconfig.json
    .eslintrc.cjs
    src/
      index.ts              # barrel re-export
      rwlock.ts             # from bin/mcp/rwlock.ts
      expectedChanges.ts    # from bin/mcp/expectedChanges.ts
      pagination.ts         # from bin/c3/pagination.ts
      types.ts              # Logger type
    test/
      setup.ts
      rwlock.test.ts
      expectedChanges.test.ts
      pagination.test.ts
    dist/                   # gitignored, tsc output

  c3source/
    package.json
    tsconfig.json
    .eslintrc.cjs
    src/
      index.ts              # barrel re-export
      c3source.ts           # from bin/c3/c3source.ts
    test/
      setup.ts
      extractEventSheetScripts.test.ts
    dist/                   # gitignored

  construct3-chef/
    package.json
    tsconfig.json
    .eslintrc.cjs
    src/
      cli.ts                # from bin/construct3-chef.ts
      index.ts              # barrel re-export
      mcp/
        server.ts
      c3/
        (remaining 19 files from bin/c3/)
    test/
      setup.ts
      fixtures/
        anchor/
        search/
      c3/
        (15 test files)
      mcp/
        anchorResolver.test.ts
        search.test.ts
      syncC3Proj.test.ts
    dist/                   # gitignored
```

#### Package-level package.json

**genvid-mcp-utils/package.json:**

```json
{
  "name": "genvid-mcp-utils",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit",
    "lint": "eslint --ext .ts --max-warnings 0 src/ test/",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "devDependencies": {
    "mocha": "^10.4.0",
    "chai": "^5.1.1",
    "@types/mocha": "^10.0.6",
    "@types/chai": "^4.3.16",
    "tsx": "^4.21.0",
    "typescript": "^5.4.5",
    "eslint": "^8.36.0",
    "@typescript-eslint/eslint-plugin": "^7.10.0",
    "@typescript-eslint/parser": "^7.10.0",
    "eslint-config-prettier": "^8.7.0"
  }
}
```

**c3source/package.json:** Same structure as genvid-mcp-utils.

**construct3-chef/package.json:**

```json
{
  "name": "construct3-chef",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "construct3-chef": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./mcp": {
      "import": "./dist/mcp/server.js",
      "types": "./dist/mcp/server.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit",
    "lint": "eslint --ext .ts --max-warnings 0 src/ test/",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "dependencies": {
    "genvid-mcp-utils": "workspace:*",
    "c3source": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "yargs": "^17.7.2",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "mocha": "^10.4.0",
    "chai": "^5.1.1",
    "@types/mocha": "^10.0.6",
    "@types/chai": "^4.3.16",
    "@types/yargs": "^17.0.33",
    "@types/tmp": "^0.2.6",
    "tmp": "^0.2.3",
    "tsx": "^4.21.0",
    "typescript": "^5.4.5",
    "eslint": "^8.36.0",
    "@typescript-eslint/eslint-plugin": "^7.10.0",
    "@typescript-eslint/parser": "^7.10.0",
    "eslint-config-prettier": "^8.7.0"
  }
}
```

Note: pnpm uses `"workspace:*"` protocol for local package references. This is pnpm's equivalent of npm's `"*"` for workspace deps -- it ensures pnpm resolves to the local workspace version and makes the intent explicit. If these packages are ever published, pnpm automatically replaces `workspace:*` with the actual version during `pnpm publish`.

#### tsconfig Strategy

Each package gets a tsconfig that emits compiled output. TypeScript project references link them for correct build ordering.

**packages/genvid-mcp-utils/tsconfig.json:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*.ts"]
}
```

Key points:
- `outDir: "./dist"` -- compiled JS lands in `dist/`
- `rootDir: "./src"` -- preserves directory structure in output
- `declaration: true` -- generates `.d.ts` files so consumers get types
- `declarationMap: true` -- enables "go to definition" to jump to source `.ts`
- `composite: true` -- required for TypeScript project references
- `include` covers only `src/` (not `test/`) -- tests are not compiled

**packages/c3source/tsconfig.json:** Same as genvid-mcp-utils.

**packages/construct3-chef/tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../genvid-mcp-utils" },
    { "path": "../c3source" }
  ]
}
```

The `references` field tells `tsc --build` to compile dependencies first. When running `tsc --build packages/construct3-chef`, TypeScript builds genvid-mcp-utils and c3source first, then construct3-chef.

**Separate tsconfig for tests** (`packages/*/tsconfig.test.json`):

Tests need their own tsconfig since they are not compiled but still need type-checking. Each package gets:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "rootDir": ".",
    "outDir": null
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

The `typecheck` script uses this: `"typecheck": "tsc -p tsconfig.test.json --noEmit"`.

**Root `packages/tsconfig.json`** (optional, for convenience):
```json
{
  "files": [],
  "references": [
    { "path": "genvid-mcp-utils" },
    { "path": "c3source" },
    { "path": "construct3-chef" }
  ]
}
```

This enables `tsc --build packages/` to build all packages in dependency order with a single command.

#### bin Entry and CLI

The `bin` field in construct3-chef points to `./dist/cli.js` -- compiled JavaScript. The CLI shebang (`#!/usr/bin/env node`) is preserved during compilation.

Root scripts invoke the CLI in two ways:

**For production/CI (compiled):**
```json
"generate-c3": "pnpm run build --filter construct3-chef && node packages/construct3-chef/dist/cli.js generate"
```

**For development (tsx, no build needed):**
```json
"generate-c3": "pnpm exec tsx packages/construct3-chef/src/cli.ts generate"
```

**Recommended: tsx for root scripts.** The root project already depends on tsx, and the build step adds latency. Use tsx for all root `package.json` scripts. The compiled output is for when construct3-chef is consumed as a standalone package or via `npx construct3-chef`.

```json
"generate-c3": "pnpm exec tsx packages/construct3-chef/src/cli.ts generate"
```

#### .mcp.json Update

```json
{
  "mcpServers": {
    "construct3-chef": {
      "command": "pnpm",
      "args": ["exec", "tsx", "packages/construct3-chef/src/cli.ts", "server"]
    },
    "domain-manager": {
      "command": "pnpm",
      "args": ["exec", "tsx", "bin/domain-manager.ts", "server"]
    }
  }
}
```

`pnpm exec` replaces `npx` throughout. This is the pnpm equivalent and ensures the correct local binary is used.

#### Root package.json Changes

```json
{
  "scripts": {
    "build": "tsc --build packages/",
    "test": "mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit && pnpm --filter './packages/*' run test",
    "typecheck": "pnpm run typecheck:bin && pnpm run typecheck:scripts && pnpm run typecheck:extracted && pnpm --filter './packages/*' run typecheck",
    "lint": "eslint --ext .ts,.cjs,.json,.yml,.yaml --max-warnings 0 . && pnpm --filter './packages/*' run lint",
    "generate-c3": "pnpm exec tsx packages/construct3-chef/src/cli.ts generate",
    "apply-recipe": "pnpm exec tsx packages/construct3-chef/src/cli.ts apply-recipe",
    "sync-c3proj": "pnpm exec tsx packages/construct3-chef/src/cli.ts sync-project",
    "validate-c3proj": "pnpm exec tsx packages/construct3-chef/src/cli.ts validate-project",
    "generate-all": "pnpm run generate-c3 && pnpm run generate-domain"
  }
}
```

All 13 scripts referencing `bin/construct3-chef.ts` update to `packages/construct3-chef/src/cli.ts`, and `npx` becomes `pnpm exec`.

The new `"build"` script uses `tsc --build packages/` to compile all packages in dependency order via the root `packages/tsconfig.json` references file.

#### .gitignore Update

Add to root `.gitignore`:

```gitignore
packages/*/dist/
```

#### .npmrc Configuration

Create `.npmrc` in root:
```ini
shamefully-hoist=false
strict-peer-dependencies=true
```

`shamefully-hoist=false` is the default but worth being explicit -- it ensures pnpm's strict isolation catches undeclared dependencies. `strict-peer-dependencies=true` makes missing peer deps an error.

#### ESLint Per Package

Same as previous design -- each package gets `.eslintrc.cjs` with `root: true`. Root `.eslintrc.cjs` adds `packages/` to `ignorePatterns`.

#### Test Runner Configuration

Tests run against **source** via tsx, not compiled output:

```json
"test": "mocha --timeout 5000 --import=tsx --require ./test/setup.ts 'test/**/*.test.ts' --exit"
```

This is the same pattern used today. Tests import from `../src/foo.ts` using relative paths, which tsx resolves directly. No build step needed for testing.

Cross-package test imports (e.g., construct3-chef tests importing from c3source) resolve through pnpm workspace symlinks + tsx. The symlink points to the package root, and the `exports` field... but wait -- `exports` points to `dist/`. For tsx to work without building, tests need to import from source.

**Resolution:** Add a `"development"` condition to exports:

```json
{
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  }
}
```

Actually, this is overcomplicating it. tsx resolves `.ts` files regardless of `exports` by intercepting Node's module resolution. The `exports` field is for the compiled output consumed by Node.js directly. tsx sees `import { X } from "c3source"`, follows the symlink to `packages/c3source/`, and resolves through `exports` -- but tsx patches the resolution to prefer `.ts` source files.

**Simpler approach:** Use dual exports with TypeScript's `"types"` condition:

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Wait -- `"types"` is for type resolution, not runtime. With tsx, the runtime resolver needs to find the right file.

**Simplest correct approach:** Point exports to source, add a `publishConfig` override for distribution:

```json
{
  "exports": {
    ".": "./src/index.ts"
  },
  "publishConfig": {
    "exports": {
      ".": {
        "import": "./dist/index.js",
        "types": "./dist/index.d.ts"
      }
    }
  }
}
```

No -- these are `private: true` packages. We will never publish them. The only consumer of `dist/` is the `bin` entry point (for the CLI) and future standalone extraction. For now, keep it simple:

**Final approach: exports point to source. Build is for CLI bin only.**

```json
{
  "exports": {
    ".": "./src/index.ts"
  }
}
```

This works with tsx for both development and testing. The `tsc` build step produces `dist/` for:

1. The `bin` entry point (`dist/cli.js`) -- used when running `npx construct3-chef` without tsx
2. Future standalone distribution
3. CI validation that the code compiles cleanly

The root scripts use `pnpm exec tsx ...` so they go through source, not dist. Tests use tsx so they go through source. The build step is a **validation gate**, not a runtime requirement.

This means the tsconfig still needs `outDir`, `declaration`, `composite` -- but the package `exports` stays simple.

**Updated package.json exports (all three packages):**

```json
{
  "exports": {
    ".": "./src/index.ts"
  }
}
```

**construct3-chef additionally:**

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./mcp": "./src/mcp/server.ts"
  },
  "bin": {
    "construct3-chef": "./dist/cli.js"
  }
}
```

The `bin` field points to compiled output (must be JS for `#!/usr/bin/env node` to work without tsx). Everything else uses source.

#### Import Path Updates

Same as previous design. The key changes:

| Current import | New import |
| --- | --- |
| `../c3/c3source` or `./c3source` | `c3source` (package import) |
| `../c3/pagination` | `genvid-mcp-utils` (package import) |
| `../c3/types` (for `Logger`) | `genvid-mcp-utils` (package import) |
| `../mcp/rwlock` | `genvid-mcp-utils` (package import) |
| `../mcp/expectedChanges` | `genvid-mcp-utils` (package import) |

Root project files (`bin/checkObstacles.ts`, `bin/loc.ts`, etc.) update identically to the previous design.

#### Integration Test Split (generators.test.ts)

Same approach as previous design -- guard with `existsSync` check for `eventSheets/` directory, `describe.skip` when absent.

#### Logger Type Split

Same as previous design -- `Logger` to genvid-mcp-utils, `ApplyOptions` stays in construct3-chef.

### Alternatives Considered

**Alternative 1: npm workspaces (previous design).**

npm workspaces hoist dependencies by default, which can mask missing dependency declarations. A package might import a module it never declared because npm hoisted it from a sibling. This defeats the purpose of establishing clean dependency boundaries. pnpm's strict isolation catches these issues at install time.

Rejected because: the primary goal of extraction is enforcing dependency boundaries, and npm's hoisting model works against that goal.

**Alternative 2: exports pointing to `dist/` with a "dev" build watcher.**

Point `exports` to `dist/` and run `tsc --build --watch` during development so compiled output stays fresh.

Rejected because: adds workflow friction (must remember to start the watcher), stale `dist/` causes confusing bugs, and tsx already handles `.ts` resolution perfectly. The build step should be for validation, not a development prerequisite.

**Alternative 3: No build step (previous design's tsx-only approach).**

Skip tsc entirely. Use `noEmit: true` for type-checking only.

Rejected because: a build step validates that the code compiles to valid JavaScript (catches issues tsx silently papers over, like `import type` violations), produces declarations for consumers, and is required if construct3-chef is ever consumed outside this monorepo. The overhead is minimal since it runs in CI, not in the dev loop.

## Migration Order

### Phase 0: pnpm Migration

Before any package extraction, migrate the existing project from npm to pnpm:

1. Install pnpm globally: `npm install -g pnpm` (or use corepack: `corepack enable && corepack prepare pnpm@latest --activate`)
2. `pnpm import` -- converts `package-lock.json` to `pnpm-lock.yaml`
3. Delete `node_modules/` and `package-lock.json`
4. Create `.npmrc` with `shamefully-hoist=false` and `strict-peer-dependencies=true`
5. `pnpm install` -- installs with strict isolation
6. Update root `package.json` scripts: `npx` becomes `pnpm exec`, `npm run` becomes `pnpm run`
7. Update `.mcp.json`: `npx` becomes `pnpm exec` in all server commands
8. Run full validation: `pnpm run lint && pnpm run test && pnpm run typecheck`
9. Commit. This is a standalone change that must work before extraction begins.

**Risk:** Some root-level imports may break under strict isolation if they relied on hoisted transitive deps. Fix by adding explicit declarations to root `package.json`.

### Phase 1: genvid-mcp-utils (leaf package, no deps)

### Phase 2: c3source (leaf package, no deps)

### Phase 3: construct3-chef (depends on Phases 1 and 2)

### Phase 4: Root project cleanup

Phases 1 and 2 are independent. Sequential is safer for git history.

Each phase follows this internal sequence:

1. Create package directory structure and config files (`package.json`, `tsconfig.json`, `tsconfig.test.json`, `.eslintrc.cjs`)
2. `git mv` source files into `src/`
3. `git mv` test files and fixtures into `test/`
4. Create `src/index.ts` barrel and `test/setup.ts`
5. Update internal imports within moved files
6. `pnpm install` (updates workspace symlinks)
7. Run package-level: `pnpm --filter <pkg> run build && pnpm --filter <pkg> run test && pnpm --filter <pkg> run typecheck`
8. Update cross-boundary imports in files that remain in root
9. Run root-level tests to verify nothing broke

Phase 4 additionally:
- Create `pnpm-workspace.yaml` (if not done in Phase 1)
- Create `packages/tsconfig.json` (references file)
- Add `"build"` script to root `package.json`
- Update `bin/tsconfig.json` to remove `c3/*.ts`
- Update `.gitignore` for `packages/*/dist/`
- Move `@modelcontextprotocol/sdk` from root deps to construct3-chef deps
- Add `zod` to construct3-chef deps

## Consumer Workflow

### Developer running tests after extraction

1. `pnpm install` -- links workspace packages via symlinks (strict isolation)
2. `pnpm run test` -- runs root tests, then cascades to package tests
3. `pnpm --filter construct3-chef run test` -- runs just construct3-chef tests
4. `pnpm run typecheck` -- typechecks all packages
5. `pnpm run build` -- compiles all packages (validates clean compilation)

### Developer using the CLI

1. `pnpm run generate-c3` -- invokes `pnpm exec tsx packages/construct3-chef/src/cli.ts generate`
2. `pnpm run apply-recipe -- path/to/recipe.yaml` -- same entry point, different command
3. `pnpm exec tsx packages/construct3-chef/src/cli.ts <any-command>` -- direct invocation

### MCP server connection

1. Claude Code reads `.mcp.json`, sees `pnpm exec tsx packages/construct3-chef/src/cli.ts server`
2. Launches the process, communicates via stdio
3. No change in behavior -- just a different file path and pnpm instead of npx

### CI pipeline

1. `pnpm install --frozen-lockfile`
2. `pnpm run build` -- compiles all packages, validates TypeScript
3. `pnpm run test` -- runs all tests (root + packages) via tsx against source
4. `pnpm run typecheck` -- belt-and-suspenders with build (catches test-only type errors)
5. `pnpm run lint`

### Future: extracting to its own repo

1. Copy `packages/construct3-chef/` to a new repo
2. Update `package.json`: remove `"private": true`, change `workspace:*` deps to npm registry versions, change `exports` to point to `dist/`
3. `pnpm run build` produces publishable output
4. `pnpm publish` (or use as git dependency)

## Friction Audit

### Missing seams

- **`types.ts` splits across packages.** `Logger` goes to genvid-mcp-utils, `ApplyOptions` stays in construct3-chef. Low risk -- both types are trivial.
- **`bin/domain/types.ts` has a duplicate `Logger`.** After extraction, domain-manager should import `Logger` from `genvid-mcp-utils`. Minor cleanup in Phase 4.
- **`eventSheetMutator.ts` re-exports types from `c3source`.** After extraction, the re-export path changes. Worth verifying no consumer depends on the re-export vs the original.

### Preparatory refactors

- **Phase 0 (pnpm migration) is mandatory prep.** It must be done and validated before any extraction begins. If pnpm reveals undeclared dependency issues in the existing codebase, those must be fixed first.

### P-steps vs F-steps

**P-steps (pure additions, zero behavioral change):**

1. Phase 0: pnpm migration (tool change, no code change)
2. Create `packages/` directory structure and all config files
3. Create `pnpm-workspace.yaml`
4. Create barrel `src/index.ts` files
5. Create `packages/tsconfig.json` references file
6. Add `packages/*/dist/` to `.gitignore`

**F-steps (wiring, behavioral change):**

1. `git mv` source files to packages
2. `git mv` test files and fixtures to packages
3. Update import paths in moved files
4. Update import paths in root files that consumed moved modules
5. Update root `package.json` scripts to new CLI path
6. Update `.mcp.json` to new server path
7. Update `bin/tsconfig.json` to remove `c3/*.ts`
8. Move `@modelcontextprotocol/sdk` from root deps to construct3-chef deps
9. Add `zod` to construct3-chef deps

### Useful tooling

- **Verification script:** After each phase, run `pnpm run build && pnpm run test && pnpm run typecheck && pnpm run lint`. Could be a `verify-extraction.sh` one-liner.
- **`pnpm --filter` for targeted runs:** `pnpm --filter genvid-mcp-utils run test` to validate a single package quickly.

### What could go wrong

1. **pnpm strict isolation breaks existing code.** The root project may have undeclared transitive dependencies that npm hoisted silently. Phase 0 catches these before extraction begins. Mitigation: run full validation after `pnpm install` and add any missing explicit deps.
2. **pnpm on Windows.** pnpm uses symlinks on Windows, which may require developer mode or elevated permissions. The project already runs on Windows (current env), so this is likely fine. Mitigation: document any Windows-specific setup in Phase 0.
3. **Stale `dist/` causing confusion.** If a developer modifies source but doesn't rebuild, the compiled output is stale. Since `dist/` is only used for the `bin` entry point (and CI validation), this is low-risk. Tests and root scripts use tsx against source. Mitigation: add `"pretest": "pnpm run build"` only if stale dist becomes a real problem.
4. **Build ordering with `tsc --build`.** TypeScript project references handle this automatically -- `tsc --build packages/construct3-chef` will build dependencies first. The `packages/tsconfig.json` references file makes `tsc --build packages/` build everything in order.
5. **tsx + `"type": "module"` compatibility.** Same as previous design -- tsx handles this transparently. Grep for `require()` and `__dirname` in moved files.
6. **Relative path depth changes in tests.** Tests computing `projectRoot` via `path.resolve(__dirname, "../..")` need adjustment for the new directory depth.
7. **Lock file churn.** Switching from `package-lock.json` to `pnpm-lock.yaml` is a one-time large diff. Expected.
8. **`exports` pointing to `.ts` files.** This is non-standard -- it works with tsx but not with plain Node.js. Since these are private workspace packages and all consumers use tsx, this is acceptable. The `bin` field correctly points to compiled JS for CLI usage. If a package is ever extracted, `exports` would change to point to `dist/`.

### Observability

- Each phase should be a separate commit so git bisect works
- `pnpm run build` in CI validates compilation
- Existing `pnpm run typecheck` and `pnpm run test` serve as regression tests
- No new monitoring/logging needed -- structural refactor only

## Test Criteria

| Requirement | Verification | Type |
|---|---|---|
| R1: Each package has own package.json with name, deps, entry points | Inspect `packages/*/package.json` for correct names, deps, exports | Manual |
| R1: No package relies on undeclared deps | pnpm strict isolation ensures this at install time; `pnpm --filter <pkg> run test` passes | Automated |
| R1: genvid-mcp-utils has zero runtime deps | package.json has no `dependencies` field | Manual |
| R1: c3source has zero runtime deps | package.json has no `dependencies` field | Manual |
| R1: construct3-chef depends on both packages | package.json lists `genvid-mcp-utils` and `c3source` as `workspace:*` deps | Manual |
| R2: Root scripts work | `pnpm run generate-c3`, `pnpm run apply-recipe`, `pnpm run sync-c3proj`, `pnpm run validate-c3proj` all execute | Manual |
| R2: .mcp.json launches server | Start Claude Code session, verify construct3-chef MCP tools appear | Manual |
| R2: Burbank scripts updated | `pnpm run typecheck:bin` passes (bin/ files import from package names) | Typecheck |
| R3: Package tests pass in isolation | `pnpm --filter genvid-mcp-utils run test`, `pnpm --filter c3source run test`, `pnpm --filter construct3-chef run test` | Unit test |
| R3: Root tests still pass | `pnpm run test` (runs remaining root tests) | Unit test |
| R3: Integration tests skip when no project | Run construct3-chef tests from a directory without `eventSheets/` -- integration tests skip | Unit test |
| R4: No cross-boundary imports | `grep -r "from.*\.\./\.\." packages/` returns nothing | Validation |
| R4: No circular deps | Dependency graph is acyclic (leaf packages have no deps on each other or construct3-chef) | Manual |
| R5: Packages are self-contained | Each package dir has package.json, tsconfig.json, .eslintrc.cjs, src/, test/ | Manual |
| Build: All packages compile | `pnpm run build` succeeds (tsc --build packages/) | Build |
| Build: Compiled output has declarations | `packages/*/dist/*.d.ts` files exist after build | Build |
| Build: CLI bin works without tsx | `node packages/construct3-chef/dist/cli.js --help` runs | Build |
| Phase 0: pnpm migration clean | `pnpm run lint && pnpm run test && pnpm run typecheck` all pass after migration | Validation |
| Lint passes | `pnpm run lint` (root ignores packages/) and `pnpm --filter './packages/*' run lint` | Lint |
| Typecheck passes | `pnpm run typecheck` (root + packages) | Typecheck |
| All tests pass | `pnpm run test` (root + packages) | Unit test |

## Cross-Domain Boundary

This extraction is entirely within the TypeScript/tooling domain. No C3 event sheets, layouts, or other C3-managed files are modified. All changes are:

- **TypeScript:** Moving `.ts` files, updating import paths
- **Configuration:** `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.mcp.json`, `pnpm-workspace.yaml`, `.npmrc`, `.gitignore`
- **Tests:** Moving `.test.ts` files and fixtures

Migration phases should be separate commits for reviewability:

1. Commit: pnpm migration (Phase 0 -- tool change, no extraction)
2. Commit: Create package scaffolding (package.json, tsconfig, eslint, barrel files, workspace config)
3. Commit: Extract genvid-mcp-utils (move files + tests, update imports)
4. Commit: Extract c3source (move files + tests, update imports)
5. Commit: Extract construct3-chef (move files + tests, update imports)
6. Commit: Update root project (scripts, .mcp.json, bin/tsconfig, remaining import fixes, build setup)
