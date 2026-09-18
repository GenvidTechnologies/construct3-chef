---
type: decision-record
title: "0041. § Releasing is overrides and repo-only facts, not a runbook"
description: >-
  `CLAUDE.md` § Releasing stops being a standalone manual procedure and
  becomes a set of repo-specific overrides plus facts the
  `gvt-dev:release-npm-package` skill cannot infer, deferring the procedure
  to that skill. Resolves the apparent deadlock between "exactly one page
  owns a given fact" and `CLAUDE.md` being the only always-loaded surface:
  a *delta* is not a duplicate, so the numbered list survives as a list but
  changes kind. The authority clause is phrased as a duty on the operator
  because the skill reads this file for the commit-message format alone.
  Declines a `wiki/process/releasing.md` page (a third location for one
  procedure), exemption prose (there is nothing left to exempt), and a
  guard (every candidate oracle lives outside the repo)
  ([#230](https://github.com/GenvidTechnologies/construct3-chef/issues/230))
tags: [decision, process, docs, release]
status: stable
generated: { by: process:tech-writer, at: 2026-09-18T00:00:00Z }
---

# 0041. § Releasing is overrides and repo-only facts, not a runbook

- **Status:** Accepted
- **Date:** 2026-09-18
- **Issue:** [#230](https://github.com/GenvidTechnologies/construct3-chef/issues/230)

## Context

`CLAUDE.md` § Releasing was authored as a four-step manual runbook in
`9a64310` (2026-05-31, "docs: document the release/publish flow in
CLAUDE.md"). The `gvt-dev:release-npm-package` skill — which owns exactly
that procedure, for exactly this repo's OIDC trusted-publishing recipe —
landed upstream three days later, in gvt-dev 2.2.0 (2026-06-03). The prose
predates the skill and was never revisited.

So this is **not** slow drift accumulating over many edits. It is a single
never-reconciled event: two descriptions of one procedure, written days
apart, each maintained as though it were the only one. Nothing in this repo
reads § Releasing (see Consequences), so nothing could have detected the
divergence, and by the time #230 was filed the skill's runbook had moved on
in ways the prose did not record.

## Decision

Recast § Releasing as **repo-specific overrides plus facts the skill cannot
infer**, with the procedure deferred to `gvt-dev:release-npm-package` by
name. The section opens by naming the skill as the owner and stating that it
is deliberately not a second copy of the runbook.

### A delta is not a duplicate

The apparent deadlock is worth recording, because it is what a future editor
will hit first. `CLAUDE.md` states that **exactly one page owns a given
fact**, and calls a second copy the drift trap — the rule ADR
[0028](0028-documentation-consolidated-into-the-wiki-tier.md) established
when the `docs/` tier was retired. But `CLAUDE.md` is the **only**
always-loaded surface: the skill is not loaded unless it is invoked, and
`wiki/` is explicitly not auto-loaded either. "Delete the duplicate" and
"keep the release procedure reachable" therefore appear to pull in opposite
directions.

They do not, and the resolution is one sentence: **that rule governs
*facts*, and a delta is not a duplicate.** An override has exactly one owner
by construction — the thing it overrides lives elsewhere, and the override
itself lives only here. So the numbered list survived *as a list* but changed
**kind**: from a procedure someone follows to a set of deviations someone
applies on top of the procedure the skill runs.

### The authority clause is an obligation on the operator

§ Releasing says that where it and the skill disagree, this section wins.
That sentence is phrased as a duty on **whoever runs the skill**, not as a
description of the skill's behaviour, and the distinction is load-bearing:
`release-npm-package`'s skill body mentions `CLAUDE.md` once, for the
commit-message format, and for nothing else. It does not read this section.

The known conflicts resolve differently, and that asymmetry is deliberate:

- **Branch discipline — the operator must apply this.** The skill's runbook
  branches on branch-protection status. `main` here carries none (verified),
  so left to itself the skill would push the release commit straight to
  `main`, which § Branching forbids. Nothing mechanical catches that; a human
  applying the override is the only thing standing between the runbook and a
  direct-to-`main` push.
- **`chore: release` casing — the skill resolves this itself.** Its built-in
  fallback capitalizes `Release`, which conflicts with § Commit Format's
  imperative-lowercase rule. Because the commit-message format is the one
  thing the skill *does* read from `CLAUDE.md`, it picks the repo's casing up
  without help. This is a latent fallback conflict, not a live hazard.

Collapsing these into one undifferentiated "this section wins" is the failure
mode the phrasing exists to prevent: a reader who saw only that sentence
would reasonably assume the branch override is picked up automatically, the
way the casing one is. It is not.

## Rejected alternative: additive (keep the steps as a runbook, append an authority sentence)

This was the cheapest possible edit — leave the runbook intact and prepend a
disclaimer naming the skill. It was rejected because **numbered imperative
steps read as authoritative regardless of what precedes them**. A reader who
skips the disclaimer (or who arrives mid-section, which is how
an always-loaded file is actually read) works the steps, which is precisely
the shape that produced #230 in the first place. It also would have required
the exemption prose declined below, since under the additive option a full
runbook really would be sitting in a file whose own rule routes
documentation-shaped content to `wiki/`.

A further shape — **full defer**, deleting the numbered steps entirely and
leaving only a pointer — was never live. The branch-discipline override lives
*inside* those lines, so deleting them would delete the thing that most
needed saying.

## Declined: a `wiki/process/releasing.md` page

The natural-looking move, given this repo routes everything
documentation-shaped into `wiki/`. It is wrong here because the procedure is
now owned by a **skill**, not by any page in this repo. A wiki page would
create a *third* location for one procedure — skill, wiki page, `CLAUDE.md`
pointer — which is strictly worse than two, and is a fresh instance of the
very drift trap the one-owner rule warns about. The routing rule assumes the
alternative home is a wiki page; when the real owner is upstream, the rule's
premise does not hold.

## Declined: exemption prose

An earlier framing would have added a sentence claiming § Releasing is exempt
from the route-everything-to-`wiki/` rule. Under this design **there is
nothing to exempt**: what remains after the recast is operating context —
overrides and repo-only facts — which is exactly what that rule says this
file should keep.

Writing the exemption anyway would do two bad things. It would assert a
carve-out the section no longer needs, and it would hand a future editor
licence to re-grow the runbook under cover of it ("§ Releasing is exempt, so
this expansion is fine"). **The absence of exemption prose is what keeps the
section honest.** Note that this flips under the rejected additive option,
which would have needed the exemption — another reason the two decisions are
coupled rather than independent.

## Declined: a guard

Not because a P3 documentation issue doesn't earn one, but because **every
candidate oracle lives outside the repo.**

This repo's guard precedents all have in-tree oracles: `retiredOrgLinks.test.ts`
matches a URL form against the tree, `readmeCommandInventory.test.ts` derives
its expectation from `GENERATORS`, and the wiki-bundle tests compare indexes
against generator output. None of that shape is available here:

- A test asserting `CLAUDE.md` names `gvt-dev:release-npm-package` passes
  forever the moment this lands, and stays green through the drift that
  actually matters — an upstream rename or a runbook change. The skill body
  is not in this tree, and the plugin cache path is version-pinned and
  transient, so citing it is forbidden.
- A test asserting the publish-workflow paragraph matches reality would have
  to re-encode the sentence it checks, because the authority is
  `node-gate.yml` in `public-github-actions`, fetched at run time and absent
  from this checkout.

**A guard that cannot see the thing that drifts is decorative** — and worse
than nothing, because a green test manufactures confidence about a question
it never asked. The durable fix is upstream, recorded under Consequences.

## Folded in: the publish-workflow gate correction

The same commit corrects a false claim in the paragraph below the steps. It
stated that the tag path's gate job runs `npm ci` + lint/typecheck/test/build
+ `publish --dry-run`. The dry-run half is false in two independent ways:
`publish.yml` calls the shared `node-gate.yml` recipe with **no `with:`
block**, so `dry-run` defaults false and that step is skipped entirely; and
while `ci.yml` does pass `dry-run: true`, the step there carries
`continue-on-error: true` and so cannot fail a gate either.

The correct statement, now in the file, is that **no packaging check gates
either path**. This was folded into the ownership-split commit rather than
filed separately because it lived inside one of the two lines the edit was
already rewriting — splitting it would have meant two commits touching the
same line for unrelated reasons.

## Consequences

- **Nothing gates this section.** § Releasing is not one of
  `CONVENTIONS.md`'s contract sections (`Commit Format`, `Pull Request
  Format`, `Branching`, `Agent Dispatch Guide`); `release-npm-package`
  declares no `CLAUDE.md` expectation in its `metadata.expects`; and
  `npm run lint` covers no `.md` file. No audit, lint, test, or hygiene
  scanner reads this section. The pre-commitment checklist on #230 was the
  entire gate, and a future `/plugin update` can silently reopen the
  divergence with nothing going red.
- **A follow-up is planned** against
  [`GenvidTechnologies/claude-code-plugin-gvt-dev`](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev):
  have `release-npm-package` declare `CLAUDE.md` in `metadata.expects.files`
  with `required: false`, making the coupling visible to
  `audit-conventions`. It is **not filed yet** and carries no issue number.
  That is the durable replacement for the guard declined above — it puts the
  oracle where the thing that drifts actually lives.
- **The heading `### Releasing` is now hard-pinned**, and two of its inbound
  references are prose name-matches that no anchor checker can see:
  `CLAUDE.md`'s own "Public-API surface = the `src/index.ts` barrel" bullet
  (a markdown anchor, `#releasing`), the `#74` history note in
  [`wiki/reference/generators.md`](../reference/generators.md), and the
  downstream-pin-bump note in ADR
  [0034](0034-mcp-server-multi-project-support.md). All are section-level
  references, so renumbering or re-ordering the steps stays safe; renaming
  the heading does not.

## Related

- ADR [0028](0028-documentation-consolidated-into-the-wiki-tier.md) — the
  one-owner-per-fact rule this decision applies, and the routing rule whose
  premise does not hold when the owner is an upstream skill.
- `CLAUDE.md` § Branching and § Commit Format — the two sections the release
  overrides defer to; they are what makes the branch-discipline and
  commit-casing conflicts conflicts at all.
