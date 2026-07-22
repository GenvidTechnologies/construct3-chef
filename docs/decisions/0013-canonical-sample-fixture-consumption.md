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
- Chef's **own** adoption — replacing its in-tree fixture with the submodule,
  writing the prep script (recipes + additive overlay + strip-list), and
  migrating golden regeneration to the materialized fixture — is deliberately
  **not** done as part of this decision and remains tracked in #130, which
  stays open.

## Consequences

- The fixture temporarily exists in two places — chef's untouched in-tree
  `test/fixtures/construct3-chef-sample/` and the canonical
  `construct3-sample` repo — until #130 migrates chef onto the submodule. A
  manual sync discipline applies in the meantime: don't hand-edit one copy
  without checking the other.
- No chef fixture bytes, generators, or tests changed as part of this
  decision; the golden test and its fixture are untouched.
- chef's own in-tree `test/fixtures/construct3-chef-sample/` still applies
  `MyCompany_MyEffect` incompletely (the project-file bug above — not an addon
  bug), so importing it into C3 null-pointers — its `fixtureLoadValidity` guard
  only runs `validateForEditor` on event sheets, not a real editor load, so it
  never caught it. Tracked as
  [#132](https://github.com/GenvidTechnologies/construct3-chef/issues/132) (which
  also flags two `validate-addons` false positives the real export exposed:
  effects legitimately ship no `aces.json`, and `usedAddons` carries the
  user-assigned instance name, not the addon's display name).
- Full consumption-mechanism rationale (rejected alternatives, the prep-script
  shape, why `c3source` is validator-not-owner) lives in
  [`construct3-sample` ADR 0001](https://github.com/GenvidTechnologies/construct3-sample/blob/main/docs/decisions/0001-consumption-mechanism.md) —
  read it there rather than expecting a copy here.
