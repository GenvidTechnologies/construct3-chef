# 0017. `sync-addon-metadata`: a separate command, not a fold

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issue:** [#145](https://github.com/GenvidTechnologies/construct3-chef/issues/145)

## Context

Issue #145 is capability 8 of the #100 c3addon-tooling umbrella and the last
one — the only *mutation* in a cluster that has otherwise shipped read-only
tools (`read-addon`, `validate-addons`, `list-addons`, `diff-addon-aces`,
`scan-addon-usage`). It asks for a way to reconcile drift between a bundled
`.c3addon` package's `addon.json` (`version`/`author`) and its matching
`project.c3proj` `usedAddons` entry — the class of staleness that happens
when an addon is upgraded in place but the project manifest isn't re-saved
from the editor, or vice versa.

Two prior addon-tooling issues in this same cluster were folded into an
existing command rather than shipping as their own: #98 (aces/lang
consistency) folded into `validate-addons` ([ADR 0009](0009-addon-lang-consistency-check.md)),
and #108 (orphan/missing/duplicate package consistency) folded into
`validate-addons` as well. That precedent had to be weighed explicitly
against shipping #145 as its own command.

## Decision

**A new, separate `sync-addon-metadata` command** — CLI subcommand +
MUTATE MCP tool, backed by a new off-barrel `src/c3/addonMetadataSync.ts`.
Not folded into any existing command. Three fold targets were considered and
rejected before landing here (see Compromise).

**ADR 0009's precedent does not transfer.** ADR 0009's actual holding was
narrower than "addon capabilities belong inside `validate-addons`": its
*Compromise* section rejects the issue-as-filed `validate-addon` command
specifically because *"the near-identical singular/plural names would
confuse — the issue itself flagged this. \[...\] two commands that both
'validate an addon' but differ only by singular/plural is a confusing
surface."* That is a naming-collision argument, not a scope-consolidation
principle. `sync-addon-metadata` collides with nothing — there is no
existing `sync-addon-metadatas` or near-homophone command — so the reasoning
that decided #98 simply doesn't apply here. (#108's fold carries even less
precedent value: it never proposed a competing command name at all, it
just extended `validate-addons`'s existing finding set.)

It's also worth naming what both prior folds have in common that this
decision breaks: #98 and #108 each folded a **read-only** detection into
`validate-addons`, itself read-only (`READ_ONLY` annotation, CI-gateable via
`cli.ts`'s exit code). `sync-addon-metadata` is a **write** — the first
mutation in the whole addon-tooling cluster — so folding it into
`validate-addons` would have been the first fold across the read/write
boundary, not a same-shape extension of the two that came before it.

**Why not `--fix` on `validate-addons`.** `validate-addons` exits 1 on any
finding (`cli.ts`) and has **no severity concept** — every finding is
CI-failing (see CLAUDE.md § addon read surface, the #132 note: *"the fix
was to drop the wrong check, not downgrade it"*). It's also documented as
fitting a project's `commands.validate` chain. A `--fix` flag on a command
whose whole contract is "safe to run in CI, never mutates" puts a manifest
writer one typo away from running unattended in a validation gate. The
write needed its own, opt-in entry point.

**Why not `sync-project --section usedAddons`.** Rejected on four
independent mismatches with `sync-project`'s existing shape, any one of
which would have been disqualifying on its own:

- `usedAddons` is neither a file section nor a name section and has no
  disk folder to sync against — `sync-project`'s section model
  (`SectionSummary`, the 12 disk dirs) has nothing to key it to.
- `runSync` reads via c3source's **strict** `readProjectManifest`, whose
  fail-fast behavior is pinned by three tests
  (`test/syncC3Proj.test.ts`) — while this feature *requires* a tolerant
  read, since a manifest with an unrelated shape issue elsewhere must not
  block an addon-metadata sync.
- `sync-project` never picks a direction — disk (the project's source-JSON
  tree) always wins over the manifest. This feature needs a direction the
  human picks, because there is no "source of truth" side by default (see
  the direction-flag decision below).
- `sync-project`'s dry-run is a **separate command** entirely (`validate-project`
  is its own read-only preview, not a flag on `sync-project`). Folding this
  feature in would either put a direction flag on a read-only preview
  command or break that existing pairing.

**Naming: `sync-addon-metadata`, not `sync-addon-version`.** The issue, the
#100 capability-8 spec, the burbank `update-c3addon` reconciliation comment
this traces back to, and `claude-code-plugin-gvt-construct3#32` all name the
command `sync-addon-version`. It was renamed to `sync-addon-metadata`
because **`author` is in scope alongside `version`** — an explicit scope
decision (below) — and "version" undersold what the command actually
reconciles. This has a real cost: four cross-references now name the old
command, two of them in other repos (a burbank comment and
`claude-code-plugin-gvt-construct3#32`, both post-merge comms not fixable
from here).

**Field scope: `version` + `author`, not `id`.** `name` is excluded per
#132 (a package's `addon.json` display name legitimately differs from
`usedAddons[].name`, the user-assigned *instance* name — the same reasoning
`validate-addons`' metadata-mismatch check already applies). `id` is not
merely excluded by policy — it is **structurally unreachable** as a
mismatch, and the prep commit `2635b86` removed its now-dead branch from
`validate-addons`' own `checkMetadataMismatch` before this feature landed.
`readUsedAddons` keys its map by `entry.id` and also sets
`used.id = entry.id`; the classification join
(`usedById.get(metadata.id ?? addon.name)`) therefore guarantees
`metadata.id === used.id` whenever `metadata.id` is defined, and the
`packageValue === undefined` guard skips the field check when it isn't. An
`id` mismatch can't occur by construction, in either `validate-addons` or
`addonMetadataSync.ts`'s `classifyAddon`, which mirrors the same
`author`/`version` comparison rule.

**The direction flag is mandatory, with no default.** `--direction
{manifest-from-package|package-from-manifest}` is enforced *structurally*,
not by convention: the CLI declares it with yargs `demandOption`, and the
MCP tool declares it as a non-`.optional()` `z.enum`, so an omitted
direction is rejected by the framework before either handler body runs.
Direction is a human decision the tool must never guess — there is no
version comparison anywhere in `src/` (`compareAddonVersions` was
deliberately never filed upstream: C3's four-part dotted addon versions
aren't semver, so "which side is newer" has no principled answer to
compute), and the tool never attempts to infer which side is stale.

**Only one direction can write.** `manifest-from-package` is an in-place
JSON field write into the already-parsed `project.c3proj` document.
`package-from-manifest` would require repacking a `.c3addon` zip archive —
and nothing in `src/` writes an archive; `fflate` appears only as
`unzipSync` (`addonReader.ts`, `addonValidator.ts`), never `zipSync`
(`zipSync` is test-only, used by fixture builders). So
`package-from-manifest` is a read-only report, identical in every respect
to what `preview-addon-metadata-sync` would show for the reverse direction,
framed as "package is stale, re-export it from Construct" rather than as an
action the tool takes.

The asymmetry is real, but the flag is still framed as a **direction**
(two named values of one option) rather than as two differently-shaped
verbs, because naming both sides of the reconciliation the same way is what
makes the operator's choice legible — "which side do you trust" is a single
question with two answers, even though the tooling can only act on one of
them. Collapsing to a single always-write command (silently dropping the
read-only side) would remove the operator's ability to audit
package-from-manifest drift at all.

**Byte-fidelity mechanism.** The apply path (`applyAddonMetadataSync`)
depends on c3source 1.9.0's `readProjectManifestTolerant`, which returns
the parsed document **by identity** rather than a validated/rebuilt copy.
Every write is an in-place field assignment on that same object
(`entry.version = …`, `entry.author = …`) — never a spread, which would
reorder keys and silently drop any field the manifest type doesn't model
(e.g. `sdkVersion`). The file is then written with c3source's
`writeProjectManifest`/`serializeProjectManifest`
(`JSON.stringify(m, undefined, "\t")`).

The byte-form trap this avoids: `project.c3proj` is written with **no
trailing newline** — this contradicts CLAUDE.md's general "C3 JSON is
written tab-indented with a trailing newline" convention line, which holds
for event-sheet and layout writes but not this one. Appending `"\n"` here,
by habit or by following that line literally, would produce a one-byte
whole-file diff on every sync even when no field actually changed. The
upstream serialized form is byte-identical to what `projectSync.ts` already
writes for the same file, so this isn't a new format — it's a form that
was already established and had to be matched, not re-derived.

**Two writers of `project.c3proj`, one invariant.** `projectSync.ts`'s
`runSync` and this feature's `applyAddonMetadataSync` are now both writers
of `project.c3proj`. They don't clobber each other's unmodeled fields, but
only because **both** independently follow the same discipline — parse the
manifest by identity, mutate in place, serialize the same object — and
nothing in the codebase enforces that as an invariant across the two call
sites; a future writer of this file that rebuilds the document via spread
would silently drop whatever the other writer added since. The mitigation
shipped is a cross-reference comment at both write sites
(`addonMetadataSync.ts`'s `applyAddonMetadataSync` docstring;
`projectSync.ts`'s `writeFileSync(projectPath, …)` call site) plus the
byte-fidelity test coverage in `test/c3/addonMetadataSync.test.ts`. Routing
`projectSync.ts` itself through c3source's `writeProjectManifest` (so both
writers share one serialization call, not just one discipline) is a
deliberate **separate** follow-up under the existing `area:c3source-adoption`
label — out of scope here.

**Exit-code policy: exit 1 means outstanding human work remains.** Either a
row was refused (`blocked`, requiring the operator to resolve the ambiguity
or editor-only status by hand), or a row still needs doing (`would-change`
in a mode that didn't write, i.e. `--dry-run` or the inherently read-only
`package-from-manifest` direction). A successful apply that resolved
everything it could is exit 0, even though it wrote to disk.

This required a choice, because the two closest in-repo precedents
disagree with each other: `sync-project` never exits non-zero (a sync is
always considered successful once applied), while `validate-addons` exits 1
on *any* finding regardless of severity. `sync-addon-metadata` sits
between them — it's a mutator like `sync-project` but reports blocked rows
like `validate-addons` — so neither precedent could be adopted wholesale.

**CLI flag vs. MCP two-tool hybrid.** The CLI takes a `--dry-run` boolean,
following four existing in-repo precedents for that flag shape
(`sync-project`, `apply-op`, and two others in `cli.ts`). MCP instead gets
a **separate** `preview-addon-metadata-sync` tool (`READ_ONLY`) alongside
the mutating `sync-addon-metadata` tool (`MUTATE`), rather than a `dryRun`
boolean input on one tool — because no other MUTATE tool in this server
takes a `dryRun` input, and putting one on `sync-addon-metadata` would
place a pure preview behind the client-side approval prompt that a
`MUTATE` annotation triggers. `apply-recipe`'s existing
`validate-recipe`/`apply-recipe` pairing is the precedent for exactly this
asymmetry — a dry-run preview as its own `READ_ONLY` tool, a separate
mutating tool for the real thing.

The preview tool is named `preview-addon-metadata-sync`, not
`validate-addon-metadata-sync` or similar, specifically to stay clear of
the CI-gating `validate-*` family (`validate-addons`, `validate-project`,
`validate-recipe`) and avoid re-creating the near-duplicate-name confusion
ADR 0009 rejected for the command surface itself.

**MUTATE plumbing departures.** This is the first `MUTATE` tool in the
addon-tooling cluster, so it's the first addon tool to touch the
watcher/txId model at all. Two departures from the closest precedent
(`sync-project`'s MCP tool), both deliberate:

- `watcher.bump()` is conditional on `result.wrote`, not unconditional.
  `sync-project`'s MCP handler bumps unconditionally because that tool is
  always in write mode when it runs; `sync-addon-metadata` has three
  genuine no-write paths (`package-from-manifest`, a `manifest-from-package`
  dry-run, and a `manifest-from-package` apply with zero `would-change`
  rows) where bumping would falsely invalidate every other client's `txId`
  for a file that was never touched.
- No `watcher.expect()` call. The sole write targets a path
  (`project.c3proj`) that already exists and is already watched, and it
  happens entirely inside the synchronous `watcher.suppress(...)` window —
  the same rule `sync-project`'s handler already follows, so no new pattern
  was introduced, just applied to a second write site.

`extractedDirty` is untouched by either direction: `project.c3proj` isn't a
generator input (`generateSidRegistry` reads `project.containers` only),
and the watcher's own `onSourceChange` wiring already excludes
`project.c3proj` from the set of paths that dirty `extracted/`.

**`--addon` is id-only.** `sync-addon-metadata`'s `--addon` argument
accepts a discovered addon's resolved id (or its bare archive filename)
only — it deliberately does **not** accept a path to a raw addon source
tree, unlike `validate-addons`/`diff-addon-aces`'s `<id|path>`
(`resolveAddonTarget` in `addonDiscovery.ts`). `resolveAddonTarget`'s path
mode produces an addon with `archivePath: ""` — no package, and therefore
no `usedAddons` join to mutate. Since this tool's entire job is writing
into a discovered package's matching manifest entry, a path-shaped
`--addon` would resolve to a structural no-op. A half-supported option
that silently does nothing is worse than a clearly id-only one that
rejects a path outright (`resolveAddonSyncScope` returns
`{ error: "--addon takes an addon id, not a path" }` for anything
containing a separator, `..`, or an absolute path).

## Compromise

**Command surface — three options weighed:**

- **`--fix` on `validate-addons` (rejected)** — that command has no
  severity concept and is documented as a CI-gate member; a writer flag on
  it is one typo away from mutating a project inside a validation pipeline.
- **`sync-project --section usedAddons` (rejected)** — four independent
  shape mismatches (no disk-folder section, strict vs. required-tolerant
  manifest read, no existing direction concept, dry-run already a separate
  command) — see Decision above.
- **A new, separate `sync-addon-metadata` command (chosen)** — costs one
  more CLI subcommand and one more MCP tool pair in a cluster that already
  has five, but each of the three rejected folds carried a real correctness
  or safety cost the separate command avoids, and — unlike #98/#108's
  folds — ADR 0009's naming-collision rationale that decided those two
  doesn't apply here at all (see Decision above).

**Direction flag shape — two options weighed:**

- **Two separate verbs/commands, one per direction (rejected)** — would
  hide that this is fundamentally one reconciliation with a choice of
  source-of-truth side, and would need its own pair of near-duplicate names
  (echoing the exact confusion ADR 0009 already rejected once in this
  cluster).
- **One command, a mandatory `--direction` enum (chosen)** — keeps the
  operator's choice explicit and structurally enforced (no default to
  silently get wrong), at the cost of one direction value being
  read-only-only, which the report framing (`formatRowHeader`) makes
  explicit rather than hiding.

**Exit-code policy — two precedents, neither adoptable as-is:**

- **`sync-project`'s always-0 (rejected as the sole rule)** — would hide
  `blocked` rows (ambiguous ids, editor-only entries) from a CI caller
  entirely.
- **`validate-addons`' exit-1-on-any-finding (rejected as the sole rule)**
  — would fail a successful, fully-applied sync just because it had
  something to do, punishing exactly the case that should read as success.
- **"Exit 1 iff outstanding human work remains" (chosen)** — a rule
  specific to this tool's blend of mutation + reporting, not a direct
  adoption of either precedent.

## Consequences

- `sync-addon-metadata` ships as a CLI subcommand (`--direction`
  mandatory, `--addon` optional id-only scope, `--dry-run`) and as a
  `MUTATE` MCP tool, paired with a `READ_ONLY` `preview-addon-metadata-sync`
  MCP tool for the dry-run case.
- `src/c3/addonMetadataSync.ts` is off the `src/index.ts` barrel, matching
  every other addon-tooling sibling — no new published API (see CLAUDE.md §
  "Public-API surface = the `src/index.ts` barrel").
- `project.c3proj` now has two writers (`projectSync.ts`, `addonMetadataSync.ts`)
  sharing one unenforced parse-by-identity/mutate-in-place discipline,
  cross-referenced in comments at both write sites; routing both through a
  single shared serialization call is a deferred, separately-tracked
  follow-up.
- The old name `sync-addon-version` persists in the burbank reconciliation
  comment and in `claude-code-plugin-gvt-construct3#32`, both outside this
  repo and not corrected by this change.
- `validate-addons`' `checkMetadataMismatch` and this feature's
  `classifyAddon` now apply the identical `author`/`version` comparison
  rule (the `id` branch removed as a prep step in `2635b86`) — a duality
  the module docstrings cross-reference so the two stay in sync if the
  field set changes again.
- The #100 c3addon-tooling umbrella's last capability (8) now closes, along
  with #145.
