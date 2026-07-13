# 0010. `scan-addon-usage`: plugins-only v1 scope

- **Status:** Accepted
- **Date:** 2026-07-13
- **Issue:** [#110](https://github.com/GenvidTechnologies/construct3-chef/issues/110)

## Context

Issue #110 is the last P3 leaf of the #100 c3addon-tooling umbrella: given an
addon, report where a project actually *uses* it — which object types/families
are instances of the addon, and which event-sheet condition/action nodes call
one of its ACEs — and, given an old-version ACE source, which of those call
sites fall in the addon's changed/removed surface (the "blast radius" of a
version bump). It builds on `addonReader`/`readAddonAces` (ADR 0008) and
`diffAddonAces` (#109).

C3 addons expose usage through several different surfaces: plugin ACE calls
in event sheets, addon-provided behaviors attached to object types, addon
effects applied to layout objects, and addon expressions used inside event
parameter strings. These surfaces don't share a common scan shape.

## Decision

**Plugins-only v1.** `scanAddonUsage` (`src/c3/addonAceUsage.ts`) scans only
plugin condition/action call sites in event sheets. Layouts carry no plugin
ACE call sites at all — a layout instance is object *placement*
(`instances[].type` + property overrides), not conditions/actions — so
plugin usage is inherently event-sheet-only; there is no layout-side gap in
scope here.

**Behavior, effect, and expression usage are split into their own follow-up
issues, not folded into #110**, because each matches on a fundamentally
different field than a condition/action node's `(objectClass, kind, id)`:

- **Expression usage (#123)** lives inside event *parameter strings*
  (`"functions.foo(1)"`-style text), not structured condition/action nodes —
  finding a call requires parsing those strings, which `scanAddonUsage`
  deliberately doesn't attempt (see the `aceKeySet` filter that excludes
  `kind === "expression"` from the call-site match set entirely).
- **Behavior presence (#124)** keys on an object type's `behaviorTypes[]`
  array, not `plugin-id` — a different field on the same `ObjectDefn` shape,
  and needs `addonDiscovery`/`readAddonMetadata` extended to also enumerate
  addon-provided behaviors (today scoped to plugins/effects).
- **Effect usage (#125)** is a layout-side scan (which layout objects apply
  the effect, e.g. `Sprite.effects[]`) with no ACEs involved at all — it
  doesn't fit the ACE-call-site shape this tool was built around.

Because #123/#124/#125 remain open, **#110 does not auto-close the #100
umbrella** — the umbrella issue stays open until all three land.

**The `readProjectObjects`/`ObjectDefn` seam is factored out now, not
inlined**, specifically so #124/#125 can reuse the object-type + family
enumeration (`src/c3/projectObjects.ts`) instead of re-walking
`findAllObjectTypes()`/`findAllFamilies()`. `ObjectDefn` already carries
`members` (family membership) unused by #110 today, anticipating that
follow-ups extend the shape additively (e.g. a `behaviorTypes` field) rather
than each rolling a parallel reader.

**Blast set = changed ∪ removed (added excluded), with a widened call-site
match in blast mode.** `scanAddonUsage`'s optional `--from` blast-radius mode
diffs the old ACE source against the addon's current ACEs
(`diffAddonAces`) and takes the `changed`/`removed` buckets — `added` is
excluded because no pre-existing call site can reference an ACE that didn't
exist yet. The non-obvious part: blast mode widens the call-site *match set*
itself to `currentAceSet ∪ removedKeys`, not just the *marking* of matches.
A call to a since-removed ACE is by definition absent from the addon's
current ACE list, so the plain (non-blast) match rule — `(kind, id)` present
in current ACEs — would silently drop it from the scan entirely. That
dangling call is exactly the stale-reimport fallout (an addon upgraded, an
event sheet not migrated) the blast mode exists to catch, so widening the
match set is load-bearing, not cosmetic.

**Identity key: `(kind, id)`, not `objectClass`.** Matching a call site to a
current ACE, and an ACE to a diff bucket, keys on `(kind, id)` throughout —
never `objectClass`, which is the caller-supplied addon name passed into
`mapAcesJsonToEntries` and is constant per addon while differing across
versions with different filenames (see the `aceRegistry.ts` docstring). This
follows the #109 `diff-addon-aces` precedent directly.

**Blast input: inline `--from`, not a saved diff file.** `--from` accepts the
same source forms as `diff-addon-aces`'s `from`/`to` arguments (addon id,
`.c3addon` path, extracted dir) and `scanAddonUsage` runs `diffAddonAces`
internally, rather than consuming a previously-saved `diff-addon-aces --json`
output. This is the lowest-friction shape for the common case (compare
against a specific old version you have on hand) and avoids forcing a new
persisted output format onto `diff-addon-aces` just to feed this tool.

## Compromise

**Scope — three options weighed:**

- **All four usage surfaces in one #110 (rejected)** — behaviors, effects,
  and expressions each need a different match field and, for behaviors, a
  discovery-layer extension; bundling them would make #110 a multi-shape
  grab-bag instead of one well-scoped ACE-call-site scanner, and would block
  shipping the plugin case on unrelated parsing/discovery work.
- **Plugins + expressions only (rejected)** — expressions are the closest
  cousin (also ACE-shaped), but still requires a parameter-string parser
  that plugin/condition/action scanning doesn't need; folding it in would
  couple an orthogonal parsing effort to this scan's ship date.
- **Plugins-only, with expressions/behaviors/effects split out as #123/#124/
  #125 (chosen)** — ships the well-defined, structurally uniform case now;
  each follow-up gets its own scoped issue with its own match strategy.

**Blast-input source — two options weighed:**

- **Consume a saved `diff-addon-aces` output (rejected)** — would require
  `diff-addon-aces` to grow a stable persisted JSON format before #110 could
  build on it, and adds a two-step workflow (diff, save, then scan) for no
  benefit over just pointing both tools at the same two sources.
- **Inline `--from`, running `diffAddonAces` internally (chosen)** — one
  command, one invocation; the diff is cheap to recompute and never needs to
  be kept in sync with a stale saved file.

## Consequences

- `scan-addon-usage` ships as a read-only CLI subcommand and MCP tool
  (`READ_ONLY`, with a `txId` footer since it reads the watched
  `SOURCE_DIRS`), scanning event-sheet conditions/actions only.
- The #100 c3addon-tooling umbrella **stays open**: #123 (expression usage),
  #124 (behavior usage), #125 (effect usage) are the remaining leaves.
- `src/c3/projectObjects.ts`'s `readProjectObjects`/`ObjectDefn` is the shared
  seam #124/#125 are expected to extend (additively — new match fields on
  `ObjectDefn`, not a parallel enumeration) rather than re-implementing the
  object-type/family walk.
- Blast mode's match-set widening (`currentAceSet ∪ removedKeys`) is the one
  piece of this design that isn't obvious from the exit-code/marker behavior
  alone; it's called out explicitly in the module doc comment and in
  `docs/cli-addons.md` so it isn't mistaken for an implementation detail that
  could be "simplified" away.
- Off the `src/index.ts` barrel, matching its addon-tooling siblings — no new
  published API (see CLAUDE.md § "Public-API surface = the `src/index.ts`
  barrel").
