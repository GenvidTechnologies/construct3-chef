# 0011. `scan-addon-usage`: behavior addon support

- **Status:** Accepted
- **Date:** 2026-07-15
- **Issue:** [#124](https://github.com/GenvidTechnologies/construct3-chef/issues/124)

## Context

[ADR 0010](0010-scan-addon-usage-plugins-only-v1.md) shipped `scan-addon-usage`
plugins-only, splitting behavior/effect/expression usage into their own
follow-up issues because each matches usage on a different field than a
condition/action node's `(objectClass, kind, id)`. #124 is the behavior
follow-up: given a behavior addon, report which object types/families carry
their own instance of it (**presence**) and which event-sheet condition/action
nodes call one of its ACEs (**call sites**), plus `--from` blast radius —
reusing the same report shape #110 already established.

Behavior presence and matching differ from plugin presence in two ways that
plugins don't need to handle at all:

- **Presence field.** A plugin instance is a whole object type/family whose
  `plugin-id` names the addon. A behavior instance is *attached to* an object
  type/family via a `behaviorTypes[]` entry (`{behaviorId, name, sid}`) — a
  host can carry several behaviors, and several instances of the *same*
  behavior under different names.
- **Family membership.** A family can attach a behavior to itself; its members
  then carry conditions/actions that reference the family's behavior instance
  (by name, via `behaviorType` on the node) without ever getting their own
  `behaviorTypes` entry. A plugin instance has no equivalent — a plugin
  presence host and its call sites are always the same object.

## Decision

**`UsageMatcher` seam, extracted first.** Before adding behavior support,
`scanAddonUsage`'s single plugin-shaped code path was refactored to isolate
addon-kind-specific behavior (presence rows, the per-node match rule, and
call-site attribution) behind a small `UsageMatcher` interface
(`presence`/`matches`/`attributeTo`), leaving the event-sheet walk, blast-radius
wiring, result assembly, and `formatAddonUsage` shared and kind-agnostic. The
existing plugin path became `createPluginUsageMatcher`; behavior support is
`createBehaviorUsageMatcher`, added alongside it with no change to the shared
shell. `scanAddonUsage` picks the matcher from the resolved addon's `kind`
(`target.kind === "behavior"`).

**Presence: `behaviorTypes[].behaviorId === addonId`, own instance only.** A
host is a presence row when it carries its *own* `behaviorTypes` entry naming
the addon — never by virtue of family membership. A family member that only
inherits a behavior through its family gets no presence row of its own (see
family-member attribution, below). Each presence row additionally carries
`instanceNames` (the host's own instance name(s) for this addon, e.g.
`["Timer"]`, or `["Timer", "Timer2"]` for two instances) so `formatAddonUsage`
can render which instance(s) a host attached — rendered as a trailing
`[Name, ...]` segment, present only on behavior rows.

**Match rule: instance name ∪, then narrowed by attribution.** A
condition/action node identifies which behavior instance it calls by name
(`behaviorType`), not by addon id, and different hosts may name their
instances differently. So the match rule first widens to the *union* of
instance names across every presence host, then narrows back down with an
attribution check: a node matches only when (a) its `behaviorType` is in that
union, (b) its `objectClass` is attributable (a presence host itself, or a
member of a presence family), and (c) its `(kind, id)` is a current ACE (or,
in blast mode, also a removed one — unchanged from #110). The attribution
check is what stops an unrelated object from matching just because it reuses
the same instance-name string for an unrelated behavior.

**Family-member attribution (the non-obvious part).** A behavior attached to
a family produces call sites on the family's *members*, not the family
itself — a member's own conditions/actions carry the member's real
`objectClass` (e.g. `Text`) together with the family's instance name in
`behaviorType` (e.g. `Timer`), because a member never gets its own
`behaviorTypes` entry. `scanAddonUsage` attributes that call site's *count* to
the family's presence row (`attributeTo("Text")` resolves to `"TextFamily"`
via a precomputed `attributeMap` seeded with both the host's own name and
each of its members' names), while the `CallSite` record itself keeps the
member's real `objectClass` unchanged — only the aggregated `callSiteCount`
moves, never the recorded call. Concretely, in the `construct3-chef-sample`
fixture: `TextFamily` carries its own `Timer` instance
(`behaviorId: "Timer", name: "Timer"`), and family member `Text` (not
`TextFamily`) calls `stop-timer` in `Event sheet 2`
(`{objectClass: "Text", behaviorType: "Timer", id: "stop-timer"}`); that call
attributes to `TextFamily`'s presence row, and `Text` gets no presence row of
its own. `attributeMap` is built in `byPresenceOrder` (object types before
families), so a family's member-mapping entries are written after — and take
precedence over — a same-named object type's self-mapping entry, in the
unlikely case both exist.

**Built-in behaviors aren't scannable by id.** `Timer`, `Persist`, and other
C3 built-in behaviors ship no bundled `.c3addon` package, so
`resolveAddonTarget` can't resolve them and there's no ACE set to match
against — `scan-addon-usage Timer` fails with `addon source not found:
Timer`. This is symmetric with the existing inability to scan a built-in
*plugin* (e.g. `Sprite`) by id (ADR 0010 didn't need to call this out, since
plugin usage was already exercised only against addon-provided plugins); both
would need a built-in ACE reference index, which is the deferred #22/#123
work — not a gap this decision closes.

**Prerequisite fix: strip a leading UTF-8 BOM from addon entry reads.** Real
C3-exported `.c3addon` packages — including the `MyCompany_MyBehavior.c3addon`
fixture this feature is tested against — can ship `addon.json`/`aces.json`
prefixed with a UTF-8 BOM (U+FEFF). `JSON.parse` throws on a BOM-prefixed
string, and the surrounding `try`/`catch` in `readAddonEntryWithSource`
silently swallowed the failure to an empty result — so every addon tool
(`read-addon`, `validate-addons`, `list-addons`, `diff-addon-aces`,
`scan-addon-usage`) silently got a zero-ACE, zero-metadata read against such a
package, with no error surfaced. This was latent before #124 (none of the
earlier fixtures happened to be BOM-prefixed) and became load-bearing once a
real Scirra-exported sample behavior was added as a fixture. Fixed once, at
the single chokepoint both read branches (extracted-dir and zip-archive) pass
through, so every addon tool benefits — not scoped to the behavior path.

**Discovery/classification widened to `addons/behavior`.** `ADDON_DIRS`
gained `"addons/behavior"`, and `DiscoveredAddon.kind`/`AddonInfo.kind`
widened from `"plugin" | "effect"` to also include `"behavior"`, with
`discoverAddons`/path-mode `readAddonKind` classifying accordingly (the
latter reading `addon.json`'s `type` field, now recognizing `"behavior"` in
addition to `"effect"`). This is required for `scan-addon-usage` to resolve a
behavior addon id at all, and incidentally widens every other addon-tooling
command's discovery too. One latent bug was caught and fixed alongside it:
`addonLangValidator`'s section-key mapping used a `plugin ? "plugins" :
"effects"` two-way ternary, which filed a behavior addon's lang findings
under the wrong (`"effects"`) key; it's now a three-way
`"plugins" | "effects" | "behaviors"` mapping.

## Compromise

**Where to draw the abstraction — three options weighed:**

- **Duplicate `scanAddonUsage` for behaviors (rejected)** — a full parallel
  function would drift from the plugin path on blast-radius wiring, result
  assembly, and formatting, none of which differ between addon kinds; two
  near-identical ~150-line functions is a worse maintenance shape than one
  seam.
- **`if (kind === "behavior")` branches scattered through the existing
  function (rejected)** — cheaper short-term, but leaves presence-building,
  matching, and attribution logic interleaved per addon kind inside one
  function, which is exactly the shape #125 (effects) would have to
  re-branch into a third time.
- **Extract a `UsageMatcher` seam, plugin path becomes the first
  implementation (chosen)** — isolates the three addon-kind-specific
  decisions (presence rows, per-node match rule, call-site attribution)
  behind one small interface; the shared shell (event-sheet walk,
  blast-radius diff wiring, result assembly, `formatAddonUsage`) doesn't
  change per addon kind at all. This is explicitly the reuse point #125 is
  expected to extend with a `createEffectUsageMatcher`, per the module doc
  comment in `addonAceUsage.ts`.

**Family-member attribution — two options weighed:**

- **No presence row gets credit; drop the call site from the count entirely
  (rejected)** — technically simpler, but it's misleading: the family
  genuinely does have a call site through in-use member, and hiding it from
  every count would make the tool look silent about actual behavior usage.
- **Attribute the call site's count to the owning family's presence row,
  keep the call site's own recorded `objectClass` (chosen)** — matches how a
  C3 developer actually reasons about it ("the family owns this behavior
  instance; `Text` is just where the call happens to be written"), and
  preserves the real object identity in the call-site listing so nothing is
  silently renamed.

## Consequences

- `scan-addon-usage` now resolves and scans **plugin** and **behavior**
  addons; effect and expression usage remain #125/#123, and the #100
  c3addon-tooling umbrella stays open until those land.
- The `UsageMatcher` seam (`presence`/`matches`/`attributeTo`) in
  `src/c3/addonAceUsage.ts` is the extension point #125 is expected to reuse
  (a `createEffectUsageMatcher`), rather than re-branching the shared shell.
- `PresenceRow.instanceNames` is additive and behavior-only; plugin/effect
  presence rows never carry it, so their rendering is unchanged.
- The family-member attribution rule (member's own `objectClass` on the call
  site, count attributed to the family's presence row) is the one piece of
  this design that isn't obvious from the CLI output alone — it's called out
  explicitly in the `addonAceUsage.ts` module doc comment and in
  `docs/cli-addons.md` so a future reader doesn't "simplify" it into
  attributing to the member instead.
- Built-in behaviors (`Timer`, `Persist`, …) remain unscannable by id — same
  limitation as built-in plugins, deferred to #22/#123 (a built-in ACE
  reference index).
- The BOM-stripping fix in `addonReader.ts`'s `readAddonEntryWithSource`
  benefits every addon-tooling command, not just `scan-addon-usage` — any
  bundled `.c3addon` shipping a BOM-prefixed `addon.json`/`aces.json` was
  previously silently read as empty.
- `ADDON_DIRS`/`DiscoveredAddon.kind`/`AddonInfo.kind` now cover
  `addons/behavior`, widening discovery for `read-addon`, `validate-addons`,
  `list-addons`, and `diff-addon-aces` as a side effect, alongside the
  `addonLangValidator` section-key fix for behavior addons' lang findings.
- Off the `src/index.ts` barrel, matching its addon-tooling siblings — no new
  published API (see CLAUDE.md § "Public-API surface = the `src/index.ts`
  barrel"). `createBehaviorUsageMatcher` is exported from the (off-barrel)
  module only so tests can drive the family-member attribution rule directly
  against synthetic `ObjectDefn`s — the project's own `TextFamily`/`Timer`
  fixture data exercises the real shape, but `Timer` itself can't be scanned
  end-to-end through `scanAddonUsage` (see the built-in limitation, above).
