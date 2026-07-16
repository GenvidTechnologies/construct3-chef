# 0012. `scan-addon-usage`: effect addon support

- **Status:** Accepted
- **Date:** 2026-07-16
- **Issue:** [#125](https://github.com/GenvidTechnologies/construct3-chef/issues/125)

## Context

[ADR 0010](0010-scan-addon-usage-plugins-only-v1.md) shipped `scan-addon-usage`
plugins-only, splitting behavior/effect/expression usage into their own
follow-up issues. [ADR 0011](0011-scan-addon-usage-behavior-support.md) then
extended it to behavior addons via a `UsageMatcher` seam, and predicted #125
(effect usage) would reuse that same seam as a `createEffectUsageMatcher`.
#125 is that follow-up: given an effect addon, report where a project
actually applies it.

Effects differ from plugins and behaviors in a way that invalidates the
`UsageMatcher` prediction: **effects have no ACEs** — no conditions, actions,
or expressions. There is no event-sheet call-site tier for an effect at all;
an effect is applied via an `effects{}`/`effectTypes[]` block on an object
type, family, layer, or layout, and that application *is* the usage — there's
nothing further to call. So "presence" and "usage" collapse into a single
concept for effects, unlike plugins/behaviors where presence (an instance
exists) and call sites (an ACE is invoked) are separate tiers.

## Decision

**Option B: a dedicated `scanEffectUsage` path, not a `createEffectUsageMatcher`.**
This is an explicit course-correction from ADR 0011's prediction. Tracing the
real requirement invalidated the `UsageMatcher` extension for two independent
structural reasons:

- **No event nodes.** The `UsageMatcher` seam is node-centric — `matches(node)`
  asks "does this condition/action node call the addon?" Effects have no
  ACEs and no event-sheet nodes, so `matches(node)` is meaningless and the
  entire `visitEvents` event-walk the shared shell drives is inapplicable.
- **Layers/layouts aren't `ObjectDefn`s.** The matcher's `presence` is derived
  from the `ObjectDefn[]` it's handed, and it holds no project handle beyond
  that. Effect application sites include layers and layouts (see the
  four-site model below), which are not object types/families and never flow
  through `readProjectObjects` — the matcher structurally cannot produce
  those presence rows no matter how its `matches`/`attributeTo` hooks are
  filled in.

So effects take a dedicated `scanEffectUsage(rootDir, target, fromArg?)` in
`src/c3/addonAceUsage.ts` (off-barrel, alongside its plugin/behavior
siblings) that shares the result types and the single `formatAddonUsage`
renderer, but bypasses the event-walk shell entirely — it reads presence
sites directly instead of driving a matcher through `visitEvents`. The public
`scanAddonUsage` dispatches to it on `target.kind === "effect"`, before any
ACE read (there is nothing to read — no `aces.json` entries apply).

**The four-site effect data model.** Effects are identified by `effectId` in
an `effectTypes[]` array, applied at four sites:

- (a) object-type `objectTypes/*.json`
- (b) family `families/*.json`
- (c) layer `layouts/*.json` (each layer, recursing `subLayers`)
- (d) layout top-level `layouts/*.json`

Reading (a)/(b) extends `ObjectDefn` additively (`effectTypes: EffectRef[]`,
mirroring the `behaviors: BehaviorRef[]` shape ADR 0011 added); reading (c)/(d)
is new — a `readLayoutEffects` reader in `projectObjects.ts`, since layers and
layouts have no `ObjectDefn` representation to extend.

**Per-instance `effects{}` blocks (site e) are deliberately out of scope.** An
effect applied at the object-type level applies to every instance of that
type, so object-type presence (a) already subsumes per-instance detection for
the purpose of this scan — enumerating every instance placement that also
happens to override the effect would report the same fact redundantly.

**Redefined blast for effects.** There are no ACE param signatures to diff, so
`--from` blast radius is redefined for this addon kind: every application
site is in the radius of a version bump, since any of them could break
regardless of which specific ACE-shaped surface changed (there isn't one) —
`blast.affectedCount = effectSites.length`. The CLI's existing exit-1-in-blast-
mode gate is unchanged and fires whenever the effect is applied anywhere.
`--from` still resolves the prior-version source (for its label and to
confirm it exists), but computes no ACE diff against it.

## Compromise

**Where to put effect-kind-specific logic — three options weighed:**

- **Option A: force effects through `UsageMatcher` with a no-op `matches()`
  (rejected)** — the seam could technically be stretched by giving effects an
  always-true (or always-false) `matches` and driving presence off a
  synthetic pseudo-node set, but this is dishonest about what the seam
  models (event-sheet call sites) and still structurally cannot yield
  layer/layout presence rows, since the matcher only ever sees
  `ObjectDefn[]`. Forcing the fit would require *also* growing the seam to
  carry layer/layout data it was never designed to hold, defeating the
  point of reusing it.
- **Option C: refactor the seam into presence/call-site stages (rejected)** —
  splitting `UsageMatcher` into a presence-stage and a call-site-stage would
  let effects opt into presence-only. But this is over-abstraction for the
  one addon kind (of three) whose presence read itself needs a different data
  source (layers/layouts, not `ObjectDefn`) — the refactor would pay for
  generality that only effects need, while plugins and behaviors keep working
  unchanged either way.
- **Option B: a dedicated `scanEffectUsage` path (chosen)** — effects are
  presence-only and their presence sources don't fit the `ObjectDefn` shape
  the matcher seam was built around; a separate function that reuses only the
  result types and the renderer is the honest shape, and doesn't force
  the shared shell to bend around a case it wasn't designed for.

## Consequences

- `scan-addon-usage` now resolves and scans **plugin**, **behavior**, and
  **effect** addons. Only expression usage (#123) remains, so #100 (the
  c3addon-tooling umbrella) stays open until it lands.
- `ObjectDefn` gains an additive `effectTypes: EffectRef[]` field (object-type
  and family effect presence), and `projectObjects.ts` gains a new
  `readLayoutEffects` reader for layer/layout presence — neither is a
  `UsageMatcher` extension.
- `scanEffectUsage` is a separate code path from the shared plugin/behavior
  shell in `addonAceUsage.ts`; it shares `PresenceRow`/`CallSite`-shaped
  result types and `formatAddonUsage` rendering, but drives no event-sheet
  walk, since effects have no ACEs and no call sites to find.
- `--from` blast radius for effects means "every application site," not a
  diffed changed/removed ACE set — there is nothing ACE-shaped to diff.
- Built-in effects (e.g. the fixture's `burn`) remain unscannable by id, same
  as built-in plugins and behaviors (ADR 0010, ADR 0011) — no bundled
  package, no ACE-or-presence source to resolve against.
- All new modules stay off the `src/index.ts` barrel, matching every other
  addon-tooling sibling — no new published API (see CLAUDE.md § "Public-API
  surface = the `src/index.ts` barrel").
