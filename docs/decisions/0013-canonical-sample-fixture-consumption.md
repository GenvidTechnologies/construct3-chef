# 0013. Canonical sample fixture: chef as prototype consumer

- **Status:** Accepted
- **Date:** 2026-07-21
- **Issue:** [#130](https://github.com/GenvidTechnologies/construct3-chef/issues/130)

## Context

`test/fixtures/construct3-chef-sample/` was the fullest real C3 export across
the org's C3 tools, so it seeded a new canonical fixture repo,
[`GenvidTechnologies/construct3-sample`](https://github.com/GenvidTechnologies/construct3-sample),
at commit `c489193` (first tag `v0.1.0`) — making construct3-chef the
prototype/superset consumer for this effort. The multi-repo consumption
mechanism (a standalone golden repo consumed as a git submodule; `c3source` as
validator, not owner; each consumer materializing a gitignored working fixture
from the submodule plus a local delta) was worked out jointly with
[c3source#51](https://github.com/GenvidTechnologies/c3source/issues/51) and is
recorded canonically in that repo's own decision record, not here:
[`construct3-sample` ADR 0001](https://github.com/GenvidTechnologies/construct3-sample/blob/main/docs/decisions/0001-consumption-mechanism.md).

## Decision

This ADR is chef's pointer to that canonical record, plus chef's own
consumer-side stance:

- The canonical bytes live in `construct3-sample`, seeded from chef's in-tree
  fixture and then **round-tripped through the C3 editor (r49500)** so the export
  is genuinely editor-authored, not hand-assembled. The manual import checkpoint
  earned its keep: it caught that #125 applied `MyCompany_MyEffect` *incompletely*
  in the project files — referenced in `effectTypes[]` but without the per-instance
  `effects` data a real editor application writes — so the **project** null-pointered
  on load. (The addon itself is fine — the identical package loads correctly in the
  editor; the bug is the project's incomplete application, not the effect.) Re-applying
  it in the editor and re-saving authored the complete data. No hand-curation remains
  in the seed.
- Chef's **own** adoption — replacing its in-tree fixture with the submodule
  and migrating golden regeneration to the materialized fixture — has since
  shipped (branch `feat/adopt-canonical-fixture-submodule`; #130). The shipped
  shape is **overlay-only**, not the "recipes + additive overlay + strip-list"
  the original #130 issue body anticipated — there was no drift needing a
  recipe layer or a strip-list, so both are absent (empty strip-list, in
  effect):
  - a submodule at `test/fixtures/construct3-sample`, pinned to tag `v0.7.0`;
  - `scripts/prep-fixture.mjs`, a pure `fs.cpSync` of the submodule's
    `project/` tree over `test/fixtures/construct3-chef-sample/`, self-initing
    the submodule first (`git submodule update --init`) — **load-bearing**,
    since the shared `public-github-actions/node-gate.yml` gate checks out no
    submodules by default;
  - wired as the `pretest`/`pretest:file` npm hook, so `npm test` and
    `npm run test:file` materialize the fixture automatically, locally and in
    CI;
  - an Option-A in-place `.gitignore` negation stanza (`/test/fixtures/construct3-chef-sample/*`
    plus `!`-reincludes) keeping a 17-file chef-local overlay tracked: the
    12-file `extracted/` golden read-surface, `archive-sources/MyCompany_MyEffect/*`
    (4), and `build-archive.mjs` (1). **Since
    [#139](https://github.com/GenvidTechnologies/construct3-chef/issues/139) the
    overlay is the 12-file `extracted/` golden only** — see Consequences.

## Consequences

- The two-copy interim state this ADR originally flagged is over: chef's
  in-tree fixture is now materialized from the submodule rather than
  hand-maintained alongside it, so the "don't hand-edit one copy without
  checking the other" discipline no longer applies — there's one canonical
  copy (the submodule) and one generated materialization (gitignored, rebuilt
  by `fixture:prep`).
- The golden test and its fixture bytes are unchanged in kind (still
  `extracted/` diffed byte-for-byte against a committed golden), but the
  golden was regenerated against the `v0.7.0` pin and the golden-regen flow
  now requires `npm run fixture:prep` before `generate` if the fixture hasn't
  just been materialized by the test suite.
- [#132](https://github.com/GenvidTechnologies/construct3-chef/issues/132)
  item 1 (the incomplete `MyCompany_MyEffect` application that null-pointered
  the project on import) is **fixed** by adopting the `v0.2.0` canonical
  fixture (the pin at the time; the pin has since moved) — the editor-authored
  application now round-trips cleanly. Items 2–3 (two `validate-addons` false
  positives the real export exposed: effects legitimately ship no `aces.json`,
  and `usedAddons` carries the user-assigned instance name, not the addon's
  display name) are separate and remain open.
  Note the effect application **changed**, not merely completed: the
  editor-authored version applies at three sites named `"MyCustomEffect"`
  (Sprite2 objectType, TextFamily family, Second Layout's layer 1), versus the
  retired hand-authored four sites named `"My custom effect"` (which also
  covered a layout-stack site and a nested sublayer 1.1.1); the effect-scanner
  tests were re-baselined to the real values, with recursive `subLayers`-walk
  coverage preserved via a synthetic temp-dir test.
- ~~A known, tracked deferral: `archive-sources/` and `build-archive.mjs` stay a
  chef-local overlay for now~~ — **resolved by
  [#139](https://github.com/GenvidTechnologies/construct3-chef/issues/139)**
  (pin `v0.3.0`). Both bundled addons turned out to be verbatim Construct SDK
  samples, so their sources and the script that zips them moved into
  `construct3-sample`, whose ADR 0001 was narrowed from a file-type exclusion
  ("never fixture-build tooling") to the **provenance** rule it always meant:
  the canonical repo owns what comes from the C3 editor or the official SDK,
  never hand-authored data and never a *consumer's* rendering. Chef's overlay is
  now the 12-file `extracted/` golden only.

  The resolution went further than "move the copy": canonical now **gates** every
  shipped `.c3addon` against its `archive-sources/` tree, a guarantee neither
  repo previously made. The comparison is **content**-equivalence (entry-name set
  + per-entry bytes), not archive bytes — a `.c3addon` is just a zip with no
  official builder, so the container is not normative (the two shipped packages
  were made by different zip tools and differ in entry order, directory entries
  and timestamps).

  Chef still needs `archive-sources/` **on disk inside the fixture root**, since
  the `scan-addon-usage` blast-radius tests pass it as an extracted-addon-dir
  `--from` and `resolveAddonTarget` containment-guards that with
  `resolveWithin(projectRoot, …)`. `prep-fixture.mjs` therefore materializes it
  from the submodule beside `project/`, which kept the test path unchanged — the
  adoption needed no test edits at all.
- A known limitation of the copy-only prep script: it never deletes, so a
  canonical pin that *removes* a file leaves the stale copy on disk
  (gitignored, invisible to `git status`). The reset is
  `git clean -fdX -- test/fixtures/construct3-chef-sample/` before re-running
  `fixture:prep` — unconditionally, per the next bullet, not only at a pin that
  removes something.
- Copy-only materialization accumulates leftovers **across pins**, which is the
  wider case: at the `v0.3.0`→`v0.7.0` bump the materialized fixture still
  carried 14 pre-#130 `*.uistate.json` files that the canonical repo has
  **never tracked at any tag** (its `project/.gitignore` excludes them). They
  were harmless to the golden — nothing generates from them — but they made
  `CLAUDE.md`'s fixture-shape prose factually wrong (it claimed editor-local
  `uistate/` at two levels, when the fixture has neither those directories nor
  the files) and made two `serverHandlers` uistate assertions pass
  **vacuously**. `git clean -fdX -- test/fixtures/construct3-chef-sample/` is
  therefore an **unconditional step 0** of the update protocol, verified with
  `npm run fixture:verify` (`scripts/verify-fixture-parity.mjs`: no
  `*.uistate.json`, no `uistate/` dirs, exactly 12 tracked overlay files, and a
  recursive path-set + byte compare of the submodule's `project/` tree against
  the materialization). The `extracted/` golden is structurally safe from that
  clean: `.gitignore:19` ignores `/test/fixtures/construct3-chef-sample/*` with
  `/*`, not `/**`, so the `!…/extracted/` negation on `:20` un-ignores the whole
  subtree. A useful corollary: a 13th file generated into `extracted/` shows up
  as untracked in `git status`, which is a second, independent guard on the
  golden file set.
- Full consumption-mechanism rationale (rejected alternatives, the prep-script
  shape, why `c3source` is validator-not-owner) lives in
  [`construct3-sample` ADR 0001](https://github.com/GenvidTechnologies/construct3-sample/blob/main/docs/decisions/0001-consumption-mechanism.md) —
  read it there rather than expecting a copy here.
