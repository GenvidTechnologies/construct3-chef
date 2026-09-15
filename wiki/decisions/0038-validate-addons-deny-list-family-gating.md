---
type: decision-record
title: "0038. `validate-addons` exit-code gating is a deny-list, not an allow-list"
description: >-
  `validate-addons` gains `--skip-gate <families>`: a comma-delimited
  deny-list over four structural finding families (metadata, integrity,
  package-consistency, lang) that exempts a named family from the CLI exit
  code while never removing its findings from the report. All four families
  gate by default, so no existing CI invocation changes behavior. Inverts
  issue #220's first-preference allow-list (`--fail-on <families>`) because
  an allow-list silently stops gating any family added after it's written —
  #220's own triage note demonstrates the failure with the very families in
  scope today. Relaxes the "drop, don't downgrade" constraint CLAUDE.md
  records for #132, since selectable fatality now exists where it didn't
  then. MCP gets the shared per-family summary but no gate parameter — it has
  no exit code for a parameter to control
  ([#220](https://github.com/GenvidTechnologies/construct3-chef/issues/220))
tags: [decision, architecture, cli, addons]
status: stable
generated: { by: process:tech-writer, at: 2026-09-15T00:00:00Z }
---

# 0038. `validate-addons` exit-code gating is a deny-list, not an allow-list

- **Status:** Accepted
- **Date:** 2026-09-15
- **Issue:** [#220](https://github.com/GenvidTechnologies/construct3-chef/issues/220)

## Context

`validate-addons` (`src/c3/addonValidator.ts`) has no severity concept.
`AddonFinding.kind` is an eight-value union —
`metadata-mismatch`, `integrity`, `orphan`, `missing`, `duplicate`,
`lang-missing-ace`, `lang-missing-param`, `lang-missing-property` — and the
CLI handler fails the run the same way for all eight: `if
(result.findings.length > 0) process.exitCode = 1;`. There is no way to run
the check in a mode that reports but doesn't gate on one class of finding.

Issue #220 reports that in practice this makes the check unusable as a CI
gate for a project that legitimately carries a large, slow-to-fix backlog of
one finding kind. A production project reported by the issue author found
its findings were overwhelmingly the `lang` family (an addon's ACE/property
surface drifting from one of its shipped locale files) — enough to make a
zero-tolerance gate impractical to adopt without first burning down an
unrelated backlog. This repo's own in-tree fixture reproduces the same
*shape* at small scale and can be re-run by anyone:
`test/fixtures/construct3-chef-sample` reports 3 findings, all 3 `lang`,
exit 1 — the entire run fails over a family a team might reasonably want to
report on without gating.

The eight `kind` values group into four families, and the grouping is
structural rather than editorial — each family maps to one emitting region
of the codebase:

| Family | `kind` values | Emitted by |
|---|---|---|
| `metadata` | `metadata-mismatch` | `checkMetadataMismatch` (`addonValidator.ts`) |
| `integrity` | `integrity` | `checkIntegrity` (`addonValidator.ts`) |
| `package-consistency` | `orphan`, `missing`, `duplicate` | the `validateAddons` body (`addonValidator.ts`) |
| `lang` | `lang-missing-ace`, `lang-missing-param`, `lang-missing-property` | `addonLangValidator.ts` (a separate module) |

Two other fixtures corroborate the families are independent in practice, not
just in code structure: `test/fixtures/addon-validate` reports 8 findings
across metadata, integrity, and package-consistency with zero lang findings;
`test/fixtures/addon-validate-lang` reports 4 findings, all lang variants.
A project can carry a backlog in one family and be clean in the other three.

## Decision

Ship `validate-addons --skip-gate <families>` on the CLI: a comma-delimited
**deny-list** naming which of the four families listed above are exempt from
the exit code. The default is empty — **all four families gate**, matching
today's behavior exactly, so no existing CI invocation changes outcome
without an explicit opt-in.

A family named in `--skip-gate` is exempt from setting `process.exitCode =
1`, and **only** from that. Its findings are never dropped, filtered, or
demoted out of the report — `formatAddonValidation`'s output is identical
with or without `--skip-gate`; only the process exit code differs. A team
adopts `--skip-gate lang` to gate CI on metadata/integrity/package-consistency
while still seeing every lang finding printed on every run, as the visible
signal to burn the backlog down.

Family classification and gating both live in `addonValidator.ts`, next to
the four emitting regions in the table above, and render through the single
existing `formatAddonValidation` call both the CLI and MCP tool already
share — no new rendering path. The CLI handler's exit-code check narrows from
"the finding array is non-empty" to "the finding array contains a finding
whose family is not in the skip-set."

### MCP gets the summary, not the parameter

The MCP `validate-addons` tool (`src/mcp/server.ts`) gains the same
per-family summary in its rendered output, because it flows through the same
`formatAddonValidation` call. It does **not** gain a `--skip-gate`-equivalent
input parameter. `CLAUDE.md`'s rule that a capability lives in `src/c3/` and
surfaces on both the CLI and MCP is satisfied here by the shared rendering,
not by parameter parity: the MCP tool has no exit code, so there is nothing
for a gate parameter to control on that surface. Inventing one would add
vocabulary — "which families are fatal" — that no MCP caller can act on,
since an MCP response has no analogous pass/fail signal to withhold. This is
a deliberate asymmetry, not an oversight: the two surfaces stay aligned on
*what is reported*, and diverge on *what gates*, because only one of them has
a notion of gating at all.

## Rejected alternative: an allow-list (`--fail-on`)

Issue #220 itself proposed and ranked first an **allow-list** shape:
`--fail-on metadata,integrity,package-consistency`, naming the families that
*should* gate rather than the ones that shouldn't. This ADR inverts that
ranking and ships the deny-list instead.

The issue's own triage note is the reason, and it is worth stating precisely
rather than summarizing: `--fail-on metadata,integrity` (dropping
`package-consistency` from the list by omission, not by intent) would
**silently** stop gating the package-consistency family — no error, no
warning, just a CI run that now passes over orphan/missing/duplicate addon
findings it used to fail on. That is not a spelling mistake a careful author
could avoid; it is structural to how an allow-list behaves under change. The
day a fifth family is added to `addonValidator.ts` — a real possibility,
this cluster has grown families before — **every existing `--fail-on`
invocation in every consuming CI config silently stops gating the new
family**, because none of them named it. Nothing signals the gap: the flag
still parses, the command still runs, the exit code is still meaningful for
the families it does know about.

A deny-list has no such failure mode. A new fifth family is, by construction,
absent from every existing `--skip-gate` list, so it gates by default
everywhere, immediately, with no config change required anywhere. An
existing `--skip-gate lang` invocation keeps meaning exactly what it meant
before the fifth family existed.

State the asymmetry explicitly, because it is the actual argument: an
allow-list degrades toward **false green** — a gate that quietly stops
gating something it used to gate, the moment the surface it's judging grows.
This repo's own conventions single out false-green degradation as the
expensive direction for a check to fail in (§ "Conventions" in `CLAUDE.md`
catalogs several unrelated instances of exactly this shape in test and
shell-verification code). A deny-list's failure mode runs the other way — a
newly-added family gates by default and a team must notice and *choose* to
exempt it, which is a report a human reads and acts on, not a check that
silently stops running.

This is a different polarity from the existing `--fail-on-strays` precedent
(#183, `src/cli.ts`): that flag **opts in** to more failing (stray-file
detection defaults to report-only, and `--fail-on-strays` adds a gate). This
decision does the opposite — it **narrows out** of an all-fatal default. The
two flags are not siblings to unify; a project that has never carried a
severity concept and one that always fails everything need different escape
hatches, and conflating them would make one of the two flags mean the wrong
thing by default.

## Relaxes the #132 "drop, don't downgrade" constraint

`CLAUDE.md` records that when #132 found two `validate-addons` false
positives, the fix was to **drop** the offending checks (the effect-addon
`aces.json` exemption; removing `name` from the metadata-mismatch
comparison) rather than downgrade their severity — explicitly because
`validate-addons` "has no severity concept" at the time, so downgrading
wasn't an available option. That was the correct call given what existed
then: there was nowhere to put a "downgrade" other than deleting the check
outright.

This ADR does not revisit or reverse that call — #132's checks were false
positives and belonged deleted regardless of what gating machinery existed.
What changes is the premise a *future* case can rely on. `--skip-gate` gives
`validate-addons` selectable fatality for the first time, at family
granularity. A hypothetical future case shaped like #132 — a check whose
findings are frequently more noise than signal for some but not all
consumers — now has a real alternative to deletion: gate it by default and
let a team `--skip-gate` its family, rather than removing the check for
everyone. This record exists in part to make that option discoverable the
next time the question comes up, rather than defaulting back to #132's
precedent under a constraint that no longer holds.

## Consequences

- **No behavior change for any existing CI invocation.** `--skip-gate`
  defaults to empty; the exit-code check is unchanged for a run that doesn't
  pass the flag.
- **`formatAddonValidation` gains a per-family summary line**, consumed
  identically by the CLI and the MCP tool — the rendering stays single-owner.
- **A `--skip-gate`d family's findings still fail a strict reader of the
  report**, deliberately: only the process exit code is affected. A CI step
  that parses the report text itself (rather than trusting the exit code) is
  unaffected by this flag and must apply its own filtering if it wants
  different behavior.
- **A fifth family, if one is ever added, gates by default everywhere** with
  no config change required — the property this decision exists to
  guarantee.
- **MCP callers get more information (the family summary) with no new input
  to reason about** — the asymmetry recorded above under "MCP gets the
  summary, not the parameter."

## Related

- ADR [0009](0009-addon-lang-consistency-check.md) — folded the
  aces.json/properties ↔ lang consistency check into `validate-addons`
  rather than a separate `validate-addon` command; this decision's `lang`
  family is that fold's direct descendant.
- ADR [0025](0025-stray-gating-is-cli-only-and-survives-a-manifest-failure.md)
  — `--fail-on-strays`, the opposite-polarity precedent (opt-in to more
  failing, CLI-only) contrasted above.
- `CLAUDE.md` § "Where to read more" / the `validate-addons` narrative — the
  #132 "drop, don't downgrade" record this decision relaxes without
  reversing.
