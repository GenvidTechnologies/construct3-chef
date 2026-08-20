---
type: decision-record
title: "0028. Documentation consolidated into the wiki tier; docs/ retired"
description: >-
  All of `docs/` — reference manuals, architecture and research notes, process docs, and the 27 decision records — moves into the `wiki/` OKF bundle, retiring `docs/` entirely and inverting the previous routing rule that kept wiki content restricted to knowledge with no other repo home; records the hardcoded-`docs/` plugin-contract breakages the move exposes (gvt-dev #389/#390) and why they are accepted rather than worked around
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:40:03Z }
---

# 0028. Documentation consolidated into the wiki tier; docs/ retired

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** repo owner (explicit direction), executed via `/gvt-dev:maintain-wiki`

## Context

The repo carried **two** documentation tiers with an explicit boundary between
them. `docs/` held 38 files (~440 KB): five reference manuals, two
architecture/research notes, two process docs, `TOC.md`, `wiki-schema.md`, and
27 ADRs. `wiki/` held a single page. The routing rule, stated identically in
`CLAUDE.md` § "Where to read more" and in `wiki-schema.md`, was:

> durable knowledge with *no other repo home*. Knowledge already owned by
> `CLAUDE.md`, `docs/`, or an ADR stays there; a second copy is a drift trap.

That rule made the wiki a **residual** tier — by construction it could only
ever hold what `docs/` did not. The one page it had (`local-verification-practice.md`)
qualified only because its source was machine-local agent auto-memory.

Two tiers with a boundary is a boundary that must be maintained. The routing
question ("does this belong in `docs/` or `wiki/`?") had to be answered for
every new document, and answering it wrong in either direction produced the
duplication the rule existed to prevent.

## Decision

**Retire `docs/`. `wiki/` becomes the repo's only documentation tier.**

Layout, with the OKF bundle root at `wiki/`:

| Path | Holds |
|---|---|
| `wiki/reference/` | `cli.md`, `cli-addons.md`, `recipe-reference.md`, `generators.md`, `ops.md` |
| `wiki/architecture/` | `mcp-architecture.md`, `prior-art-construct3-mcp.md` |
| `wiki/process/` | `issue-triage.md`, `leaf-dependency-ledger.md` |
| `wiki/decisions/` | the 27 ADRs, plus this one |
| `wiki/` (top level) | `wiki-schema.md`, `local-verification-practice.md`, `index.md`, `log.md` |

`docs/TOC.md` is **folded into `wiki/index.md`** rather than moved: both were
indexes of the same corpus, and keeping two would have been the drift trap in
its purest form. Every page gained OKF v0.2 frontmatter with a non-empty
`type`; each page's `description` is the one-line summary `TOC.md` already
carried, and the indexes are **generated from those `description` fields**, so
index and page cannot diverge.

The routing rule is not deleted, it is **narrowed to its actual content**:
*exactly one page owns a given fact.* That is the half that was doing the work;
"no other repo home" was a statement about the tier boundary, and the boundary
is gone.

## Consequences

**The `stale_after` policy needed no change but gained a clean reading.** ADRs
omit it (settled decisions), reference manuals get six months, and the
leaf-dependency ledger gets three. `wiki-schema.md`'s existing guidance already
said a settled-decision page "usually belongs in `docs/decisions/` rather than
here" — that sentence now reads as "belongs in `wiki/decisions/` as a numbered
ADR", which is the same rule with the tier boundary removed.

**Out-of-bundle links became rare rather than routine.** `wiki-schema.md` and
every ADR previously sat *outside* the OKF bundle, so pointing at either from a
wiki page required an escaping `../docs/…` link. Both now live inside `wiki/`.
The only legitimate escaping targets left are repo-root files (`CLAUDE.md`,
`README.md`) and `../raw/` captures cited as provenance. A new escaping link to
anything else is now a routing smell.

**The plugin-contract breakages are accepted, not worked around.** The
`gvt-dev` plugin assumes documentation lives in `docs/`, hardcoded independently
at each of the following sites — named rather than counted, since a count in
prose is its own drift trap (§ "Conventions"):

1. `audit.mjs`'s `evaluateFile` joins `entry.path` verbatim and never consults
   `.gvt-agent.json`'s `paths` convention-file overrides — so the override
   `CONVENTIONS.md` documents for exactly this situation is inert.
2. `hygiene.mjs`'s `listCandidateFiles` hardcodes `listMarkdown(repoRoot, 'docs')`,
   consulting neither `paths.docs` nor `wiki.wikiDir`. All three hygiene
   scanners share that set, and a missing directory degrades to an empty list
   rather than an error — so they now scan `CLAUDE.md` alone and still report
   **clean**. This is the vacuous-check shape `CLAUDE.md` § "Conventions"
   catalogues, arriving through the audit itself.
3. `maintain-wiki` hardcodes `docs/wiki-schema.md` in 13 places (plus one in
   `wiki-librarian`) while resolving `wikiDir`/`rawDir` from config.
4. `practice-detect.mjs` hardcodes the same schema-doc path as `SCHEMA_DOC`
   while resolving `wikiDir`/`rawDir` from config. This is why a complete,
   healthy wiki now reports the Environment pillar as `partial adoption` at 5
   of 6 signals, with nothing in the output naming the missing one.

Filed as gvt-dev
[#389](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/389)
and
[#390](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/390).
Working around them locally would mean either keeping a vestigial `docs/` — the
"no residual" outcome this decision exists to reach — or shimming paths the
plugin will fix properly. The audit will carry findings until those land; that
is the accepted cost, and it is visible rather than silent because it is
recorded here.

**One audit finding is a hard error, not a warning.** Of the 14 declarations of
`docs/TOC.md` across installed skills and agents, 13 mark it `required: false`;
`condense-lessons` alone takes the default. Because the audit aggregates
required expectations repo-wide, that single entry makes the missing `docs/TOC.md`
an error for a repo that never uses that skill. Also covered by #389.

**Historical prose was deliberately not rewritten.** ADR bodies and
`CHANGELOG.md` entries that mention `docs/…` describe what was true when
written — e.g. ADR 0026's account of a relocation hazard involving
`](docs/decisions/…)` links, and ADR 0001-0006's note that "the `docs/decisions/`
convention was introduced later". Rewriting those would falsify the record. The
same exemption `CLAUDE.md` § "Conventions" already grants `docs/decisions/` in
retired-token sweeps ("an ADR is a historical record") applies here. Live
pointers *were* rewritten; only narrative references to the past were left.

## Alternatives rejected

**Migrate only the eligible subset.** Under the old routing rule the eligible
set was empty by construction — everything in `docs/` had a home in `docs/`.
The only genuinely wiki-shaped file was `prior-art-construct3-mcp.md`. Moving
one file would have left the two-tier boundary, and the maintenance question,
exactly where it was.

**Keep `docs/` as a thin shim** holding `TOC.md` and `wiki-schema.md` to satisfy
the plugin. This is the pragmatic option and it would keep the audit green. It
was rejected because it preserves the two-tier split for the benefit of a
hardcoded path rather than a real need, and because a shim that exists only to
satisfy a bug tends to outlive the bug.
