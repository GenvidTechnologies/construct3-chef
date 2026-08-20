---
type: decision-record
title: "0020. Anchor `search()`'s editor-local filter at `baseRoot`, not the walked directory"
description: >-
  Closes the last editor-local walk residue named by ADR 0019: `search()`'s four `walkFiles` sites plus its two single-file branches now filter via one shared predicate anchored at `baseRoot` (not the walked directory, which #159 prescribed and which fails when the walked directory is itself editor-local); also adds a `statSync().isFile()` guard against directory junctions/dangling symlinks, correcting a wrong upstream claim in mcp-utils#10 that a predicate can't fix it ([#159](https://github.com/GenvidTechnologies/construct3-chef/issues/159))
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0020. Anchor `search()`'s editor-local filter at `baseRoot`, not the walked directory

- **Status:** Accepted
- **Date:** 2026-08-10
- **Issue:** [#159](https://github.com/GenvidTechnologies/construct3-chef/issues/159)

## Context

ADR [0019](./0019-two-walk-primitives-one-classification-rule.md) closed two of
the three project-source walks left unfiltered for editor-local content and
named the third — `src/c3/search.ts`'s `json`-type walk — as a remainder,
filed immediately as #159 rather than gated on recurrence. `search()`'s four
`walkFiles` call sites and two single-file branches passed a bare extension
string, so a `json` search returned `*.uistate.json` files and `uistate/`
subtrees — editor-local state C3 writes into `eventSheets/`/`layouts/` when
the project is opened in the editor.

ADR 0019 settled *which primitive* to reach for at each site (the selection
rule stated in CLAUDE.md's editor-local bullet), but left *where to anchor
the classification* as a per-site judgement: `spriteScaffold.ts`'s scaffold
collector anchors at the walked directory itself, `generateSidRegistry`
anchors at the project root. `search()` is the third case, and it forces a
choice between the two rather than tolerating either: unlike both
predecessors, its walked directory is caller-supplied via the `path` option
and can itself *be* an editor-local directory (`path: "layouts/uistate"`),
which the walked-dir anchor cannot handle.

## Decision

Anchor the classification at **`baseRoot`** —
`isExtracted ? config.extractedDir : config.projectRoot`, already computed
in `search()` — via one shared `keep(root)` predicate factory applied at:

1. all four `walkFiles` call sites, not only the one the `json` type
   reaches (the other three back the `dsl`/`ts`/`layout`/`md`/`idx` types,
   rooted under `extracted/`, where the predicate is a provable no-op
   today — future-proofing against a `baseDir: "project"` type added
   later);
2. the two single-file branches (the exact-stem hit and the resolved
   `candidatePath`), which bypass `walkFiles` entirely — otherwise the same
   file is excluded via a directory walk but returned when addressed by
   exact stem;
3. `statSync().isFile()` on each surviving candidate.

One anchor point covers both the `extracted`/`project` `baseDir` branches
and all six `SearchType`s, so there is exactly one place the classification
can attach — matching ADR 0019's closing intent that the *primitive* stays
split per site while the *classification* stays uniform.

### Rejected: anchor at the walked directory

This was #159's own prescription. It fails for `path: "layouts/uistate"`:
the walked directory *is* the editor-local directory, so
`path.relative(walkedDir, candidate)` strips the `uistate` segment before it
ever reaches the classifier, yielding a bare `Main.json` with no segment
left to classify — every editor-local file under it comes back unfiltered.
`baseRoot` cannot hit the symmetric hazard the walked-dir anchor was meant
to dodge either (an ancestor path segment above the walk incidentally named
e.g. `uistate`), because relativizing against `baseRoot` strips every
segment above it regardless of walked-dir depth — a project living at
`C:/x/uistate/proj` is unaffected.

### Rejected: filtering only the one `walkFiles` call site the `json` type reaches

`json` is the only `SearchType` whose validation requires `path`, prefixed
`eventSheets/` or `layouts/`, so it never reaches the no-path branch's
`walkFiles` call — it shares the other two path-driven walks with the
subDir-bearing types instead. #159's own body miscounted the reachable-site
set twice while scoping this (first as two call sites, then as four without
noting one is unreachable for `json`) — itself a reason to filter
unconditionally at all four sites rather than reason case-by-case, per
`SearchType`, about which site it reaches.

### The `statSync` clause, with its correction

[mcp-utils#10](https://github.com/GenvidTechnologies/mcp-utils/issues/10)
and the PR body for this change both initially claimed a predicate cannot
fix a directory-junction `EISDIR` crash "because `walkFiles` decides
file-vs-directory before the predicate runs." That claim is wrong and was
corrected upstream (see the
[issue comment](https://github.com/GenvidTechnologies/mcp-utils/issues/10#issuecomment-5246685150)):
`walkFiles` routes *non-directories* to the predicate, and a dirent for a
symlink-to-a-directory reports `isDirectory() === false` — the very cause of
the bug — so the offending entry does reach the predicate. Probed directly:

| probe | result |
|---|---|
| `walkFiles(L, ".json")` | `['JunctionDir.json', 'Real.json']` |
| paths the predicate was invoked on | `['JunctionDir.json', 'Real.json']` |
| `walkFiles(L, p => p.endsWith(".json") && statSync(p).isFile())` | `['Real.json']` |
| `readFileSync('JunctionDir.json')` | `EISDIR` |

The claim holds only for a *real* directory, which `walkFiles` recurses into
and never emits as a candidate — so that case was never the actual risk.
`statSync` deliberately **follows** symlinks (a symlink pointing at a real
file must still be returned; a bare `Dirent.isFile()` check would wrongly
drop it) and is wrapped in `try/catch` rather than
`statSync(p, { throwIfNoEntry: false })`, since that option suppresses only
`ENOENT` and would let `ELOOP`/`EACCES` propagate into a crash instead of a
silent drop.

## Compromise

- **Filtering all four `walkFiles` sites, not just the reachable one, trades
  a few no-op predicate calls for removing a recurring miscount trap** —
  #159's body got the reachable call-site count wrong twice while scoping
  this. Filtering unconditionally means no future `SearchType` addition
  needs to re-derive which sites it reaches.
- **The `statSync` clause is partly, but not wholly, superseded by
  mcp-utils 0.6.0.** ⚠️ **Corrected 2026-08-10 — this bullet previously said
  the clause "becomes redundant and should be dropped" once mcp-utils#10
  landed. Following that verbatim would ship a regression.** mcp-utils 0.6.0
  makes `walkFiles` guarantee every returned path is a regular file, so the
  clause is now redundant for the **four `walkFiles` sites** — but it remains
  **load-bearing for the two single-file branches**, which never call
  `walkFiles` and reach `readFileSync` through a bare `existsSync()` that
  reports `true` for a directory. The original wording was written when
  `keep()` had only the four walk callers, and was falsified by the two
  single-file branches added later in the same change — the same sentence
  block, and the same later edit, that also left its site count reading
  "four" instead of six.

  Verified by probe: with 0.6.0 installed, deleting the clause makes
  `path: "layouts/DirNamed"` (a `.json`-suffixed **directory**, addressed by
  exact stem) throw `EISDIR` again. The dangerous part is that **every other
  test stayed green** — the bump silently converted a guarded clause into an
  unguarded one, because the pre-existing junction tests all reach the walk
  path that upstream now filters. The regression test
  *"does not throw EISDIR when an exact stem names a .json-suffixed
  directory"* was added for exactly this and is the only test that fails if
  the clause is removed.

  The upstream fix was still worth having: it covers chef's other three
  `walkFiles` call sites (`generators.findJsonFiles`, `spriteScaffold`,
  `cli.ts`'s `search-dsl`) plus the sibling `c3-domain-manager` in one place,
  with no local change. Those inherited fixes are locked by their own tests,
  each verified to fail on 0.5.1 and pass on 0.6.0.
- **Coverage is synthetic temp-dir with positive controls, not the
  canonical fixture** — the fixture tracks zero editor-local files at every
  tag, so a fixture-based assertion would pass vacuously, the same trap ADR
  0019 names for the pre-fix `serverHandlers` assertions it replaced. Each
  filter test proves the walk had the opportunity to return the excluded
  file before proving it was excluded.
- **Two of the three `EDITOR_LOCAL_EXCLUSIONS` dimensions are unreachable
  through the `json` type**, and are covered by *rejection* tests rather
  than filter tests: `tsconfig.json` sits at the project root and
  `ts-defs/` sits under `scripts/`, both outside the `eventSheets/`/
  `layouts/` prefix the `json` type's own validation requires. A path
  reaching either dimension is rejected by that prefix guard before the
  filter predicate ever runs, so a filter test targeting either would pass
  because the path throws, not because filtering works.
- **Behavior change on barrel-exported `search()`** — it narrows its
  returned result set (fewer editor-local hits, and a directory
  junction/dangling symlink no longer crashes the caller with `EISDIR`). No
  signature change, so no MAJOR bump; a release note is owed, the same call
  ADR 0019 makes for `collectAllObjectTypeSids`/`collectMaxImageSpriteId`.

## Consequences

- `search()` is now uniform with the rest of chef's project-source walks in
  *classification*, closing the remainder ADR 0019 named.
- The per-site walked-dir-vs-base-root anchor question ADR 0019 left open
  is resolved for this third case and generalizes: anchor at the root the
  walk is rooted from, not the walked directory, whenever the walked
  directory can itself be — or be nested inside — an editor-local
  directory. `spriteScaffold.ts`'s walked-dir anchor stays correct as-is:
  its walked directory is always `objectTypes/` itself, never a caller-
  supplied subpath, so it can never be the editor-local directory.
- `search.ts`'s `json`-type walk is no longer chef's one remaining
  un-migrated project-source walk; CLAUDE.md's editor-local bullet is
  updated to drop the forward pointer to #159.
- The `statSync().isFile()` clause is a debt to retire once mcp-utils#10
  ships; no other action is implied until then.
