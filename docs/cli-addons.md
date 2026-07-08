# CLI Reference — Addon Tooling

Bundled `.c3addon` package commands (`read-addon`, `validate-addons`), split out of
[cli.md](cli.md) as the c3addon-tooling cluster (#100 umbrella, #106–#111/#98)
grows. Both commands accept the global `--project-dir` option — see
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

Read-only check that bundled `.c3addon` packages under `addons/plugin/` and `addons/effect/` are consistent with `project.c3proj`'s `usedAddons` manifest and internally well-formed. Reports **metadata mismatches** (`id`/`name`/`author`/`version` differing between the package's `addon.json` and the matching `usedAddons` entry, matched by `id`) and **package-integrity** problems (un-materialized git-lfs pointer, malformed zip, a missing required entry (`addon.json`/`aces.json`), or an addon `id` that doesn't match its package filename). `c3runtime` is deliberately not required — plugin/effect layouts vary. Orphan/missing/duplicate addon detection is out of scope (tracked separately as [#108](https://github.com/GenvidTechnologies/construct3-chef/issues/108)).

```bash
npx construct3-chef validate-addons [--project-dir <path>]
```

No options beyond `--project-dir`. Exits with code 1 if any finding is reported, so it fits a project's `commands.validate` chain.

```
Checked 6 bundled addon(s), 5 issue(s):
  addons/plugin/Complete.c3addon: version mismatch — package '1.0.0.0' vs project.c3proj '1.0.0.9'
  addons/plugin/CorruptZip.c3addon: malformed zip (not a valid .c3addon archive)
  addons/plugin/LfsPointer.c3addon: un-materialized LFS pointer (git-lfs not fetched)
  addons/plugin/Misnamed.c3addon: addon id 'NotMisnamed' does not match package filename 'Misnamed'
  addons/plugin/MissingAces.c3addon: missing required entry: aces.json
```

The clean case prints `Checked N bundled addon(s): all consistent.` Output uses the same `formatAddonValidation` formatter as the MCP `validate-addons` tool, so results are byte-identical between surfaces.
