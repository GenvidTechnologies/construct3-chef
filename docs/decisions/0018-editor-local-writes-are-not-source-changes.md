# 0018. Editor-local writes bump neither `txId` nor `extractedDirty`

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issue:** [#151](https://github.com/GenvidTechnologies/construct3-chef/issues/151)

## Context

`createSourceWatcher` (`src/mcp/sourceWatcher.ts`) wires mcp-utils'
`OptimisticWatcher` over `SOURCE_DIRS` (`eventSheets`, `layouts`,
`objectTypes`, `families`, `scripts`) plus `project.c3proj`. Its
`onExternalChange` filters only on `path.resolve(filePath) !== c3projPath` —
no editor-local classification at all. A live C3 editor writes
`*.uistate.json` constantly, so each write sets `extractedDirty` (a stale
warning a regenerate cannot clear, because the editor immediately rewrites
uistate) and bumps `txId` (rejecting an agent's `apply-recipe` with a
stale-txId error caused by nothing the agent did — a real optimistic-
concurrency failure mode on any project open in the editor).

Second, smaller site: `checkRegistryFreshness` in `src/mcp/server.ts` takes
the max mtime over `SID_SOURCE_DIRS` via the unfiltered
`generators.findJsonFiles`, so a touched `*.uistate.json` also sets
`extractedDirty`. Largely subsumed by the watcher, which sets the same flag
by a faster path — fixed alongside, not as an independent problem.

(These two are "Site 1" and "Site 4" in #151's own numbering, which also
covered sites split out to #149 and #152. Below they are "site 1" and
"site 2", in the order introduced here.)

### The load-bearing mechanism finding

The issue's own fix sketch — filter inside `onExternalChange` — cannot
satisfy its own `txId` acceptance criterion. mcp-utils'
`OptimisticWatcher.handleEvent` bumps unconditionally *before* invoking the
callback:

```js
handleEvent(filename) {
  if (this.suppressDepth > 0) return;          // Layer 1
  if (this.expected.consume(filename)) return; // Layer 2
  this.bump();                                 // ← unconditional
  this.onExternalChange?.(filename);           // ← then the callback
}
```

A filter placed in `onExternalChange` controls **only** `extractedDirty`. It
structurally cannot stop the bump, leaving the spurious `apply-recipe`
rejection — the failure mode the issue was filed for — unfixed. This is why
the shipped mechanism differs from the issue's prescription, and it is
worth recording explicitly so the difference doesn't read as an oversight.

## Decision

**A filtering decorator over the watcher factory.** `createSourceWatcher`
already owns the seam (`opts.watcherFactory ?? fsWatchFactory`); dropping
editor-local paths before calling `onEvent` means `handleEvent` never runs
for them at all, suppressing both the bump and the callback in one place.
Entirely local — no upstream change, and no new extension point requested
of `OptimisticWatcher`.

The decorator must wrap the **selected** factory, not just the default
`fsWatchFactory`: `test/mcp/sourceWatcher.test.ts` injects a stub factory,
which would otherwise bypass the filter and make the regression tests
vacuous.

The classification itself is c3source's `isEditorLocalPath`
(`dirs`/`fileSuffixes`/`exactNames`, per ADR
[0016](0016-shared-file-walk-adoption-triage.md)), applied path-segment-wise
via a new shared off-barrel `src/c3/editorLocal.ts`, so the rule is written
once and consumed at both sites below rather than re-derived per caller.

The second site, `checkRegistryFreshness`, is fixed at the **caller**:
its scan over `SID_SOURCE_DIRS` now excludes editor-local paths before
taking the max mtime. `findJsonFiles` itself is untouched — it is not
routed through `find_all_files_path` (ADR 0016 §3: a whole-directory
TOCTOU-abort primitive would replace `checkRegistryFreshness`'s intentional
per-file skip-and-continue tolerance).

### Why not upstream (mcp-utils)

An `OptimisticWatcher` `shouldTrack`/`isRelevant` predicate hook, running
before `bump()`, was considered and rejected. Per ADR
[0006](0006-upstream-ownership-boundary-and-adoption-posture.md),
`isEditorLocalPath` is a C3 domain fact owned by c3source; mcp-utils is
generic MCP plumbing and must stay C3-agnostic — a predicate hook there
would either bake in a C3-specific classifier or need chef to inject one,
neither of which the factory-decorator seam requires. And the factory
parameter already *is* the extension point: the capability was never
missing, only unused.

### The in-repo precedent this generalizes

`docs/mcp-architecture.md` already states, of the ops registry: op files
"are not C3 source, so edits to them must NOT bump `txId` or set
`extractedDirty`" — implemented there via a wholly separate watcher.
Editor-local state is the same category of non-source file; this decision
generalizes a rule the repo had already adopted once, rather than inventing
a new one.

### Relationship to ADR 0016

ADR 0016 declined to move `generators.findJsonFiles`'s *walk* upstream,
while noting the editor-local *classification* was already delegated to
`isEditorLocalPath` by `generateSidRegistry`'s post-hoc path-segment filter.
This decision *consumes* that same predicate at two new call sites and
leaves every walk exactly where 0016 left it — it is not a reopening of
0016, only a second application of the classification it already
established as correct.

## Compromise

- **Deliberate broadening beyond uistate.** `isEditorLocalPath` classifies
  along three independent dimensions: `dirs: ["uistate", "ts-defs"]`,
  `fileSuffixes: [".uistate.json"]`, `exactNames: ["tsconfig.json"]`.
  Adopting the whole predicate — rather than a hand-rolled uistate-only
  subset — means `scripts/ts-defs/*.d.ts` and `scripts/tsconfig.json` also
  stop bumping, since `SOURCE_DIRS` includes `scripts`. Accepted because a
  subset predicate is exactly the hand-written classification #146 got
  wrong and ADR 0016 corrected: reachability is not classification, and a
  caller re-deriving one dimension of a three-dimension rule is how a
  future editor.json-shaped file silently falls outside it. Evidence it is
  safe: the generators never read ts-defs *content* — `generators.ts` emits
  it only as a tsconfig `include` glob **string** — so `extracted/` does
  not depend on it; and a real C3 re-export that rewrites ts-defs also
  rewrites `objectTypes/`, which still bumps. The signal is not lost, only
  not sourced from an editor-generated file.
- **Site 2's blast radius is narrower than site 1's.** `SID_SOURCE_DIRS` is
  `["eventSheets", "layouts", "objectTypes"]` — no `scripts` — so only the
  `uistate` dimensions (and a stray `tsconfig.json`) are reachable in the
  freshness scan.
- **What is traded away.** `txId` conservatism: the watcher no longer
  reports every filesystem event under the watched roots. Accepted because
  an editor-local write is never a source change by definition, and any
  accompanying real change fires its own event regardless.
- **Regression coverage is synthetic temp-dir by necessity**, per ADR
  0016's precedent — the `construct3-chef-sample` fixture tracks zero
  editor-local files at every canonical tag, so a fixture-based assertion
  would pass vacuously (the same trap [#149](https://github.com/GenvidTechnologies/construct3-chef/issues/149)
  exists to close elsewhere). Tests are split one per dimension, because
  the three mechanisms are independent and a combined test could not say
  which one regressed.

## Consequences

- The observable MCP contract changes when a project is open in the C3
  editor: read tools no longer emit an unclearable stale warning, and
  `apply-recipe`/`sync-project` no longer reject on a `txId` moved by
  editor-local churn. Not semver-breaking — no exported signature changes —
  but worth a release-note line since the behavior is user-visible.
- A new off-barrel `src/c3/editorLocal.ts` holds the segment-wise predicate,
  deliberately excluded from the `src/index.ts` barrel: the repo is at
  1.0.0, and every barrel export is a permanent API commitment.
- Two sibling issues become straightforward consumers of the same helper:
  [#149](https://github.com/GenvidTechnologies/construct3-chef/issues/149)
  (`spriteScaffold.ts`, the repo's only zero-filter walk, plus two vacuous
  uistate assertions) and
  [#152](https://github.com/GenvidTechnologies/construct3-chef/issues/152)
  (`customAceIndex.ts`'s flat, unfiltered families walk). Neither is fixed
  here.
- Bears directly on
  [#14](https://github.com/GenvidTechnologies/construct3-chef/issues/14)
  (C3 Live Editor Integration): the failure mode only manifests with a live
  editor writing into the project, which is #14's premise.
