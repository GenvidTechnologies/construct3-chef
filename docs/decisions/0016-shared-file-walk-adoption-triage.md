# 0016. Adopt c3source's shared file walk only where its shape fits

- **Status:** Accepted
- **Date:** 2026-08-05
- **Issue:** [#146](https://github.com/GenvidTechnologies/construct3-chef/issues/146)

## Context

`@genvidtech/c3source@1.9.0` added an optional third `descend` parameter to `find_all_files_path`, controlling directory **reachability** separately from the `predicate`'s file selection. [#146](https://github.com/GenvidTechnologies/construct3-chef/issues/146) proposed that this was the missing piece making the shared walk adoptable at *every* remaining hand-rolled recursion in chef, and scoped two sites (`includeTree.buildSheetNameMap`, `projectSync.readDiskDir`); a third (`generators.findJsonFiles`) was brought into scope during planning as another parallel project walk.

The relevant upstream domain fact is `EDITOR_LOCAL_EXCLUSIONS`, which classifies C3-editor-local artifacts along **three independent dimensions**:

| Dimension | Value | What it catches |
|---|---|---|
| `dirs` | `["uistate", "ts-defs"]` | C3 r487+ editor UI state; generated TS typings |
| `fileSuffixes` | `[".uistate.json"]` | a `Foo.uistate.json` sibling next to `Foo.json` |
| `exactNames` | `["tsconfig.json"]` | the C3-generated, editor-overwritten tsconfig |

`isEditorLocalPath(name)` is true if a bare basename matches *any* dimension. `find_all_files_path` applies only the `dirs` dimension (as its default `descend` rule); the *file* dimensions are the caller's `predicate`'s job. The **named** collectors (`find_all_eventsheets_path`, `find_all_layouts_path`, …) are thin wrappers that supply the matching predicate, so they cover all three.

This is the ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) posture applied at four decision points — its third *application* record, after [0007](0007-mcp-server-root-resolution-and-c3project-adoption.md) (#94, `C3Project`) and [0014](0014-adopt-c3source-addon-domain-layer.md) (#136, the `.c3addon` domain layer). Same shape as both: a partial adoption plus a per-site record of what stayed local and why.

## Decision

**One adoption, three declines.**

### 1. ADOPT — `find_all_eventsheets_path` in `buildSheetNameMap` (`src/c3/includeTree.ts`)

`buildSheetNameMap` kept its own `readdirSync` recursion accepting every `.json`, with no editor-local filtering at all — the last hand-rolled event-sheet walk in the repo. The collector (directly, or via `C3Project.findAllEventSheets()`) already backed every other event-sheet discovery site in chef.

The shape fits exactly: same recursion, same file type, and — decisively — the **named collector carries the editor-local predicate**, so both the `uistate/` directory prune and the `*.uistate.json` sibling rejection come for free. Only the project-root-relative POSIX path normalization stays local; that is rendering, which per ADR 0006 does not move upstream.

**This is not a bug fix.** The defect was latent and unreachable: the map's single consumer chain is `resolveIncludeTree` → the `list-include-tree` MCP tool, which only ever looks up a real sheet name (normalized to the last path segment minus `.json`) or an `extractIncludes` `ref.includeSheet` — neither can produce a `.uistate` key, and `Foo.uistate` never collides with `Foo`. It is a drift fix.

Two observable changes to a barrel-exported function, neither semver-breaking: editor-local entries are now excluded, and duplicate sheet names across subfolders now resolve deterministically (last in the walk's sorted DFS order) rather than by `readdir` order — previously undefined, and unreachable in a valid C3 project, where manifest sheet names are unique project-wide.

### 2. DECLINE — `readDiskDir` (`src/c3/projectSync.ts`)

Three independent shape mismatches, **any one sufficient**:

1. **It must return directories.** `syncFileFolder` mirrors the disk folder tree into `rootFileFolders[].subfolders[]` and emits `+ foo/ (new folder)` / `- foo/` change lines from `DiskTree.dirs`. A flat, files-only primitive structurally cannot report an *empty* disk directory that must nonetheless become a manifest subfolder.
2. **It must be per-level, not recursive.** `syncFileFolder` owns the recursion so it can descend in lockstep with the manifest folder object it mutates, and it deliberately drops the root-level `ignorePaths`/`ignoreDirs` at depth ≥ 1. A self-recursing walk owns the traversal, so it can neither be stepped alongside the manifest tree nor vary its filter by depth.
3. **The ignore rules are not all editor-local classification.** `ignorePaths: ["tsconfig.json"]` and `ignoreDirs: ["ts-defs"]` *are* covered by `EDITOR_LOCAL_EXCLUSIONS`, but the `extensions` filters (`.ts`/`.webm`/`.ttf`/`.png`) encode manifest-section **membership** semantics, about which upstream has — and should have — no opinion.

The issue's fallback ("at minimum have the ignore logic delegate to `isEditorLocalPath`") is therefore a **behaviour change, not a refactor**: exclusions would newly apply at every nesting level, and `uistate` would newly be excluded from all six file sections. `sync-project`'s output must not change inside a refactor PR.

### 3. DECLINE — `findJsonFiles` / `generateSidRegistry` (`src/c3/generators.ts`)

It **buys nothing.** The editor-local *classification* is already delegated to c3source's `isEditorLocalPath` by `generateSidRegistry`'s post-hoc path-**segment** filter, which covers both the `uistate/` directory segment and the `*.uistate.json` basename. There is no duplicated rule to dedup — only a duplicated *walk*, and the walk is exactly where the tolerances differ.

And it would **cost** three observable behaviour changes:

- mcp-utils' `walkFiles` swallows `ENOENT` *inside* the recursion (re-throwing every other error), which `generateSidRegistry` relies on so a project missing `objectTypes/` still produces a registry; `find_all_files_path` does a bare `readdirSync` and throws. An `existsSync` prefix guard is a weaker substitute — a TOCTOU race covering neither `EACCES` nor `ENOTDIR`.
- `find_all_files_path` `statSync`s every entry, which would turn a per-file TOCTOU into a **whole-directory abort** at the second caller, `src/mcp/server.ts`'s sid-registry freshness scan, whose loop is explicitly written to skip a vanished file and keep scanning rather than mask later staleness.
- its `.sort()` is a third observable difference.

All three would land on `findJsonFiles` and `SID_SOURCE_DIRS`, **both barrel-exported**, at 1.0.0, for zero gain.

### 4. DECLINE — the `descend` parameter itself

**No consumer in chef.** `ts-defs/` is reached by two hardcoded filenames (`recipeApplier.ts`: `instanceTypes.d.ts`, `objects.d.ts`), a tsconfig `include` glob **string** in generated output (`generators.ts`), and a skip in `projectSync.ts` — there is no walk to parameterize. #146 anticipated this ("there is no walk to replace yet"); it is recorded here explicitly so nobody invents a walk to justify the parameter.

### 5. Correction on the record

#146's proposed snippet for site 1 is **wrong**:

```ts
find_all_files_path(esDir, (name) => name.endsWith(".json"));
```

`find_all_files_path` prunes editor-local *directories*, but the *predicate* owns file classification — and `Foo.uistate.json` ends in `.json`. The snippet fixes the `uistate/` descent and leaves the bogus `Foo.uistate` sheet entry, i.e. it fixes one of the two symptoms the issue itself listed. The right primitive is the named collector `find_all_eventsheets_path`, which **already shipped in 1.8.0** — so **the adoption never needed the 1.9.0 bump at all**.

Two transferable lessons:

- **Reachability is not classification.** This is c3source's own framing of why `descend` exists: `isEditorLocalPath` conflates "is this C3 source?" with "may the walk enter it?", and the two questions have different answers per dimension. A predicate that answers only the first is not a filter.
- **Prefer the named collector over the generic walk plus a hand-written predicate.** The named collectors exist precisely so the predicate is not re-derived per caller; re-deriving it is how a caller silently picks up one dimension of a three-dimension rule.

Two further #146 premises are stale and are corrected here for the record: it names the `projectSync` function `readDiskTree` (it is `readDiskDir`; `DiskTree` is the return *type*), and its motivation for that site — that `ignoreUistate` re-implements `isEditorLocalPath` and will diverge when c3source adds a rule — has been stale since #47 rerouted name-section sync through `detectManifestDrift` (which delegates to `isEditorLocalPath` internally). The flag is read nowhere and re-implements nothing.

## Compromise

- **`ignoreUistate` is deprecated in place, not deleted.** It is dead, not wrong: declared once, set `true` on all six `NAME_SECTIONS`, read nowhere. `NameSectionConfig` is barrel-exported and the repo is at 1.0.0, so removal is a MAJOR bump — it carries an `@deprecated` tag and is deleted at the next major.
- **The two declines are recorded twice** — as JSDoc at the call sites (`readDiskDir`, `findJsonFiles`) *and* here. The duplication is deliberate: the code-side reader who is about to "clean up" a hand-rolled walk needs the reason where the walk is, and the ADR reader needs the triage in one place. The JSDoc carries the site-specific detail and links here; this record carries the policy.
- **The 1.9.0 bump is kept anyway, on its own merits and sequenced last** so a bisect lands on it rather than on the walk swap. Its actual justification is `custom-ace-name-required`, added to `EDITOR_FIELD_RULES`, which reaches chef's `assertEditorValid` write chokepoint as a new pre-write guard on both `apply-recipe` and `validate-recipe`; its first real-data coverage arrives via the v0.7.0 fixture's `custom-ace-block`. The rest of the 1.9.0 export surface is purely additive.
- **The regression tests for site 1 are split by dimension** — one per mechanism (`fileSuffixes`: a `*.uistate.json` sibling; `dirs`: a `uistate/` subfolder; `exactNames`: a stray `tsconfig.json`) rather than combined, because `EDITOR_LOCAL_EXCLUSIONS` treats the three as independent and a combined test could not say which one regressed. They are synthetic by necessity — the `construct3-chef-sample` fixture carries zero editor-local files, so a fixture-based version would pass vacuously.
- **`exactNames` was live at the adopted site, not theoretical.** The pre-fix `scan()` accepted any `.json`, and `tsconfig.json` *is* `.json` — so a stray `eventSheets/tsconfig.json` would have registered a sheet named `tsconfig`. That third dimension is exactly what a hand-written `.endsWith(".json")` predicate cannot express, and it is why the dimension table above is worth stating in full.
- **`detectReferenceIntegrity` (also new in 1.9.0) stays unadopted, and the ownership boundary is deliberate.** #146 closed with this note, and closing the issue would otherwise leave it homeless: upstream's reference-integrity detection owns the declared-`usedAddons` ↔ used-in-source edge, while the `.c3addon`-package ↔ `usedAddons` direction stays chef's (`addonValidator.ts`, `addonInventory.ts`). No action implied — recorded so the split stays intentional rather than looking like an oversight the next time someone reads the 1.9.0 changelog.

## Consequences

- The last hand-rolled event-sheet walk is gone; `find_all_eventsheets_path` (or `C3Project.findAllEventSheets()`) is now the only way chef discovers event sheets.
- `sync-project` and the sid-registry generator keep their local walks with the reason attached at the call site, so the question is not reopened from the code side. Reopening either requires new evidence against the mismatches listed above, not a fresh reading of the adoption posture.
- No public-API removals or renames: `buildSheetNameMap` changes behaviour but not signature; `NameSectionConfig`/`readDiskDir` and `findJsonFiles`/`SID_SOURCE_DIRS` change comments only. No MAJOR bump.
- ADR 0006's rule gains a sharper corollary for traversal specifically: *owning the fact upstream isn't sufficient — and neither is owning the walk. Check that the primitive answers the same question the call site asks.* The #42 → c3source#21 case (a flat detection-only `detectManifestDrift` that could not back a nested mutating sync) is the same call at a different layer.
