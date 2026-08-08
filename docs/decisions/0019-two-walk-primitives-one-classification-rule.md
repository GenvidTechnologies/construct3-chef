# 0019. Two walk primitives, one classification rule — closing the editor-local walk residue

- **Status:** Accepted
- **Date:** 2026-08-07
- **Issue:** [#152](https://github.com/GenvidTechnologies/construct3-chef/issues/152), [#149](https://github.com/GenvidTechnologies/construct3-chef/issues/149)

## Context

ADR [0016](0016-shared-file-walk-adoption-triage.md) declined three walk
adoptions and stated two lessons: "reachability is not classification," and
"prefer the named collector over the generic walk plus a hand-written
predicate." ADR [0018](0018-editor-local-writes-are-not-source-changes.md)
consumed the resulting classifier (`src/c3/editorLocal.ts`) at two
watcher/freshness sites and forward-pointed at #149/#152 as "not fixed here."
This record closes that pointer.

Two of chef's project-source walks still bypassed editor-local
classification: `src/c3/customAceIndex.ts` walked `families/` flat and
unfiltered (nested families were invisible to the #88 runtime-resolution
chokepoint; an editor-local file carrying `name`/`members` would register as
a family), and `src/c3/spriteScaffold.ts` walked `objectTypes/` with zero
filtering (editor-local `imageSpriteId`s inflated `nextImageSpriteId`,
changing bytes written into a cloned objectType). Separately, the two
`serverHandlers` assertions meant to guard editor-local exclusion on the MCP
list tools passed vacuously — the canonical fixture carries zero editor-local
files, so they would keep passing if the filtering were deleted outright.

**The load-bearing new finding: ADR 0016 §3's three decline reasons are
*site*-properties, not *primitive*-properties.** Evaluated at
`customAceIndex`'s families walk they come out 1-partial / 2-inapplicable /
3-inapplicable:

- ENOENT tolerance — **partial**: the missing-dir case is covered by
  c3source's own `findInSection` `existsSync` guard, exactly mirroring the
  `existsSync` guard being removed. The residual is EACCES/ENOTDIR/mid-walk-
  vanish.
- statSync/TOCTOU whole-directory abort at a *second* caller —
  **inapplicable**: `buildCustomAceIndex` has exactly one caller
  (`recipeApplier.ts`), invoked once per recipe apply/validate, not a
  polling freshness scan.
- `.sort()` observable — **inapplicable**: both membership maps accumulate
  into `Set`s via get-or-create, so duplicate family names union and
  ordering is unobservable.

So the same primitive correctly *declined* at `generators.findJsonFiles` is
correctly *adopted* here. That inversion is why this is a new record rather
than a footnote on 0016. This is ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md)'s
fifth application record — after [0007](0007-mcp-server-root-resolution-and-c3project-adoption.md),
[0014](0014-adopt-c3source-addon-domain-layer.md), 0016, and 0018 — and the
one that closes the "one shared walk" story.

## Decision

Three parts.

### 1. Adopt `C3Project.findAllFamilies()` at `customAceIndex`, with a contextual rethrow

Trading swallow-and-degrade for loud failure at a validation chokepoint. The
principle: *a validator that cannot read its inputs must report **that**,
never a verdict about the user's recipe.* Every degrade option converts an
I/O fault into a content claim. A **missing** `families/` stays tolerated
(mirrored from `findInSection`'s own `existsSync` guard — families are
optional in a C3 project); a **present-but-unreadable** `families/` now
throws `custom-ACE validation could not read families/ under <root>: <msg>`
instead of degrading to an empty map.

### 2. Keep `walkFiles` + `isEditorLocalPathUnder` at `spriteScaffold`

Because its callers' contract is a **bare directory** and they are
**barrel-exported at 1.0.0** (`collectAllObjectTypeSids`,
`collectMaxImageSpriteId`), so they depend on the missing-dir → `[]` degrade
— `find_all_objectTypes_path` has no `existsSync` guard and would newly
throw. Stated as a selection rule, the most reusable thing in this record:

> Reach for the **c3source named collector** (`project.findAll*()` /
> `find_all_*_path`) when the site owns a project **root** or a `C3Project`
> handle and can afford to fail loudly on an I/O fault. Reach for
> **`walkFiles` + `editorLocal.isEditorLocalPathUnder`** when the site's
> contract is a **bare directory**, is **barrel-exported**, or depends on
> the missing-directory / `ENOENT` degrade. Never hand-write the
> editor-local predicate in either case.

This is **not** drift: it is ADR 0016's own posture ("check that the
primitive answers the same question the call site asks") applied twice with
different inputs and therefore different answers. Per 0016 §Compromise's
explicit precedent, the rule is recorded **twice** — here, and as call-site
JSDoc in both `customAceIndex.ts` and `spriteScaffold.ts` (shipped in
commits `0fa96e1` and `c73c5f7`).

### 3. Rewrite the two vacuous `serverHandlers` assertions as seeded synthetic tests

With a three-part anti-vacuity device, because **no red is possible** there
— the filtering is entirely upstream c3source's (`find_all_eventsheets_path`
/ `find_all_layouts_path` apply `isEditorLocalPath` internally), so there is
nothing chef-side to revert.

## Compromise

- **#152's stated severity is inverted, and the record says so.** The
  recursion gap fails *closed*: `hasAce` is event-sheet-sourced, family data
  feeds only `membersOf`/`familiesOf`, which can only ever *add* errors — so
  a missing family produces a **false-positive** `"X" is not a member of
  family "F"` rejection of a valid recipe, not a permissive pass. Only the
  *filter* gap can weaken the guard, and only via a file carrying
  `{name, members}`.
- **#152's uistate mechanism claim is false.** A real uistate file is valid
  JSON, so `JSON.parse` succeeds and the `catch` never fires; the
  `{name, members}` **shape guard** is what absorbs it. This is why every
  red test seed must be a **crafted** record, and why a realistic uistate
  seed would have passed vacuously.
- **The two halves of `buildCustomAceIndex` already disagreed on
  tolerance** — the event-sheet half (`find_all_eventsheets_path`, a bare
  `readdirSync`) throws on a missing dir today. The adoption makes
  present-but-unreadable loud on both halves while keeping *missing*
  `families/` tolerated. Switching the event-sheet call to
  `project.findAllEventSheets()` was **considered and not taken** — no
  caller can reach the missing-`eventSheets/` case, so it would be an
  untestable behavior change.
- **Degrade-and-warn was representable and still rejected.**
  `buildCustomAceIndex` is off-barrel and its single caller
  (`recipeApplier.ts`) has a `log` in scope, so the seam costs nothing —
  recorded so a reopen is a ~5-line diff. **Evidence that would reopen it:**
  a real report (e.g. from [#14](https://github.com/GenvidTechnologies/construct3-chef/issues/14)
  live-editor integration) of `validate-recipe`/`apply-recipe` aborting on
  transient `families/` churn.
- **The `serverHandlers` tests can never be red**, stated in the tests
  themselves: an unfiltered `walkFiles` baseline (opportunity proof), a
  seeded *real* file (proves `__setProjectRoot` retargeted `PROJECT` — a
  hardcoded expectation would pass against the pristine fixture), and a
  **derived** count `baseline.length - 1` (survives a `construct3-sample`
  pin bump). The per-handler baseline difference is load-bearing:
  `find_all_layouts_path` carries no `.json` predicate where
  `find_all_eventsheets_path` does.
- **`families/uistate/` has no HEAD-red** and no artificial "recursive but
  unfiltered" intermediate was manufactured to produce one (that would be a
  throwaway intermediate). An in-test nested-real-family control — itself
  red at HEAD — carries the falsifiability instead.
- **Two declines recorded, not silently skipped:** `discoverAndPlanImageCopies`
  (`images/` is not project source; every editor-local dimension is
  structurally unreachable through its `.png` filter) — **reopens if** C3
  begins writing editor-local artifacts into `images/` or the discovery
  widens beyond `.png`; and `search.ts`'s `json`-type walk, a **third**
  un-migrated project-source walk found during this design and named by
  neither issue, deferred to [#159](https://github.com/GenvidTechnologies/construct3-chef/issues/159)
  (filed immediately, not gated on recurrence). Also note the unrelated
  `isFile()` robustness gap in `discoverAndPlanImageCopies` went to
  [#160](https://github.com/GenvidTechnologies/construct3-chef/issues/160)
  — explicitly *not* grounds to reopen the editor-local decline.
- **A live crash was found and closed incidentally:** `spriteScaffold`'s
  collectors `JSON.parse` with no try/catch, so a JSONC
  `objectTypes/tsconfig.json` (with `//` comments, which C3 writes) crashed
  `clone-sprite` outright on both surfaces. Excluding editor-local files
  removes the exposure.
- **The stale-citation class is removed, not reset.** Three sites carried
  three *mutually inconsistent* line-number citations of the same two tests
  (#149 said `:281-291`/`:337-350`; `CLAUDE.md` said `:281-292`/`:337-346`;
  the actual lines were `:312-324`/`:368-382`). All become **name-based**
  citations so the class of staleness is gone rather than re-anchored.
- **A release note is owed** — `collectAllObjectTypeSids`/
  `collectMaxImageSpriteId` are barrel-exported and narrow their behavior (a
  lower `nextImageSpriteId` changes `imageSpriteId` bytes written into a
  cloned objectType), the same call ADR 0018 made for its watcher change;
  plus the recipe-surface loudness. No signature changes, so no MAJOR bump.
  Repo has no `CHANGELOG.md`, so it rides the PR body to the release tag.
- **Symlinked `families/` subdirectories change behavior** — `walkFiles`
  treats a symlinked dir as a leaf; `find_all_files_path` `statSync`s and
  recurses. Exotic, unobserved, recorded rather than defended against.

## Consequences

- chef's project-source walks are now uniform in *classification* though
  intentionally split in *primitive*.
- The "one shared walk" story closes with one recorded remainder:
  [#159](https://github.com/GenvidTechnologies/construct3-chef/issues/159)
  (`search.ts`'s `json`-type walk).
- The #88 runtime-resolution chokepoint gains nested-family coverage.
- The editor-local guard tests (`serverHandlers.test.ts`) stop passing on an
  empty corpus.
- [#149](https://github.com/GenvidTechnologies/construct3-chef/issues/149)
  and [#152](https://github.com/GenvidTechnologies/construct3-chef/issues/152)
  are closed; ADR 0018's "Neither is fixed here" note is superseded by this
  record without being edited.
