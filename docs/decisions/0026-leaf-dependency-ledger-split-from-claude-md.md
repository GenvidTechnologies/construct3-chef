# 0026. Split the leaf-dependency version narrative out of `CLAUDE.md`

- **Status:** Accepted
- **Date:** 2026-08-16
- **Issue:** [#172](https://github.com/GenvidTechnologies/construct3-chef/issues/172)

## Context

`CLAUDE.md`'s `## Leaf dependencies` section fused two axes into one
27,885-character block (31.7% of an 87,882-character file loaded into
every session): a durable adoption **posture** (traversal/discovery
goes upstream, rendering stays local; the shape-fit rule; the
revert-confirm-your-guards rule; the `^0.x.y`-excludes-the-next-minor
semver fact) and a version-by-version **narrative** of what each
`@genvidtech/c3source` / `@genvidtech/mcp-utils` release shipped and
what chef did about it.

The fusion had already produced a real defect. `@genvidtech/mcp-utils`
0.6.0 (`^0.6.0` installed and locked) had **no narrative entry at
all**, because the mcp-utils narrative stopped at 0.5.0/0.5.1 while
the only 0.6.0 material — the `walkFiles`-now-guarantees-regular-files
evidence, including the "38 passing, 0 failing" finding that produced
the revert-confirm rule itself — sat roughly 12,000 characters away,
folded into the c3source line's posture passage. A section fused
across two packages and two axes made "does this package have an
entry for its current pin?" unanswerable by eye.

## Decision

Move the narrative to a new `docs/leaf-dependency-ledger.md`, one `##`
section per package (`@genvidtech/c3source` then
`@genvidtech/mcp-utils`), each holding chronological `###`
per-version entries, oldest first. The posture stays in `CLAUDE.md` §
"Leaf dependencies", now a routing pointer to the ledger rather than
the narrative itself.

**Routing test**, stated in both files so a future session need not
infer it: *"if it would need editing when the next version ships, it
belongs in the ledger. If it survives every version unchanged, it
belongs in `CLAUDE.md`."* This is the mechanism that keeps the split
maintainable going forward — nothing in code enforces it.

Measured outcome: the `## Leaf dependencies` section went from 27,885
to 4,850 characters (an 82.6% reduction), and `CLAUDE.md` as a whole
from 87,882 to 65,223 characters (25.8% smaller).

### Rejected alternative 1 — `CHANGELOG.md` as the home

`CHANGELOG.md` already exists, is already chronological, and looked
like a plausible destination. Dismissed on axis and lifecycle
grounds: a changelog records what *chef* shipped, per chef version —
a different subject axis than what *upstream* released and why chef
adopted or declined it. The lifecycles differ too: the ledger is
read *before* the next upstream bump, to check a package's newest
entry and its recorded declines before adopting a release, whereas a
changelog is read *after* the fact, to see what a past chef release
changed. Recorded here so the suggestion is dismissed once rather
than re-raised at the next leaf-dependency edit.

### Rejected alternative 2 — strictly-chronological single-file ordering

A single ledger file with entries interleaved by date across both
packages was considered and rejected. Interleaving is precisely what
had let the mcp-utils 0.6.0 entry go missing in the first place — its
only material lived on the c3source line, roughly 12,000 characters
from where a reader scanning for mcp-utils content would look. Per-
package sections make "does this package have an entry for its
current pin?" a local, by-eye check instead of a search across the
whole timeline.

### What stayed in `CLAUDE.md`, and why

The adoption posture (traversal/numbering/discovery upstream,
rendering local), the shape-fit rule ("owning the fact upstream isn't
sufficient — check the primitive's shape fits the consuming
operation"), the revert-confirm rule (delete an overlapping local
guard after a bump and confirm a test still fails), and the
`^0.x.y`-excludes-the-next-minor semver fact all stay in `CLAUDE.md`.
None of them needs editing when a new upstream version ships — they
are rules for evaluating a release, not facts about one. `CLAUDE.md`
is also auto-loaded into every session while the ledger is not, which
is the right home for a rule a session needs without being told to go
look for it.

## Compromise

The deliberate declines moved with their version entries into the
ledger rather than staying in `CLAUDE.md`. They are named here rather
than counted, since the count depends on what one treats as a single
decline: the two sites phrased "record before 'fixing' them" sit in
the `1.5.0 and 1.6.0` entry (`sourceWatcher.SOURCE_DIRS`, the
`projectSync` section configs, and the barrel-exported
`SID_SOURCE_DIRS`) and the `1.8.0` entry (the hybrid `.c3addon`
reader and its siblings), while the same shape recurs without that
phrasing in `1.9.0` (the `detectReferenceIntegrity` ownership split,
"recorded so the split stays intentional") and in `2.0.0` (the ADR
0021 decline, "don't re-derive it"). This is the split's sharpest
trade. Those declines exist
specifically to stop a future session re-litigating a settled call,
and moving them out of auto-loaded context means a session must now
be *told* to look rather than encountering them by default.

Three things preserve reachability despite the move: each decline is
already recorded canonically in an indexed ADR (0007, 0014, 0016,
0021), so the ledger entry is a pointer rather than the sole record;
a repo-wide grep for a decline's subject reaches the ledger exactly
as it previously reached the `CLAUDE.md` section; and `CLAUDE.md`'s
retained routing tail explicitly instructs a session to read a
package's newest ledger entry before adopting a release, so the
"go look" instruction survives even though the content itself does
not.

## Consequences

- The split changes *who pays* the context cost, not the ledger's
  growth trajectory. Every future version entry still accumulates
  somewhere; the change is that the accumulation site is no longer
  loaded into every session by default. This is deliberate and
  accepted, not a side effect to be corrected later.
- The move exposed a relocation hazard generic to moving any doc
  section: three markdown links inside the moved text were
  repo-root-relative (`](docs/decisions/…)`) and broke the moment the
  text landed one directory down, inside `docs/`. A name-based grep
  for the moving content could never have surfaced this — only
  enumerating the full moving span and checking each link target did.
  Any future section move should budget for the same check.
- `docs/TOC.md` gains a `leaf-dependency-ledger.md` entry under
  `## Architecture & design rationale`, and this record is indexed
  under `## Decision Records`, so both halves of the split are
  discoverable from the documentation index.
