# CLI Reference — Addon Tooling

Bundled `.c3addon` package commands (`read-addon`, `validate-addons`, `list-addons`,
`diff-addon-aces`, `scan-addon-usage`), split out of [cli.md](cli.md) as the
c3addon-tooling cluster (#100 umbrella, #106–#111/#98/#109/#110) grows. All
commands accept the global `--project-dir` option — see
[cli.md § Global Options](cli.md#global-options).

```bash
npx construct3-chef <subcommand> [options]
```

---

## read-addon

Read a bundled C3 addon's metadata + ACE summary, a raw entry within it, or list all discovered addons. Addons are read from a hybrid source: the extracted addon directory when present, falling back to decoding the `.c3addon` zip archive directly when the addon hasn't been extracted (or the extracted copy is missing the requested entry).

```bash
npx construct3-chef read-addon [name] [--file <path>] [--project-dir <path>]
```

| Argument/Option | Description |
| --------------- | ----------- |
| `name` | Addon name, e.g. `FixtureClock` (positional, optional). Omit to list all discovered addons. |
| `--file <path>` | Read a raw entry from within the addon (e.g. `aces.json`, `addon.json`) instead of the metadata + ACE summary. |

> **Behavior change (pre-1.0):** with a `name` and no `--file`, this command used to print the raw `aces.json` contents. It now prints a metadata header (id/version/name/author/sdk-version/min-construct-version, parsed from `addon.json`) followed by the full ACE list. The raw file is still reachable via `--file aces.json`. See [ADR 0008](decisions/0008-addon-reader-hybrid-sourcing.md).

```bash
# List all addons discovered under addons/plugin/ and addons/effect/
npx construct3-chef read-addon --project-dir test/fixtures/addon-sample
# FixtureClock  (plugin)  extracted
# FixtureClockArchived  (plugin)  archive only

# Metadata + ACE summary for an extracted addon
npx construct3-chef read-addon FixtureClock --project-dir test/fixtures/addon-sample
# FixtureClock (plugin, extracted)
# id: FixtureClock
# version: 1.0.0.0
# ...
# 3 ACE(s)
# [addon condition] FixtureClock.is-elapsed(duration)
# ...

# Same, for an addon that only exists as a .c3addon archive (no extracted copy)
npx construct3-chef read-addon FixtureClockArchived --project-dir test/fixtures/addon-sample
# FixtureClockArchived (plugin, archive)
# ...

# Raw entry from within the addon, from either source
npx construct3-chef read-addon FixtureClock --file aces.json --project-dir test/fixtures/addon-sample
```

---

## validate-addons

Read-only check that bundled `.c3addon` packages under `addons/plugin/` and `addons/effect/` are consistent with `project.c3proj`'s `usedAddons` manifest and internally well-formed. Reports **metadata mismatches** (`id`/`name`/`author`/`version` differing between the package's `addon.json` and the matching `usedAddons` entry, matched by `id`), **package-integrity** problems (un-materialized git-lfs pointer, malformed zip, a missing required entry (`addon.json`/`aces.json`), or an addon `id` that doesn't match its package filename), and package-consistency problems:

- **orphan** — a clean bundled `.c3addon` on disk (parses fine, no integrity problems) whose addon id is absent from `project.c3proj`'s `usedAddons`. A package that already fails an integrity check is reported via that finding only, not also as an orphan.
- **missing** — a `usedAddons` entry with `bundled: true` that has no matching `.c3addon` package file on disk. `bundled: false` (editor-installed) addons are never flagged.
- **duplicate** — two or more package files, enumerated recursively under `addons/plugin/` and `addons/effect/` (so a stale copy nested in a subfolder is caught), resolving to the same addon id.

`c3runtime` is deliberately not required — plugin/effect layouts vary.

`validate-addons` also cross-checks each addon's `aces.json` (actions/conditions/expressions and their params) and editor-`plugin.js` `properties` (including combo `items`) against every `lang/*.json` locale it ships, catching the "language string missing" class of error that Construct otherwise only surfaces as an opaque error at addon-load time. Each locale is checked independently and findings are reported per file, so a defect in `lang/fr-FR.json` doesn't mask (or get masked by) `lang/en-US.json` being clean. **Lang-presence gate:** an addon that ships no `lang/*.json` at all is silently skipped by this check (not flagged) — it's additive, so addons with no localization are unaffected and package-integrity/metadata findings for them are unchanged. The `properties` check is best-effort: property ids are recovered by scanning the editor `plugin.js` source for `SDK.PluginProperty(...)` string-literal ids, since properties are declared in JavaScript, not JSON; an unparseable or unconventional `plugin.js` causes the check to under-report rather than false-flag (see [ADR 0009](decisions/0009-addon-lang-consistency-check.md)).

```bash
npx construct3-chef validate-addons [--project-dir <path>] [--addon <id|path>]
```

| Option | Description |
| ------ | ----------- |
| `--addon <id|path>` | Scope validation to a single addon instead of every bundled addon. Resolved two ways, tried in order: (1) a discovered bundled addon **id** (matches `discoverAddons`, same as the `read-addon` `name` argument); (2) a **path** to a raw addon source tree (a directory containing `aces.json`, `lang/`, and the editor `plugin.js` — no `.c3addon` archive required). Path mode lets the command run against an addon-dev repo, not just a C3 project with bundled `.c3addon` packages: with no archive, only the aces/properties ↔ lang cross-check runs (package-integrity and `project.c3proj` metadata/orphan checks are skipped, since there's no package or manifest entry to check against). The path is traversal-guarded — it must resolve within `--project-dir`. |

Exits with code 1 if any finding is reported, so it fits a project's `commands.validate` chain.

```
Checked 8 bundled addon(s), 8 issue(s):
  addons/plugin/Complete.c3addon: version mismatch — package '1.0.0.0' vs project.c3proj '1.0.0.9'
  addons/plugin/CorruptZip.c3addon: malformed zip (not a valid .c3addon archive)
  addons/plugin/LfsPointer.c3addon: un-materialized LFS pointer (git-lfs not fetched)
  addons/plugin/Misnamed.c3addon: addon id 'NotMisnamed' does not match package filename 'Misnamed'
  addons/plugin/MissingAces.c3addon: missing required entry: aces.json
  addons/plugin/Orphan.c3addon: orphan — on disk but not in project.c3proj usedAddons (id 'Orphan')
  MissingPkg: missing — declared bundled in project.c3proj but no package file on disk (version 3.2.1.0)
  Dup: duplicate — 2 packages resolve to the same addon id: addons/plugin/Dup.c3addon, addons/plugin/nested/Dup.c3addon
```

The aces/properties ↔ lang findings appear the same way, one line per missing string, e.g.:

```
$ construct3-chef validate-addons --project-dir <project>
Checked 2 bundled addon(s), 4 issue(s):
  LangDefects [lang/en-US.json]: param 'offset' of action 'resync' has no lang name
  LangDefects [lang/en-US.json]: expression 'drift' has no lang entry
  LangDefects [lang/en-US.json]: property 'speed' has no lang name
  LangDefects [lang/en-US.json]: item 'slow' of property 'mode' has no lang string
```

The clean case prints `Checked N bundled addon(s): all consistent.` Output uses the same `formatAddonValidation` formatter as the MCP `validate-addons` tool, so results are byte-identical between surfaces.

---

## list-addons

Read-only **unified inventory** that reconciles three sources into one row per addon id: bundled `.c3addon` packages on disk (flat discovery under `addons/plugin/` and `addons/effect/`, the same set `read-addon` with no name lists), `project.c3proj`'s `usedAddons` entries, and editor-only addons. Each row carries a **status**, the declared **version**, and — for on-disk addons — the **package path**:

- **bundled** — declared in `usedAddons` **and** present on disk.
- **editor-only** — a `usedAddons` entry with `bundled: false` (supplied by the C3 editor's installed addons; no package expected on disk).
- **missing** — a `usedAddons` entry with `bundled: true` but no package file on disk.
- **orphan** — a package on disk with no matching `usedAddons` entry.

Rows are keyed by the addon's real `id` (from `addon.json`, falling back to the package filename), so a package whose filename diverges from its id still matches its manifest entry. The version shown is the project's **declared** (`usedAddons`) version when present, else the package's `addon.json` version; version *mismatches* between the two are `validate-addons`' job, not this listing's. Where `validate-addons` reports package-consistency problems as *findings* (and exits non-zero), `list-addons` presents the same reconciliation as an *inventory* and never fails — it's for eyeballing what a project pulls in.

```bash
npx construct3-chef list-addons [--project-dir <path>]
```

```
10 addon(s):
  CleanControl  bundled  2.3.4.5  addons/plugin/CleanControl.c3addon
  Complete  bundled  1.0.0.9  addons/plugin/Complete.c3addon
  CorruptZip  orphan  —  addons/plugin/CorruptZip.c3addon (not in project.c3proj)
  Dup  bundled  1.0.0.0  addons/plugin/Dup.c3addon
  EditorOnly  editor-only  —
  LfsPointer  orphan  —  addons/plugin/LfsPointer.c3addon (not in project.c3proj)
  MissingAces  orphan  1.0.0.0  addons/plugin/MissingAces.c3addon (not in project.c3proj)
  MissingPkg  missing  3.2.1.0  (declared bundled, no package on disk)
  NotMisnamed  orphan  1.0.0.0  addons/plugin/Misnamed.c3addon (not in project.c3proj)
  Orphan  orphan  1.0.0.0  addons/plugin/Orphan.c3addon (not in project.c3proj)
```

An empty project prints `No addons found.` Output uses the shared `formatAddonInventory` formatter, so the CLI and MCP `list-addons` surfaces are byte-identical. (Duplicate/nested-package detection is intentionally out of scope here — that's a `validate-addons` finding; `list-addons` uses flat discovery.)

---

## diff-addon-aces

Read-only diff of the ACE contract between two addon versions: reports added, removed, and changed ACEs (actions/conditions/expressions), including changed parameter signatures. Built for planning an addon upgrade (e.g. bundled GCore vN → vN+1) — it surfaces the breaking-change surface (a dropped action param, a renamed/removed ACE) before you touch the project.

```bash
npx construct3-chef diff-addon-aces <from> <to> [--project-dir <path>]
```

| Argument | Description |
| -------- | ----------- |
| `from` | First ACE source (positional, required). |
| `to` | Second ACE source (positional, required). |

Each of `from`/`to` is one of:

- a path to a local `.c3addon` file — absolute or relative to cwd. **Not** containment-guarded to `--project-dir`: unlike `read-addon`/`validate-addons`, this command is read-only and exists to diff packages that may live outside the project (e.g. a newly downloaded release archive sitting next to the bundled one).
- a project-discovered addon id (same resolution as `read-addon`'s `name` argument).
- a path to an extracted addon directory.

**Local-only.** A remote source (a GitHub release tag or URL, fetched on the fly) is not yet supported — download both `.c3addon` files first (e.g. `gh release download`) and diff the local files. Remote sourcing is deferred to a follow-up issue.

```
$ construct3-chef diff-addon-aces GCoreV1.c3addon GCoreV2.c3addon
diff-addon-aces: GCoreV1.c3addon → GCoreV2.c3addon
  +1 added, -1 removed, ~1 changed  (1 unchanged)

Added (A):
  [expression] GCore.sdk-version()

Removed (R):
  [condition] GCore.is-legacy-account()

Changed (C):
  [action] GCore.login
    - (token, region)
    + (token)
```

The `objectClass` shown (`GCore`) is resolved from each side's `addon.json` `id`, so it stays stable even when the two archive filenames differ (e.g. a version suffix). The clean case prints `No ACE differences.` An unresolvable source prints `addon source not found: <arg>` and exits 1.

Output uses the shared `formatAceDiff` formatter, so the CLI and MCP `diff-addon-aces` surfaces are byte-identical.

---

## scan-addon-usage

Read-only scan of where a project actually uses an addon: which object types/families are instances of it (**presence**), and which event-sheet condition/action nodes call one of its ACEs (**call sites**). With `--from`, it additionally diffs the addon's current ACEs against an old version and reports the **blast radius** — how many call sites hit an ACE that changed or was removed between the two versions — so an addon upgrade's impact on the project can be assessed before touching anything.

Supports **plugin** and **behavior** addons. Effect usage and expression usage remain out of scope and are tracked as separate follow-ups ([#125](https://github.com/GenvidTechnologies/construct3-chef/issues/125), [#123](https://github.com/GenvidTechnologies/construct3-chef/issues/123) respectively) — each matches on a different field than a condition/action node's `(objectClass, kind, id)`. See [ADR 0010](decisions/0010-scan-addon-usage-plugins-only-v1.md) (the original plugins-only v1 scope) and [ADR 0011](decisions/0011-scan-addon-usage-behavior-support.md) (the behavior extension, [#124](https://github.com/GenvidTechnologies/construct3-chef/issues/124)).

```bash
npx construct3-chef scan-addon-usage <addon> [--from <source>] [--project-dir <path>]
```

| Argument/Option | Description |
| ---------------- | ----------- |
| `addon` | Addon to scan usage of (positional, required). Same resolution as `diff-addon-aces`'s `from`/`to`: a discovered addon id, a `.c3addon` file path, or an extracted addon dir. |
| `--from <source>` | Old-version ACE source (same forms as `addon`) to diff against, enabling blast-radius mode. |

The report has two sections:

- **Presence** — for a **plugin** addon, every `objectTypes/*.json`/`families/*.json` entry whose `plugin-id` names the addon. For a **behavior** addon, every entry that carries its *own* instance of the behavior in `behaviorTypes[]` (an entry whose `behaviorId` names the addon) — a family **member** that only inherits the behavior through its family is never its own presence row; see the family-member attribution rule under "Behavior addons", below. Rows are grouped under "Object types" and "Families", each with its call-site count (`(instantiated, no ACE calls)` when zero); a behavior row additionally renders a trailing `[Name]` segment naming the instance(s) that host attached (`[NameA, NameB]` for two instances of the same behavior on one host).
- **Call sites** — every condition/action node, grouped by event sheet, whose `(kind, id)` matches one of the addon's current ACEs and whose scope is in the presence set: for a plugin addon, its `objectClass` names a presence row directly; for a behavior addon, its `behaviorType` names one of the addon's attached instances **and** its `objectClass` resolves to a presence host (the host itself, or a member of a presence family). Expression usage isn't a structured condition/action node and isn't scanned (see [#123](https://github.com/GenvidTechnologies/construct3-chef/issues/123)).

```bash
$ construct3-chef scan-addon-usage GCore --project-dir <project>
scan-addon-usage: GCore
presence: 2 object type(s), 1 family  call sites: 3

Object types:
  Account   2 call site(s)
  Leaderboard   0 call site(s) (instantiated, no ACE calls)

Families:
  GCoreFamily   1 call site(s)

Call sites:
  Events
    event #3  events[0]   [action] Account.login(token, region)
    event #5  events[1]   [condition] Account.is-authenticated()
    event #8  events[2]   [action] GCoreFamily.sync-progress(slot)
```

The clean case prints `No usage of addon "<id>" found.` An unresolvable addon prints `addon source not found: <arg>` and exits 1.

### Behavior addons

A behavior addon's presence is keyed on `behaviorTypes[]` (each entry's `behaviorId`), not `plugin-id`. A presence row's `[Name]` suffix is the behavior instance name(s) that host attached — usually the same as the addon id, but an object can rename an instance or attach two instances under different names.

```
$ npx tsx src/cli.ts scan-addon-usage MyCompany_MyBehavior --project-dir test/fixtures/construct3-chef-sample
scan-addon-usage: MyCompany_MyBehavior
presence: 2 object type(s), 0 families  call sites: 1

Object types:
  9patch [MyCustomBehavior]   0 call site(s) (instantiated, no ACE calls)
  Sprite2 [MyCustomBehavior]   1 call site(s)

Call sites:
  Event sheet 1
    event #2  events[1].children[1]   [action] Sprite2.stop()
```

**Family-member attribution.** A behavior attached to a *family* (not to any individual member) still produces call sites on the members themselves: a member's own conditions/actions carry its real `objectClass` (e.g. `Text`) and the family's behavior instance name in `behaviorType` (e.g. `Timer`), because a member never gets its own `behaviorTypes` entry — it inherits the family's. `scan-addon-usage` attributes that call site's count to the **family's** presence row (the row that actually declares the behavior instance), while the call-site line itself keeps the member's real `objectClass` — only the aggregated count moves, never the recorded call. In the `construct3-chef-sample` fixture, `TextFamily` carries its own `Timer` instance and family member `Text` calls `stop-timer` (`Text.stop-timer()`, `behaviorType: "Timer"`) in `Event sheet 2`; that call site attributes to `TextFamily`'s row, not a separate `Text` row — once `Timer` is scannable at all (see the built-in limitation, next).

**Built-in behaviors aren't scannable by id.** `Timer`, `Persist`, and other C3 built-in behaviors ship no bundled `.c3addon` package, so there's no ACE set to resolve and match against:

```
$ npx tsx src/cli.ts scan-addon-usage Timer --project-dir test/fixtures/construct3-chef-sample
addon source not found: Timer
```

This is symmetric with not being able to scan a built-in plugin (e.g. `Sprite`) by id — both would need a built-in ACE reference index, which is the deferred [#22](https://github.com/GenvidTechnologies/construct3-chef/issues/22)/[#123](https://github.com/GenvidTechnologies/construct3-chef/issues/123) work, not something `scan-addon-usage` can do today. See [ADR 0011](decisions/0011-scan-addon-usage-behavior-support.md).

### Blast-radius mode (`--from`)

With `--from`, the addon's current ACEs are diffed against the `--from` source via the same machinery as `diff-addon-aces` (`diffAddonAces`), and the resulting **changed** and **removed** buckets (added ACEs are excluded — no pre-existing call site can reference an ACE that didn't exist yet) drive three additions to the report:

- a `blast radius (vs <fromLabel>): N affected call site(s)` summary line;
- a trailing ` ⚠ exposed` marker on **every** presence row whenever the diff has any changed/removed entries — a version bump touches every instance of the addon regardless of whether that particular instance has a matched call site;
- a trailing ` ⚠ CHANGED` or ` ⚠ REMOVED` marker on each affected call-site line.

```bash
$ construct3-chef scan-addon-usage GCore --from GCoreOld.c3addon --project-dir <project>
scan-addon-usage: GCore
presence: 2 object type(s), 1 family  call sites: 3
blast radius (vs GCoreOld.c3addon): 2 affected call site(s)

Object types:
  Account   2 call site(s) ⚠ exposed
  Leaderboard   0 call site(s) (instantiated, no ACE calls) ⚠ exposed

Families:
  GCoreFamily   1 call site(s) ⚠ exposed

Call sites:
  Events
    event #3  events[0]   [action] Account.login(token, region) ⚠ CHANGED
    event #5  events[1]   [condition] Account.is-authenticated()
    event #8  events[2]   [action] GCoreFamily.sync-progress(slot) ⚠ REMOVED
```

**Removed-ACE call sites are not dropped from the scan — they're the point.** In blast mode the call-site *match set* itself is widened to `current ACEs ∪ removed ACEs`, not just the *marking* applied afterward. A call to an ACE that the new version removed is by definition absent from the addon's current ACE list, so the plain (non-`--from`) matching rule would silently exclude it from the report entirely. Blast mode exists specifically to surface that dangling call — a stale event sheet that wasn't migrated after the addon was upgraded — so the widened match is load-bearing: without it, the one call site you most need to see after a breaking upgrade would be the one this tool stayed silent about. See [ADR 0010](decisions/0010-scan-addon-usage-plugins-only-v1.md).

### Exit codes

- **0** — plain scan (no `--from`), or blast-radius scan with zero affected call sites.
- **1** — blast-radius scan with `affectedCount > 0` (fits a project's `commands.validate` chain as an upgrade gate), or an unresolvable `addon`/`--from` source.

Output uses the shared `formatAddonUsage` formatter, so the CLI and MCP `scan-addon-usage` surfaces are byte-identical.
