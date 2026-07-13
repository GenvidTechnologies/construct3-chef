# CLI Reference — Addon Tooling

Bundled `.c3addon` package commands (`read-addon`, `validate-addons`, `list-addons`,
`diff-addon-aces`), split out of [cli.md](cli.md) as the c3addon-tooling cluster
(#100 umbrella, #106–#111/#98/#109) grows. All commands accept the global
`--project-dir` option — see [cli.md § Global Options](cli.md#global-options).

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
