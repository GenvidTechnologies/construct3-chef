---
type: decision-record
title: "0039. Changelog Notice is a separate advisory workflow, deny-list gated"
description: >-
  A new `.github/workflows/changelog-notice.yml`, triggered on `pull_request`
  (including `edited`), runs a pure `decide()` from
  `scripts/changelog-notice.mjs` to flag a PR that carries a user-visible
  change with no `[Unreleased]` CHANGELOG entry and no mandatory-reason
  opt-out. "User-visible" is a deny-list (transferring ADR 0038's reasoning):
  gated unless the Conventional-Commit type is `docs`/`style`/`test`/`chore`
  AND the PR touches no file under `src/`; a `!` breaking marker gates
  unconditionally. Declines a test inside the shared `node-gate.yml` gate
  (that gate's checkout can't diff a change) and declines
  `@changesets/cli`/`conventional-changelog` (this repo's changelog is
  hand-curated editorial prose, not generated)
  ([#218](https://github.com/GenvidTechnologies/construct3-chef/issues/218))
tags: [decision, process, ci, changelog]
status: stable
generated: { by: process:tech-writer, at: 2026-09-17T00:00:00Z }
---

# 0039. Changelog Notice is a separate advisory workflow, deny-list gated

- **Status:** Accepted
- **Date:** 2026-09-17
- **Issue:** [#218](https://github.com/GenvidTechnologies/construct3-chef/issues/218)

## Context

`CHANGELOG.md` is hand-curated (see its own header note on reconstruction and
editorial grouping), and nothing enforces that a PR carrying a user-visible
change actually adds an `[Unreleased]` bullet. Issue #218 asks for a CI signal
that catches the omission before merge rather than after, when reconstructing
the entry from git history is more expensive.

## Decision

Ship a separate `.github/workflows/changelog-notice.yml`, triggered on
`pull_request` with `types: [opened, synchronize, reopened, edited]`, running
one step that invokes `scripts/changelog-notice.mjs --base-ref HEAD^1 --title
"$PR_TITLE" --body "$PR_BODY"`. The script's `decide()` function is the pure
decision engine, unit-tested in mocha (`test/changelogNotice.test.ts`) against
a committed 30-commit historical fixture
(`test/data/changelog-signal-history.json`) built by the survey tool
`scripts/changelog-signal-survey.mjs`. The test file's own row/gated/flagged
counts are the authority for the fixture's shape; this record doesn't restate
them.

### "User-visible" is a deny-list

A change is user-visible — and therefore gated, requiring either a new
`[Unreleased]` bullet or an opt-out — **unless** its Conventional-Commit
`type` is one of `docs`/`style`/`test`/`chore` **and** it touches no file
under `src/`. A `!` breaking marker gates unconditionally, regardless of type
or paths touched. An unparsable subject (no recognizable `type: ` prefix)
also gates by default, the same direction as an unrecognized type.

This transfers ADR [0038](0038-validate-addons-deny-list-family-gating.md)'s
reasoning verbatim rather than re-deriving it: an allow-list of "which types
require an entry" would silently stop gating any commit type introduced after
the list was written (a `perf:` type added to the project's vocabulary next
month, for instance) — no error, no warning, just a CI run that quietly stops
asking about the new type. A deny-list of "which types are exempt" has the
opposite failure direction: a new type gates by default, and a team notices
and can choose to add it to the exemption list, which is a report a human
reads and acts on rather than a silent stop.

### Opt-out

`Changelog: none — <reason>` in the PR body exempts a gated PR, with the
reason mandatory (`OPTOUT_RE` in `changelog-notice.mjs` requires the capture
group to start with a non-whitespace character, so a bare `Changelog: none`
or a dash followed only by whitespace still gates). Because GitHub's
squash-merge preserves the PR body as the squash commit body, a waiver
survives in git history and is recoverable via `git log --grep`.

## Rejected alternative 1: a mocha test inside the shared `node-gate.yml` gate

This is the alternative a future author is most likely to propose, because it
looks nearly free: the shared gate already runs `npm run test`, and three
precedents already assert doc/repo invariants from inside it —
`test/wiki/wikiBundle.test.ts`, `test/retiredOrgLinks.test.ts`, and
`test/readmeCommandInventory.test.ts`.

It cannot work here, and the reason is structural rather than a matter of
effort: all three precedents assert **tree-only** invariants — properties of
the checked-out state, computable with no reference to what changed to
produce it. This check is about a **change**: whether *this PR* added an
entry relative to its base. The shared gate's checkout is depth-1 with no
tags (a deliberately thin checkout for a gate that runs on every push), the
`pull_request` event's test payload carries no changed-files list a mocha
process could read, and the base commit object is absent, so `git diff
HEAD^1 HEAD` fails outright. The nearest change-free fallback — "fail if
`[Unreleased]` is empty" — was tried against the historical fixture and
catches only **1 of the fixture's flagged rows**, because it is a *state*
check standing in for a *change* check: it can only ever detect the case
where `[Unreleased]` has been empty since the last release, not the case
where a PR added unrelated content to `[Unreleased]` without adding its own
entry, which is the actual regression shape #218 exists to catch.

## Rejected alternative 2: `@changesets/cli` / `conventional-changelog`

Both tools *generate* changelog content from commit metadata. This repo's
`CHANGELOG.md` is hand-curated editorial prose — a reconstructed-history
preamble, a scope-change callout, issue and ADR cross-links woven into each
entry — not a mechanical rendering of commit subjects. Adopting either tool
would mean replacing that editorial layer with generated text, which is a
different (and much larger) change than #218 asks for.

The regression case that motivated #218, commit `9e3b3d8`, makes the
irony concrete: its commit *subject* (`feat!: MCP server multi-project
support (N roots, per-call project selector)`, the exact string T1 in
`test/changelogNotice.test.ts` decides against) was already a perfectly
good Conventional Commit subject. Generating a changelog entry from it would
not have helped — the entry was missing, not malformed. Flagging the absence
of curated prose, as this decision does, is the correct target; generating a
substitute for curated prose is not.

## Two things learned during implementation, not known at design time

### (a) The deny-list is unobservable against the repo's own history

The design predicted that mutating `decide()`'s deny-list into an allow-list
would flip T3 (a synthetic `perf:` commit, a type present in none of the
30 fixture rows) green→red and T2 (the fixture itself) green→red as well —
i.e. that the fixture would demonstrate the allow-list's danger empirically.
**That is provably impossible, and was measured rather than assumed.** For
every Conventional-Commit type actually present in the 30-commit window —
`chore`, `docs`, `feat`, `feat!`, `fix`, `refactor`, `style` — an allow-list
naming exactly the exempt set's complement and a deny-list naming the exempt
set produce **identical** verdicts on every row: a type that's genuinely
exempt gates the same way under both, and every other row gates only via the
unchanged `src/`-touch override, which neither list shape affects. The two
rules can diverge only on a type in *neither* list — and no such type occurs
in this window.

The mutation run confirmed this directly: flipping the deny-list to an
allow-list yielded **17 passing / 1 failing**, with only T3's synthetic
`perf:` input flipping. T2's entire 30-row fixture stayed green under the
mutation.

Two consequences worth recording plainly:

- The deny-list's value is **entirely forward-looking** — robustness against
  a commit type this window has never seen, not a property demonstrated by
  any commit this repo has actually made. This was the stated design
  rationale (ADR 0038's reasoning, transferred); it is now measured rather
  than assumed.
- **T3's synthetic `perf:` case is the only discriminator in the whole
  suite** for this property. T2 is not a mutation control for it — a future
  editor who deletes T3 as "redundant with the fixture" would leave the
  deny-list's forward-looking guarantee completely unguarded, with nothing
  in the suite going red to signal it.

### (b) `shell: bash` in the workflow step is load-bearing, not stylistic

The step pipes the script's stdout through `tee -a` to also write
`$GITHUB_STEP_SUMMARY`. GitHub Actions' default `run:` shell on
`ubuntu-latest` is `bash -e {0}` — **without** `pipefail`. Under that default,
`node scripts/changelog-notice.mjs … | tee -a "$GITHUB_STEP_SUMMARY"` reports
the exit status of `tee`, not of `node`, so a flagged (exit-1) verdict would
be swallowed and the check would report green unconditionally, forever.
Declaring `shell: bash` explicitly selects `bash --noprofile --norc -eo
pipefail {0}`, which propagates the pipeline's failing command. This was
verified directly rather than inferred from GitHub's docs: `false | tee`
exits 0 under `bash -e` and exits nonzero under `bash -eo pipefail`.

## Consequences

- **Starts red, no `continue-on-error`.** There is no branch protection on
  `main`, so a red check on this workflow blocks nothing structurally; a
  neutral (always-green) check is one nobody reads. If the red X proves
  louder than useful in practice, the one-word de-escalation is adding
  `continue-on-error: true` to the step — recorded here so it doesn't need
  re-deriving later.
- **Declined tightening 1: adding `package.json` to `MATERIAL_PATHS`.** This
  would drag every `chore: release X.Y.Z` PR into the gated set — exactly the
  PR whose purpose is to *empty* `[Unreleased]` by moving its bullets under a
  new version heading, so it would need a release-specific carve-out to avoid
  false-flagging every release. Declined until a concrete need for it
  appears.
- **Declined tightening 2: making the `!` breaking marker non-waivable** (no
  opt-out allowed at all for a breaking change). A hard-blocked path with no
  escape hatch is exactly the shape that generates pressure to delete the
  check entirely rather than fix the underlying PR, per this repo's own
  experience with severity-less gates (see ADR 0038's `#132` history).
- **Known, accepted blind spot:** a dependency floor bump typed `chore:`
  that touches only `package.json`/`package-lock.json` is not gated (chore
  is exempt, and neither path starts with `src/`). Historically such bumps in
  this repo have been typed `feat:` or have touched `src/`, so the 30-commit
  fixture contains no example of this blind spot actually occurring — it's a
  recorded gap, not a demonstrated regression.
- **The `HEAD^1` assumption.** `--base-ref HEAD^1` relies on a `pull_request`
  event checking out the ephemeral two-parent merge commit, where `HEAD^1` is
  the PR's target-branch tip. This holds for the trigger types configured
  here (`opened`, `synchronize`, `reopened`, `edited`) but would need
  revisiting if the workflow's `on:` block ever expands to a trigger type
  with different checkout semantics (e.g. `merge_group`).
- **`fetch-tags: true` is set explicitly**, not left to `fetch-depth: 0`'s
  implicit behavior, because the script's `--check-tags` mode
  (`checkLinkRefs`) needs `git tag -l` to return real tags. Its necessity is
  only observable on the first live run against a real PR, since it can't be
  exercised by the local mocha suite.
- **The link-ref invariant is split by what it can check without a live
  checkout.** Section-heading ↔ link-reference correspondence in
  `CHANGELOG.md` is a pure file read and is covered by the mocha suite
  (`checkLinkRefs` in `scripts/changelog-notice.mjs`, tested in
  `test/changelogNotice.test.ts`). Whether each referenced tag actually
  exists needs `git tag -l`, which the shared gate's shallow checkout doesn't
  provide, so that half runs only in this workflow's `--check-tags` mode. Its
  in-flight skip — treat the tag matching the current `package.json` version
  as neither checked nor dangling — encodes the window between a version-bump
  merge and its tag push, a window that recurs at **every** release, not a
  one-off workaround for whatever version happens to be untagged today.

## Related

- ADR [0038](0038-validate-addons-deny-list-family-gating.md) — the
  deny-list-over-allow-list reasoning this decision transfers rather than
  re-derives.
- `test/changelogNotice.test.ts` — the authoritative row/gated/flagged counts
  for the historical fixture; not restated here.
- `scripts/changelog-notice.mjs` — the decision engine and its own header
  comment, which points back at this record.
