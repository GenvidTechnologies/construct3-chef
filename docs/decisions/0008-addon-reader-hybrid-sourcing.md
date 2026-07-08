# 0008. Addon reader: hybrid extracted-dir/archive sourcing

- **Status:** Accepted
- **Date:** 2026-07-07
- **Issue:** [#106](https://github.com/GenvidTechnologies/construct3-chef/issues/106)

## Context

Issue #106 is the foundational piece of the #100 c3addon-tooling umbrella: surface a bundled C3 addon's `addon.json` metadata and full `aces.json` ACE list as shared plumbing that #107 (validate-addons), #108 (orphan/dup detection), #109 (diff-addon-aces), #110 (ACE usage scan), and #98 (validate-addon) all consume rather than each re-implementing unzip.

Today `read-addon` (MCP-only) and `aceRegistry.buildAddonAceRegistry` read only from an addon's already-extracted directory and error if the addon isn't extracted. A `.c3addon` is a zip archive that may be present on disk without an extracted copy, so extracted-dir-only reading under-delivers the "shared `.c3addon` reader" promise the umbrella needs.

## Decision

**Hybrid sourcing (Option C).** A new `src/c3/addonReader.ts` reader prefers the extracted directory when present and falls back to reading the `.c3addon` zip archive directly — both for the whole addon and per-file (a specific file missing from the extracted dir falls through to the zip). This lets sibling tools read `addon.json`/`aces.json` uniformly regardless of whether the addon has been extracted, including the drift-detection case #107 needs (comparing the extracted copy against the authoritative archive).

**Share the parser, not the aggregate.** `aceRegistry.parseAcesJson` is exported (as `mapAcesJsonToEntries`) and reused by the new per-addon reader. `buildAddonAceRegistry`'s existing extracted-only aggregate loop is left untouched, so its output stays provably byte-identical — locked by the existing `aceRegistry.test.ts`.

**Barrel placement.** `addonReader.ts` stays off the `src/index.ts` barrel, matching its siblings `addonDiscovery`/`aceRegistry`/`aceLookup`/`c3Reference`. The consuming sibling tools live in `src/` and import it relatively, so no new published API surface is added (see CLAUDE.md § "Public-API surface = the `src/index.ts` barrel").

**Zip library: `fflate`**, used synchronously (`unzipSync(buf, { filter })`) to match the all-sync `fs` addon code, keeping `readAddonEntry`/`buildAddonAceRegistry`/the CLI synchronous. It is ~30 KB with zero transitive deps and its own types. Zip-slip is inert here: the reader looks up two known entries (`addon.json`, `aces.json`) by exact name and never extracts to disk.

## Compromise

**Sourcing strategy — three options weighed:**

- **(A) Extracted-dir-only (status quo, rejected)** — can't read archive-only addons, and reads a derived copy rather than the authoritative package, which #107's drift detection specifically needs to compare against.
- **(B) Zip-only (rejected)** — discards the cheap existing extracted-dir fast path and the reuse of current plumbing (`readAddonEntry` et al.) for the common already-extracted case.
- **(C) Hybrid (chosen)** — extracted dir first, zip fallback per-addon and per-file. Slightly more branching in the reader than either single-source option, in exchange for correctness across both addon states.

**Aggregate unification — considered and deferred.** A fuller unification would have `buildAddonAceRegistry`'s aggregate also adopt hybrid sourcing. Rejected for this issue: it would newly leak archive-only addons' ACEs into the aggregate registry and break the aggregate's existing byte-identical test. Left as a possible future #107 follow-up rather than forced into #106's scope.

**Zip library — three options weighed:**

- **adm-zip (rejected)** — heavier, carries historical extract-path CVEs that don't apply to this read-only, two-known-entries use, but add unused surface.
- **yauzl (rejected)** — async-only; would force await-plumbing through every currently-synchronous caller (`readAddonEntry`, `buildAddonAceRegistry`, the CLI) for no benefit here.
- **hand-rolled central-directory reader (rejected)** — ~150 LOC of zip64/data-descriptor edge cases to maintain versus a maintained library.
- **fflate (chosen)** — synchronous, minimal, zero deps.

## Consequences

- One pre-1.0 contract change to flag at the next release tag: MCP `read-addon <name>` with no `file` argument now returns the metadata+ACE summary instead of raw `aces.json` contents. The raw file is still reachable via `--file aces.json`. List mode and explicit-`file` mode are otherwise preserved, and `--file` now additionally works on archive-only addons.
- `buildAddonAceRegistry`'s aggregate behavior is unchanged (extracted-only); hybrid sourcing at the aggregate level remains open as a future #107-adjacent follow-up.
- Sibling tools #107/#108/#109/#110/#98 can now depend on `addonReader.ts` for metadata/ACE access instead of each re-implementing archive reading.
