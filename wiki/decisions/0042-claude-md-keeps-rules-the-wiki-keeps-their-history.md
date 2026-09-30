---
type: decision-record
title: "0042. `CLAUDE.md` keeps the rules; the wiki keeps their history"
description: >-
  `CLAUDE.md` had regrown to 104,991 characters, mostly per-issue history and
  lesson narratives inside unwrapped bullets. It is cut to about 50,600 by
  moving that material verbatim into three wiki pages
  (`architecture/addon-tooling.md`, `process/canonical-fixture.md`,
  `process/verification-traps.md`) and deleting history that ADRs 0029/0033
  and git already own. Each moved lesson keeps a one-line rule in `CLAUDE.md`
  so it still fires mid-task. The routing test generalizes ADR 0026's to "is
  this a rule you must know before you'd think to look, or the evidence
  behind one?"
tags: [decision, process, docs]
status: stable
generated: { by: process:maintain-wiki, at: 2026-09-30T15:52:02Z }
---

# 0042. `CLAUDE.md` keeps the rules; the wiki keeps their history

- **Status:** Accepted
- **Date:** 2026-09-30
- **Issue:** none — driven by a `CLAUDE.md` size audit requested by the owner

## Context

`CLAUDE.md` is loaded into every session. ADR
[0026](0026-leaf-dependency-ledger-split-from-claude-md.md) split out the
leaf-dependency ledger when the file stood at 87,882 characters. Six weeks
later it had reached 104,991, and the growth had the same shape: a lesson
learned on an issue was recorded as a new paragraph inside an existing
unwrapped bullet, and the file's own convention forbids splitting those
bullets. Eight physical lines held about 58k characters. The biggest were the
addon-cluster narrative inside § "What this is" (13k), the three
verification/citation bullets at the end of § "Conventions" (28.5k, one of
them 15.3k on its own), the fixture materialization/golden/pin-bump
paragraphs (10k), and the wiki-tier bullet (6k, mostly the history of the
conventions audit's reach).

Most of that text is not an instruction but the **evidence** for one:
which issue produced a rule, what went wrong, and why the obvious fix fell
short. A session needs the rule before it knows to look for it. It needs the
evidence only when it is unsure whether the rule applies.

## Decision

1. **Move the evidence to the wiki verbatim.** Paragraph breaks and section
   headings are added, and nothing else changes. A mechanical check confirmed
   every moved block survives, whitespace aside. Three new pages:
   - `wiki/architecture/addon-tooling.md` — the addon-cluster design history.
   - `wiki/process/canonical-fixture.md` — fixture materialization, what the
     golden test proves, and the pin-bump protocol.
   - `wiki/process/verification-traps.md` — the guard-test, vacuity,
     citation, and counting traps with their precedents, the retired-name
     sweeps, and the audit-reach history.

   Each page carries a provenance note: inside the moved text, "this file"
   means `CLAUDE.md` and line numbers are `CLAUDE.md`'s at `b4997ef`.
   Rewriting those self-references would have broken the verbatim guarantee
   that makes the move reviewable.
2. **Leave a rule behind for every moved lesson.** A lesson that is only in
   the wiki is effectively gone, because the wiki is not auto-loaded. Each
   rule carries a pointer to the page with its precedents.
3. **Delete, don't move, history another record already owns.** The MCP docs
   resource history is owned by ADRs 0029 and 0033. The per-site
   editor-local migration list is owned by ADRs 0016, 0019 and 0020. The
   #95 watcher-wiring incident is owned by ADR 0034 and the traps page. The
   Co-Authored-By version history and the #207 anecdote are owned by git.
4. **Routing test**, generalizing ADR 0026's version-fact test: *is this a
   rule a session must know before it would think to look — or the evidence
   behind one?* Rules stay in `CLAUDE.md`; evidence goes to the wiki page
   that owns the topic, created if none exists.

## Rejected alternative — folding the traps into `local-verification-practice.md`

The schema prefers updating the closest existing page over creating a new
one. That page covers the mechanics of *running* the gate (bootstrap,
timing, fixture safety). The traps are about *authoring and grading* checks
and citations, a different reader at a different moment. Folding 40k
characters into a 10k page would have buried its purpose. The two pages link
to each other instead.

## Consequences

- `CLAUDE.md` drops from 104,991 to about 50,600 characters and keeps every
  section heading.
- Two inbound pointers (`scripts/prep-fixture.mjs`,
  `scripts/verify-fixture-parity.mjs`) and one wiki pointer
  (`wiki-schema.md`) were repointed to the new pages.
- The regrowth mechanism is unchanged: a new lesson can still be appended to
  a bullet. The routing test above is the only guard, and nothing enforces
  it. A size check was considered and not added, since any threshold would be
  arbitrary and the file's size is not itself the defect.
