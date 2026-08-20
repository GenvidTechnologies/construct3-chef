---
type: decision-record
title: "0023. Stray files are a detection-only `[strays]` report, called standalone"
description: >-
  C3source 2.0.0's `detectStrayFiles` surfaced as an informational `[strays]` report at the four `[images]` surfaces (2 CLI + 2 MCP), never affecting the exit code and never a sync write-back target (a stray has no manifest position and can never acquire one); called standalone rather than reading the `drift.strays` value `runSync` already drops — correcting the issue's mechanically wrong `--section`-inheritance framing of that fork — and always emitting a line on a clean project, because silence would render "no strays" and "reporter absent" identically; declines a `models3d` filter (reporting is not syncing) and `--section` narrowing (the `[images]` precedent), keeps upstream's `[strays]` term and renames the colliding chef-local test vocabulary to "untracked", caps output at 20 rows for the unpaginated MCP block, and pins that an `extractedDir` nested under a section root *is* reported ([#177](https://github.com/GenvidTechnologies/construct3-chef/issues/177))
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0023. Stray files are a detection-only `[strays]` report, called standalone

- **Status:** Accepted
- **Date:** 2026-08-14
- **Issue:** [#177](https://github.com/GenvidTechnologies/construct3-chef/issues/177)

## Context

`@genvidtech/c3source@2.0.0` — adopted in [#175](https://github.com/GenvidTechnologies/construct3-chef/issues/175),
ADR [0021](./0021-section-item-axis-does-not-reopen-walk-declines.md) — shipped
`detectStrayFiles`/`StrayFile` alongside the `.json` item policy that made
`find_all_layouts_path`/`find_all_objectTypes_path` return section items only.
The two halves are one trade: chef's ten unguarded `JSON.parse` sites stopped
crashing on a misfiled `layouts/notes.txt`, which is **quieter, not louder** —
the file is now skipped in silence. `detectStrayFiles` is the other half, and
#175 deliberately left it unadopted, tracked as #177.

Upstream owns the definition: a stray is a file under one of the seven
name-section roots (`layouts`, `eventSheets`, `objectTypes`, `timelines`,
`flowcharts`, `families`, `models3d`) that is neither a `.json` section item
nor editor-local. Its `StrayFile` deliberately carries no `manifestPath` —
a name section keys items on `<name>` derived from `<name>.json`, so a stray
has no manifest position and **can never acquire one**. It is neither
`missing` nor `untracked`; there is nothing a caller could map it to.

That single upstream fact is what shapes every decision below. This record
exists because several of them look like arbitrary style calls (why always
print a line? why not narrow by `--section`?) and are not.

## Decision

Add `reportStrayFiles(rootDir, log)` to `src/c3/projectSync.ts`, beside
`reportImageDrift`, and wire it at the four surfaces `[images]` already
reaches. Ten decisions, in the order they constrain each other.

### 1. Route — call `detectStrayFiles` directly, not `drift.strays`

`runSync` already receives a `strays` array from `detectManifestDrift` and
drops it on the floor. `reportStrayFiles` calls `detectStrayFiles(rootDir)`
standalone instead, knowingly duplicating one directory walk.

**#177's original framing of this fork was mechanically wrong, and the
correction belongs on the record** so nobody re-derives the fork from the
issue body. The issue claimed that routing through `drift.strays` would
*inherit* `runSync`'s `--section` filter. It would not: `runSync` calls
`detectManifestDrift` unconditionally with no section argument, and that
calls `detectStrayFiles` over all seven sections; `--section` filters the
**result** afterwards. The two routes produce byte-identical data.

The real trade is narrower and still favours the standalone call. Reading
`drift.strays` means emitting from inside `runSync` — which has **eight**
call sites, so the report would also appear under `scaffold-layout` and
`scaffold-sprite`, where it has no business — or permanently widening the
barrel-exported `SyncResult` to carry strays out to every caller. Against
that, the standalone call costs one extra directory walk over a tree the OS
has just cached. It also preserves **manifest-independence** (decision 10):
`detectStrayFiles` needs no `project.c3proj`, and `runSync` parses one first.

### 2. Surface count — four, not eight

The four `[images]` surfaces: CLI `validate-project`, CLI `sync-project`,
and both MCP counterparts. The four `runSync` sites *without* `[images]`
(`scaffold-layout`, `scaffold-sprite`, on both surfaces) stay silent — a
scaffold command reports what it scaffolded, not a project-wide audit.
Wiring them is a defect, and the test suite asserts against it directly.

### 3. Severity — informational, never failing

The report never affects the CLI exit code, `SyncResult.clean`, or upstream's
`ManifestDrift.inSync`. This is the `[images]` model, and it is the right one:
a stray is *frequently intentional* — a `README.md` beside a folder of object
types, a designer's scratch file. Rejected: `validate-addons`' always-fail
model, where every finding is CI-failing. That tool has no severity concept
because it gates packaging correctness, where every finding is a real defect;
a stray is not. An opt-in gate for teams that do want one is
[#183](https://github.com/GenvidTechnologies/construct3-chef/issues/183).

### 4. Clean-project output — always emit `(no strays)`

One line is always printed. The decisive reason is not symmetry with
`reportImageDrift` (though it matches): **silence would render "no strays"
and "the reporter is absent" identically.** That is the unfalsifiable-green
failure this repo has actually shipped: the vacuous `uistate` assertions that
sat green in `serverHandlers.test.ts` until [#149](https://github.com/GenvidTechnologies/construct3-chef/issues/149)
replaced them, recorded in ADR
[0019](./0019-two-walk-primitives-one-classification-rule.md). #175 is the
counter-example rather than a second instance — it *anticipated* the same shape
and designed around it, committing its synthetic `strayFileTolerance` suite red
at the old floor instead of asserting against a fixture that cannot hold a
stray. A report you cannot distinguish from a missing report is not evidence.

**This contradicted an acceptance criterion #177 originally carried** — "a
clean project's `validate-project` output is unchanged (no empty `[strays]`
header)". That criterion conflicted with the same issue's own instruction to
"mirror `reportImageDrift` exactly", which prints `(no drift)` on a clean
project. The conflict was resolved in favour of always emitting, and the
criterion was removed from the issue body during planning. Recorded here so
the removal reads as a reconciliation rather than an omission.

### 5. `models3d` — reported, though chef's sync excludes it

Upstream's seven name sections are all reported. Chef's `NAME_SECTIONS`
covers six and deliberately omits `models3d` from *sync*; reporting is not
syncing, and a misfiled file under `models3d/` is worth seeing even where
chef will never touch the manifest entry.

Filtering to chef's six would mean chef re-deriving a section list upstream
owns — the exact mistake ADR
[0016](./0016-shared-file-walk-adoption-triage.md) corrected when it found a
locally re-derived one-dimension copy of a three-dimension editor-local rule.
A test pins both halves together: `models3d/mesh.obj` is reported, *and* a
`runSync` over the same project produces no `models3d` change.

### 6. `--section` — no narrowing

The report is project-wide on both `validate-project` and `sync-project`,
whatever `--section` says. Settled by precedent rather than argument:
`[images]` already ignores `--section` today. The principle underneath is
that `--section` scopes the sync **write-back**, and a stray is never a
write-back target (decision 1's upstream fact again), so there is nothing
for the flag to scope.

### 7. Naming — `[strays]` kept; chef-local test vocabulary renamed instead

Upstream owns the term through `StrayFile`/`detectStrayFiles`, so the report
label follows it. The collision was on chef's side: `test/syncC3Proj.test.ts`
used "stray" and a `Stray.json` fixture for an *untracked event sheet* —
genuine drift with a manifest position, the precise opposite of a stray. That
vocabulary was renamed to "untracked"/`Untracked.json`, which is the term
`DriftEntry.kind` already uses. Renaming upstream's word locally to protect a
local test's word would have inverted the ownership.

### 8. Output cap — 20 rows plus a summary tail

Past 20 `! ` rows the report ends with `… and N more (M total)`. Neither MCP
tool that surfaces the report paginates — both return a single content block
— so an uncapped report on a badly misfiled project would bury the drift
output it sits beside. `STRAY_REPORT_LIMIT` is module-private (see
Consequences).

### 9. An `extractedDir` nested under a section root is reported

No filter. An `extractedDir` configured inside one of the seven roots (e.g.
`"layouts/extracted"`) has its generated `.dsl.txt`/`.idx.txt` files reported
as strays. The behaviour is pinned by a test and documented in
`wiki/reference/cli.md`, with the recommendation to keep `extractedDir` outside the
seven roots; the default `extracted/` is at the project root, so only a
non-default configuration is affected.

Upstream anticipated this case: its own canonical example of a stray is
`layouts/Level1.dsl.txt` — chef's own read-surface filename. Filtering it
would mean chef teaching upstream's classifier about chef's rendering layer,
which ADR [0006](./0006-upstream-ownership-boundary-and-adoption-posture.md)'s
boundary puts on the wrong side.

The evidence state, stated honestly: **no `construct3-chef.config.json`
exists anywhere in-repo**, so there is no real-data evidence that any project
nests `extractedDir` under a section root. The decision rests on the
documented recommendation plus decision 8's cap, which bounds the blast
radius to 21 lines if that assumption turns out to be wrong.

### 10. Manifest-independence — preserved by construction, not exploited

`detectStrayFiles` needs no `project.c3proj`, so the report *could* run on a
project whose manifest will not parse. Reporting there is out of scope for
v1: the CLI reaches `reportStrayFiles` only after `runSync`, which parses the
manifest first and throws. Decision 1's standalone route costs that
capability nothing, so the follow-up
[#184](https://github.com/GenvidTechnologies/construct3-chef/issues/184) is a
new surface rather than a rework, with `C3Project.detectStrayFiles()` as the
named seam.

## Compromise

Three things were declined. Naming them rather than counting them, per this
repo's convention:

- **The `drift.strays` route** (decision 1) — declined for the eight-call-site
  blast radius and the `SyncResult` widening, not for the `--section`
  inheritance #177 claimed. Cost accepted: one duplicate directory walk, and a
  standing invitation for a future reader to "fix" the apparent duplication.
  `reportStrayFiles`' JSDoc states the value is knowingly unread.
- **A `models3d` filter** (decision 5) — declined so chef does not re-derive a
  section list upstream owns. Cost accepted: chef reports on a section it will
  never sync, which reads as an inconsistency until you know reporting and
  syncing are different operations. The JSDoc and `wiki/reference/cli.md` both say so.
- **`--section` narrowing** (decision 6) — declined on the `[images]`
  precedent. Cost accepted: `validate-project --section layouts` prints strays
  from `objectTypes/`, which can surprise. The docs state the *why* (the flag
  scopes write-back) rather than just the behaviour.

Also traded away deliberately: **no degradation guard**. `reportImageDrift`
wraps its detector in a try/catch because `detectImageDrift` has a
domain-level throw on an unmapped image `fileType`, recoverable in-run. That
rationale does not transfer — `detectStrayFiles` only classifies basenames the
walk already read, so any failure is a filesystem failure the surrounding
drift run could not have survived either. Upstream forbids the guard
verbatim: *"Do not add a try/catch around this call; it would silently hide a
real failure rather than degrade a best-effort sub-detector."*

## Consequences

- **`reportStrayFiles` is public API at 1.0.0 the moment it ships.**
  `src/index.ts` re-exports `./c3/projectSync.js` wholesale, so the name is
  decided once: renaming it later is a MAJOR bump, per CLAUDE.md's
  module-system-gotchas section. `STRAY_REPORT_LIMIT` stays **module-private**
  for exactly that reason — a tuning constant should not become a supported
  symbol.
- The `[strays]` label column matches `[images]`' `padEnd(16)` rendering, and
  the CLI and MCP outputs are byte-identical because both call the one shared
  formatter — ADR
  [0004](./0004-dual-surface-shared-library-and-formatters.md)'s rule applied
  again.
- Two follow-ups are open and neither is finish-quality of this change:
  [#183](https://github.com/GenvidTechnologies/construct3-chef/issues/183)
  (`--fail-on-strays`, an opt-in CI gate — a new flag plus new exit semantics)
  and
  [#184](https://github.com/GenvidTechnologies/construct3-chef/issues/184)
  (report strays on an unparseable `project.c3proj`, via
  `C3Project.detectStrayFiles()`).
- The quieting introduced by #175's item policy is now offset at the two
  surfaces that exist to report on project state, and only there. A stray that
  used to crash a run, then silently vanished from one, is now a visible line
  that fails nothing.
