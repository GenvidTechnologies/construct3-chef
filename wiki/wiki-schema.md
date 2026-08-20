---
type: schema
title: "Wiki Maintenance Schema"
description: >-
  Maintenance schema for the three-tier LLM-wiki (`raw/` immutable captures → `wiki/` OKF v0.2 pages + `index.md`/`log.md`), consumed by `/gvt-dev:maintain-wiki`: page format/frontmatter, create-vs-update lifecycle, generated-index policy, `raw/` immutability, staleness policy, wiki-link forms
tags: [wiki, schema, okf, contract]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# Wiki Maintenance Schema

> construct3-chef's conventions, consumed by `/gvt-dev:maintain-wiki`. This is the
> **maintenance schema** for the three-tier wiki: `raw/` (immutable captured
> sources) → `<wikiDir>/` (LLM-maintained pages, `index.md`, `log.md`) → this
> schema (the rules that govern how the first two are kept in sync).
>
> **Resolved directories for this repo:** `wikiDir` = `wiki`, `rawDir` = `raw`,
> declared in `.gvt-agent.json`'s `wiki` block. The prose below deliberately keeps
> writing them as `<wikiDir>/` and `<rawDir>/` rather than hardcoding those two
> names — see § "Bundle root", which is the rule this file states about itself, and
> which also keeps this doc correct if the config is ever repointed. Resolve a
> placeholder against `.gvt-agent.json`, never against a name remembered from here.
>
> **What the wiki is for in this repo** is a routing question answered in
> `CLAUDE.md` § "Where to read more", not here. Since the `docs/` consolidation
> (ADR [0028](decisions/0028-documentation-consolidated-into-the-wiki-tier.md)),
> `<wikiDir>/` is this repo's **only** documentation tier: reference manuals,
> architecture and research notes, process docs, and the decision records all
> live here, alongside the durable knowledge that has no other home. `CLAUDE.md`
> keeps only the always-loaded operating context and routes here for everything
> else. The rule that survives the consolidation is the one that motivated it:
> **exactly one page owns a given fact.** A second copy — whether in `CLAUDE.md`
> or in another page — is a drift trap, not a convenience.
>
> The section headings must stay the same — the skill locates guidance by
> heading. Edit the prose under each heading, not the heading itself.

Pages under `<wikiDir>/` follow the [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), pinned at upstream commit `3fcbb9f828c2f23d109c855ee403c3a4c81f3a96`. A later spec revision obliges different things depending on its scope:

- **MINOR / backward-compatible revision** — update the declared version and the pinned commit SHA above; no migration owed.
- **MAJOR / breaking revision** — a tracked migration, a `plugin/CHANGELOG.md` entry, and a plugin `version` bump.

OKF has already shipped one breaking revision within v0.x: v0.1's body `# Citations` list was superseded by frontmatter `sources`, and `timestamp` became `generated.at`. Upstream declares v0.x provisional, so without a declared pin the next revision would be silent drift.

**Bundle root.** The OKF bundle root is `<wikiDir>/` — the directory named by `.gvt-agent.json` `wiki.wikiDir`. Write it as `<wikiDir>/`, never hardcoded `wiki/`, because a consuming repo may set it to something else. `<rawDir>/` is **outside** the bundle — captures are not concept documents, so §11's frontmatter requirement never reaches them and the `raw/` immutability convention (below) stands unamended.

## Page format

Every page under `<wikiDir>/` is a single Markdown file that opens with YAML
frontmatter, then prose, and follows this shape:

```markdown
---
type: practice-note                  # the ONLY always-required key (§4.1); must be non-empty (§11.2)
title: <Page title>
description: <One-line summary — the single sentence you'd say if asked "what is this page about?">
tags: [<topic>, <topic>]
status: stable                       # draft | stable | deprecated; absent implies stable (§5.4)
stale_after: <YYYY-MM-DD>            # absolute date; stale when today >= this (§5.5)
generated: { by: process:maintain-wiki, at: <YYYY-MM-DDTHH:MM:SSZ> }
usage_window: { from: <YYYY-MM-DD>, to: <YYYY-MM-DD> }
sources:
  - id: <short-id>
    resource: ../<rawDir>/<capture>.md
    title: <what this source is>
    last_modified: <YYYY-MM-DD>
  - id: <short-id>-upstream
    resource: <https://original-source-url>
    title: <the upstream article/source the capture is drawn from>
---

# <Page title>

<Body — the accumulated knowledge on this topic, in prose, lists, or tables as
fits. A claim drawn from a source carries a footnote keyed to that source's
`sources[].id`, e.g. "...claim text[^<short-id>]", with a matching definition
`[^<short-id>]: <label>` further down.>

## Related

- [<Other page title>](/<other-page>.md) — <why it's related>
```

- **`type`** — the only always-required key (§4.1); must be non-empty
  (§11.2). Starter vocabulary shipped here — extend or replace it freely for
  your project: `practice-note`, `reference`, `decision-context`, `incident`.
  §11 forbids a consumer rejecting an unknown `type` value, so an open-but-recommended
  set is both routable and conformant.
- **`title`, `description`, `tags`** — recommended keys (§4.1). `description`
  is the one-line summary surfaced in `<wikiDir>/index.md` entries and query
  results — keep it accurate and current even when the body grows.
- **Top-level `resource`** — deliberately **omitted**. §4.1: "Absent for
  concepts that describe abstract ideas rather than physical resources." A
  synthesized wiki page is an abstract concept, not a resource — don't add it.
- **`status`** — §5.4; absent implies `stable`.
- **`stale_after`** — §5.5, an absolute date. A page is stale when
  `today >= stale_after` (see `## Decay / staleness policy` below for how to
  choose it).
- **`generated`** — §5.2. `by` is **required** within the block. Value is
  `process:maintain-wiki` (the `process:<id>` actor form) — this names the
  durable producer (the skill's ingest contract), not a model or agent name
  that changes underneath the page.
- **`verified`** — §5.3, **never auto-emitted**. Approving an `ingest` at its
  interactive checkpoint is *not* `human:` verification — verification is a
  separate, deliberate act. A page therefore reads as `unverified` (§5.3's
  default when the key is absent) until someone genuinely checks it. This is
  the truthful state; inflating it would destroy the trust tier's signal.
- **`sources[]`** — §5.1. `resource` is **required** within each entry. `id`
  is the join key for per-claim footnotes. Write **two** entries per capture:
  one citing the immutable capture at `../<rawDir>/<capture>.md`, one citing
  the upstream URL. The relative path dangles if the bundle is ever extracted
  on its own, and §6.1's broken-link tolerance covers links, not path-valued
  fields — the second entry is what keeps provenance resolvable.
- **`usage_window`** — §5.1, written once as a sibling of `sources`, framing
  every `usage_count` in the page.
- **Per-claim footnotes** (§5.1) — a claim carries `[^<id>]` in the body and a
  matching `[^<id>]: <label>` definition, where `<id>` matches a `sources[].id`
  entry. The footnote label is the join key; attribution resolves through the
  matching `sources` entry, not by parsing the footnote prose.
- **`Related`** — wiki-links (see below) to other `<wikiDir>/` pages this one
  connects to. Optional if the topic is genuinely standalone.

**Tolerated, never rejected** (§11 consumer clauses): a conformant consumer
MUST NOT reject a bundle for missing optional frontmatter fields, a missing
optional family (§5.3), unknown `type` values, unknown additional frontmatter
keys, broken cross-links, or a missing `index.md` — and MUST treat a bare
`verified` mapping as a one-element list. This bounds what a future mechanical
linter (`lint`, below, and #150) may flag. The **binding** statement for
`lint` and #150 lives in the skill body's `lint` section (plugin-owned, so it
survives edits to this file); this paragraph is the format's own statement of
the same clauses.

## Page lifecycle: create vs. update

A wiki **accumulates and compounds** — unlike a RAG index, which retrieves and
forgets, a wiki page is the durable, growing record of everything known about
one topic. Two situations, two different actions:

- **New topic → new page.** If the ingested source describes a topic with no
  existing page, create one under `<wikiDir>/<topic-slug>.md`, add it to
  `<wikiDir>/index.md`, and append an entry to `<wikiDir>/log.md`.
- **New facts about an existing topic → update the page in place.** Don't
  create a second page for the same topic, and don't just append raw
  paragraphs — integrate the new facts into the existing prose, updating the
  `description` if the topic's shape has changed, and refresh the frontmatter
  `sources` list. Append an entry to `<wikiDir>/log.md` either way.

When it's ambiguous whether a source is a new topic or a refinement of an
existing one, prefer updating the closer existing page — a wiki with one
strong page beats a wiki with two thin overlapping ones.

**The indexes are generated, never hand-edited — local policy, enforced.** Every
index entry's description IS the linked page's frontmatter `description`, which
is what makes index and page structurally unable to drift. That is produced by
`scripts/gen-wiki-index.mjs` (`npm run wiki:index`), and
`test/wiki/wikiBundle.test.ts` fails the build when a committed index no longer
matches generator output. So the workflow for "add it to `<wikiDir>/index.md`"
above is: write the page's `description`, then regenerate. Editing an index by
hand reintroduces exactly the drift the generation exists to prevent, and the
suite will catch it.

Two consequences worth stating, because they are easy to get backwards:

- A page therefore **must** carry `title` and `description` — not because OKF
  requires them (§4.1 requires only `type`), but because this repo's generator
  reads them. This is a **stricter local policy**, which §11 explicitly permits a
  consuming repo to adopt; it is not an OKF conformance claim.
- Nothing else about the bundle gates the build. Dead links, orphans, staleness,
  a missing `index.md`, an unknown `type` — all are reported advisory-only by
  `npm run wiki:lint` (`scripts/wiki-lint.mjs`), which **always exits 0**,
  because §11 forbids an OKF consumer from rejecting a bundle for any of them.
  Adding a new section directory means adding it to `SECTIONS` in the generator;
  that is the only edit a new subdirectory needs.

## The `raw/` immutability convention

`raw/` is the **provenance tier**: every file under it is a captured source —
a transcript, a doc snapshot, a decision record, a data dump — exactly as it
was when captured.

- **Never edit a file under `raw/`.** A `raw/` file is a historical capture,
  not a living document.
- **If a source changes, re-capture it as a new file** (e.g. suffix with a
  date or revision), leaving the prior capture in place. The wiki page that
  cites it gets updated (see above); the old capture stays as the record of
  what was true when it was captured.
- This is what makes `<wikiDir>/` pages re-verifiable: every claim traces back to
  an immutable file, not a source that may have moved on since.

## Decay / staleness policy

Staleness is modelled **per page** by the frontmatter `stale_after` key
(§5.5) — an absolute `YYYY-MM-DD` date, not a relative TTL. A page is stale
when `today >= stale_after`; `lint` (below) surfaces stale candidates, a
human or the skill's judgment decides what to do with them. Decay is a
**policy the maintainer applies**, not an automated engine.

§5.5 prefers an absolute date over a relative TTL precisely so the staleness
decision is a plain date comparison with no reference to when the page was
last read.

Choose `stale_after` by the topic's own volatility, not a fixed default:

- A **fast-moving practice** (a workflow still being refined, a tool version
  pin) gets a `stale_after` a few months out.
- A **settled architectural concept** (a decision that's unlikely to change)
  gets a `stale_after` a year out, or omits the key entirely if it's expected
  to stay true indefinitely.

**This project's rule: choose `stale_after` from what would falsify the page, not
from a calendar default.** Concretely:

- A page whose claims track **tooling that moves underneath us** — command
  timings, the bootstrap step, the fixture materialization protocol, or anything
  phrased against a specific test count — gets `stale_after` **six months** out.
  `wiki/local-verification-practice.md` is the worked example: it quotes both a
  suite size and a validate-gate duration, and ordinary work drifts each of them.
- A page whose claims track a **pinned upstream version** (`@genvidtech/c3source`,
  `@genvidtech/mcp-utils`, or the `construct3-sample` fixture pin) gets **three
  months** — or, more likely, should not be written at all:
  `wiki/process/leaf-dependency-ledger.md` already owns that axis, so a wiki page
  restating it is the duplication the routing rule forbids.
- A page about a **settled decision** omits `stale_after` entirely — and belongs
  in `<wikiDir>/decisions/` as a numbered ADR rather than as a free-standing page.

Never pick "a year out" by reflex. An unfalsifiable date is worse than no date at
all, because `lint` will faithfully report the page as healthy on the very day it
stops being true — the same vacuous-check shape `CLAUDE.md` § "Conventions"
catalogues at length.

## The verb contract

`/gvt-dev:maintain-wiki` operates through three verbs:

- **`ingest`** — read new or changed files under `raw/`, write new `<wikiDir>/`
  pages or update existing ones per the lifecycle rule above, and append one
  entry per source to `<wikiDir>/log.md`.
- **`query`** — answer a question **from the wiki**, with citations back to
  the pages (and, transitively, the `raw/` sources) that support the answer.
  Query is served by the `gvt-dev:wiki-librarian` agent so exploration stays
  off the main thread.
- **`lint`** — an advisory health check, not a mutation. It flags: dead
  wiki-links (a `Related` link to a page that no longer exists), out-of-bundle
  links (a link that resolves outside `<wikiDir>/` — legal, but unresolvable
  to a consumer that receives only the bundle), orphaned pages (a page listed
  in **no** index — neither `<wikiDir>/index.md` nor its own subdirectory's
  `index.md`), `raw/` mutations (a `raw/` file that has been edited rather
  than re-captured), and stale pages per `stale_after` (above). The skill body
  carries the full rules.

## Wiki-links

Relate pages to each other with ordinary intra-wiki Markdown links —
`[<title>](/<other-page>.md)` — inside the `Related` section of a page (or
inline in the body, where a specific claim points at another page). Two link
forms are legal (§6.1):

- **Bundle-absolute** — `/other-page.md`, rooted at `<wikiDir>/` (the bundle
  root). §6.1 **recommends** this form: it stays correct even if the linking
  page moves to a different subdirectory within the bundle.
- **Ordinary relative** — `./other-page.md` for a sibling page in the same
  directory, `../<subdir>/other-page.md` for a page in another subdirectory.

A link that escapes the bundle root entirely — e.g. to `../../CLAUDE.md` or a
`../<rawDir>/` capture — remains legal per §6.1 as an ordinary relative link, but
it is **unresolvable to an external OKF consumer** that only receives the
`<wikiDir>/` bundle on its own. Treat this as a deliberate, documented trade-off,
not a pattern to reach for by default.

The consolidation in ADR
[0028](decisions/0028-documentation-consolidated-into-the-wiki-tier.md) shrank
this category sharply: this schema doc and every ADR used to sit outside the
bundle under `docs/`, so pointing at either *required* an escaping link. Both now
live inside `<wikiDir>/`, which leaves only two legitimate out-of-bundle targets —
repo-root files (`CLAUDE.md`, `README.md`) and `<rawDir>/` captures cited as
provenance in a page's `sources`. A new escaping link to anything else is a
routing smell: the target probably belongs in the bundle.

Consumers **must tolerate broken links** (§6.1): a link whose target doesn't
exist yet is not malformed — it may simply be knowledge not yet written.

A `raw/` capture is **not** cited as a body wiki-link. It's cited via
`sources[].resource` in a page's frontmatter (`../<rawDir>/<capture>.md`,
§6.2's own worked-example relative-path form) — wiki-links relate living
`<wikiDir>/` pages to each other; `sources` records provenance back to the
immutable tier.
