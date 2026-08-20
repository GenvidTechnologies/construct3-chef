# Wiki Log

Record of every `ingest` run: what changed, why, and which `raw/` source
drove it, grouped under `## YYYY-MM-DD` date headings (ISO 8601) with the
**newest date group first**. Entries are prose bullets, e.g. `* **Update**:
…`, `* **Creation**: …`, `* **Deprecation**: …` — the leading bold word is a
convention, not a requirement.

**Add newest first, never edit or remove a prior entry.** "Newest first"
means a new entry (and, if today isn't already the top group, a new
`## YYYY-MM-DD` heading) is *prepended* above everything else — the
insertion point moves from the bottom to the top, but prepending never
touches a prior entry's text, so the append-only guarantee holds exactly as
before. If a past entry itself needs correcting, add a new entry that says
so; never edit or remove the old one in place. See `wiki/wiki-schema.md` for
the full maintenance schema.

## 2026-08-20

* **Migration**: the entire `docs/` tree (38 files, ~440 KB) ingested into the
  wiki bundle and `docs/` retired — five reference manuals to
  `wiki/reference/`, two architecture/research notes to `wiki/architecture/`,
  two process docs to `wiki/process/`, and the 27 ADRs to `wiki/decisions/`,
  with `wiki-schema.md` moving to the bundle root. Driven by explicit owner
  direction ("migrate the documentation entirely, no docs residual"), recorded
  as ADR
  [0028](decisions/0028-documentation-consolidated-into-the-wiki-tier.md). This
  inverts the previous routing rule: the wiki is no longer the residual tier
  for knowledge with no other repo home, it is the *only* documentation tier.
* **Creation**: `decisions/0028-documentation-consolidated-into-the-wiki-tier.md`
  — records the consolidation, the narrowed routing rule ("exactly one page owns
  a given fact"), the two rejected alternatives, and the accepted plugin-contract
  breakages.
* **Fold**: `docs/TOC.md` merged into `index.md` rather than moved — two indexes
  of one corpus is the drift trap the routing rule exists to prevent. Every
  migrated page gained OKF v0.2 frontmatter carrying the one-line summary
  `TOC.md` held, and all five indexes are now *generated* from those
  `description` fields so index and page cannot diverge.
* **Update**: `wiki-schema.md` — routing rule rewritten for the single-tier
  layout; the settled-decision clause now points at `<wikiDir>/decisions/`; the
  `Related`/wiki-link examples switched from the escaping `../docs/<page>.md`
  form to bundle-absolute `/<page>.md`; and the out-of-bundle section rewritten,
  since this schema doc and every ADR moved *inside* the bundle and the only
  legitimate escaping targets left are repo-root files and `../raw/` captures.
* **Note**: the move exposed three hardcoded `docs/` assumptions in the
  `gvt-dev` plugin (inert `paths` overrides, hygiene scanners that now scan
  `CLAUDE.md` alone while still reporting clean, and `maintain-wiki`'s own
  hardcoded schema-doc path), filed as gvt-dev
  [#389](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/389)
  and
  [#390](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-dev/issues/390).
  Accepted rather than worked around; see ADR 0028 § Consequences.

## 2026-08-16

* **Creation**: local-verification-practice.md, driven by `raw/2026-08-16-agent-memory-local-verification.md` — first page of the wiki; captures local verification practice that lived only in machine-local agent auto-memory and was recorded nowhere in the repository.
