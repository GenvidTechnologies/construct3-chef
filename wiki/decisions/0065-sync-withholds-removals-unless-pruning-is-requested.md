---
type: decision-record
title: "0065. sync withholds removals unless pruning is requested"
description: >-
  `runSync` applies additions only. Every removal (a file item, a subfolder and
  each entry in it, an absent section directory, a name-section `missing`,
  both halves of a move, `folder-missing`, a stale duplicate) is reported with
  `[withheld]` and the manifest keeps the entry, until `sync-project --prune`
  (MCP `prune: true`) applies it. The scaffold syncs never prune. A file-section
  move keeps its SID, classified by c3source's `diffNameMaps` over chef's own
  walk. `formatSyncReport` is the one renderer. A breaking change of a public
  default, released as a major
  ([#346](https://github.com/GenvidTechnologies/construct3-chef/issues/346))
tags: [decision, sync, safety, breaking]
status: stable
generated: { by: process:tech-writer, at: 2026-10-31T00:00:00Z }
---

# 0065. sync withholds removals unless pruning is requested

- **Status:** Accepted
- **Date:** 2026-10-31
- **Issues:** [#346](https://github.com/GenvidTechnologies/construct3-chef/issues/346). Upstream request: [c3source#110](https://github.com/GenvidTechnologies/c3source/issues/110).
- **Relates to:** ADR [0004](0004-dual-surface-shared-library-and-formatters.md) (one rendering for both surfaces), ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) (upstream ownership), ADR [0016](0016-shared-file-walk-adoption-triage.md) (the walk stays local; not reopened), ADR [0023](0023-stray-files-are-a-detection-only-report.md) (§2 is reread, not superseded), ADR [0025](0025-stray-gating-is-cli-only-and-survives-a-manifest-failure.md) (§4 and §5), ADR [0050](0050-self-written-watched-paths-are-registered-before-the-write.md) (`beforeWrite`), ADR [0061](0061-sync-treats-the-timelines-transitions-container-as-always-present.md) (unresolvable entries still throw).

## Context

Before this change, `sync-project` removed a manifest entry whenever its file was absent from disk. On the burbank project an agent ran a sync while a file was only temporarily absent. The entry was dropped silently, `validate-project` then passed because the manifest now matched the disk, and re-adding the file minted a new SID. The original SID, and with it every reference to the file, was lost with no signal at any step ([#346](https://github.com/GenvidTechnologies/construct3-chef/issues/346)).

Two further gaps made the output unreliable as a warning:

- A file moved to another folder was reported as a removal plus an addition, so its SID changed even when the move was exactly what the user did.
- A removed subfolder was one `- dir/` line; the entries it dropped were not listed.

## Decision

**Removals are withheld by default, everywhere `runSync` runs.** `runSync` applies additions only (new items, new folders). Every `-` change is computed, reported and marked `withheld`, and the manifest is left unchanged for it. That covers a file item; a file subfolder and each entry inside it; an absent section directory; a name-section `missing`; both halves of a `moved`, in name sections and file sections; `folder-missing`; and a stale duplicate. A move is withheld as a unit, because applying only its add half would create a duplicate name: a uniqueness break in a name section, a second entry with a fresh SID beside the stale one in a file section.

- **`--prune` / `prune: true` applies them.** `runSync(..., { prune: true })` applies removals as the code did before, with two differences that hold on both prune settings and for direct callers of `syncFileFolder`: a file-section move keeps its SID and reads `(kept sid=…)`, and a removed subfolder lists each entry it drops. The primitives `syncFileFolder` and `applyNameDrift` take an optional `withhold` that defaults to false, so a direct caller still gets removals applied; the policy lives in `runSync`, which passes `withhold: !prune`.
- **The scaffold syncs never prune.** `scaffold-layout` and `scaffold-sprite`, on both surfaces, have no `prune` input and always withhold.
- **`validate-project` runs the default dry sync.** It therefore shows exactly what a default sync would withhold, and the CLI exits 1 while any withheld entry remains. `sync-project` itself exits 0 when removals are withheld.
- **A file-section move keeps its SID and `*-info`.** Classification is c3source's `diffNameMaps` (the rule it already applies to name sections: a name occurring exactly once on each side at different paths is `moved`, every other name gets a per-path `missing`/`untracked`), fed by chef's own lockstep walk over the manifest and the disk. Applying a move transplants the existing item, so no SID is minted. The `+` half's detail reads `(kept sid=<sid>)` rather than `(new, sid=<sid>)`.
- **A removed subfolder lists each entry it drops,** depth-first, items before folders, each as `- dir/name` or `- dir/nested/`, then `- dir/`. `sections.<key>.removed` counts them.
- **`formatSyncReport` is the one renderer,** called only through `runSync`, so the CLI and MCP outputs cannot drift (ADR 0004). A withheld line ends in ` [withheld]`; a move half carries ` (moved to <path>)` or ` (moved from <path>)`. The summary is `N change(s) found: A addition(s), R removal(s).`, followed, when any removal is withheld, by a line naming the opt-in (`CLI --prune, MCP prune: true`). For a withheld move both halves carry `withheld`, the `+` half included. The addition count therefore includes a withheld `+`, while the closing "removal(s) withheld" line counts only `-` changes.

**Semver.** This flips the default of public API (`runSync`, CLI and MCP `sync-project`): a scripted consumer that relied on sync removing stale entries silently stops getting removals. It is a breaking change released as a major, and was committed as a `fix!:`. This was the user's decision at the design checkpoint; the alternative was a minor with a prominent changelog callout.

**ADR 0025.** `prune` is the first mutation-scoping boolean input on an MCP tool. It respects ADR 0025 §4 (no `isError` flip: a withheld removal is not a tool failure) and §5 (`sync-project` exits 0 when removals are withheld; `validate-project` is the gate).

**ADR 0023 §2 is reread, not superseded.** ADR 0023 §2's silence covers project-wide **audit** reports (`[strays]` and `[images]`), and the scaffolds still add none. A scaffold's own sync lines, including `[withheld]` ones, report what that scaffold's sync did or declined to do: what it scaffolded, not an audit of the project. A `[withheld]` line tells the agent that its sync left drift.

**ADR 0016 is not reopened.** Upstream's file-section drift does not fit, for two reasons: the undeclared-subdirectory blindness (probe P1 moved `files/sample.gif` into a new `files/sub/`, and c3source reported `missing` only, with no `moved` and no `untracked`; probe P3 declared `x.txt` in `a/` and `b/` but had it on disk in `a/` and a new `c/`, and c3source never saw `c/x.txt`), and the missing folder entries. The classifier does fit, because it takes two `{name, path}` lists and nothing else. The walk stays local for the same mismatches as before, and only the classifier is adopted. The upstream request is [c3source#110](https://github.com/GenvidTechnologies/c3source/issues/110): `rootFileFolders` drift misses files under undeclared subdirectories, so a move into a new folder reads as `missing`.

## Alternatives considered

- **Chosen: Option A: withhold every removal by default; removing needs an explicit `prune` (recommended).** It is the only option that keeps the SID of an absent file, which is the harm in the incident, and the only one that also covers the scaffold paths.
- **Rejected: Option B: keep removing, make it loud.** Removals still apply; the formatter, per-entry subfolder lines, summary counts and SID-preserving moves ship as in A, plus a trailing `N entries removed; restore from git if unintended` line. It is non-breaking and adds no input, but it does not fix the issue's title (validate still passes after the sync), does not fix SID loss for an absent file (the burbank harm), leaves the scaffold paths deleting, and an agent reading long output can still miss the warning. Prominence is not prevention.
- **Rejected: Option C: a per-project never-remove list (`construct3-chef.config.json`), combinable with B.** It covers only entries listed in advance, so the burbank case would be covered only after the incident. It fails open: the error fallback in `loadChefConfigRaw` silently drops unknown keys. It is launch-fixed on MCP (ADR [0035](0035-mcp-chef-config-is-launch-fixed-per-context.md)), so changing it needs a restart. It forces the synchronous validate and sync CLI handlers to load config and threads config into `runSync`'s signature. On its own it does not meet the requirement that validate surface the loss. It could later serve as a separate expected-absent list to quiet validate for build stamps; that is not proposed here.
- **Rejected: Sub-variant A′ (not recommended): apply SID-preserving moves by default and withhold only true removals.** It is friendlier for reorganising folders, but it contradicts the decision that every `-` change is withheld, and a mis-paired move (deleting `a/x` and creating an unrelated `b/x`) would apply silently. Moves done outside the C3 editor are rare, since the editor rewrites the manifest itself, so A's cost is small.
- **Rejected: a chef-local move pairing instead of `diffNameMaps`.** It would re-derive upstream's rule (about fifteen lines), drift from it, and need a bridge and tripwire under ADR 0006.

## Consequences

- **Behaviour change, major release.** A consumer relying on sync to remove stale entries must now pass `--prune` / `prune: true`. The CLI `validate-project` exits 1 while any withheld entry remains.
- **[#349](https://github.com/GenvidTechnologies/construct3-chef/issues/349):** MCP `validate-project` still reports success; its text carries the `[withheld]` lines.
- **[#354](https://github.com/GenvidTechnologies/construct3-chef/issues/354):** a present non-`.ts` script (for example a declared `.js`) is withheld by default instead of deleted. With `prune` it is removed exactly as before.
- **[#344](https://github.com/GenvidTechnologies/construct3-chef/issues/344):** a stale duplicate is withheld like any `missing`. `drift.duplicates` stays unread, and what to do with duplicates is still #344's question. `applyNameDrift`'s remove-all-occurrences behaviour is unchanged.
- **[#333](https://github.com/GenvidTechnologies/construct3-chef/issues/333):** any repair that removes a folder is a `-` change and falls under `prune`.
- **Move pairing needs exactly-once on each side.** An ambiguous name (the same file name in several subfolders) falls back to remove plus add, today's behaviour, which is the safe direction. The frequency of that shape in real projects was not sampled.
- **Resolution still throws.** A name-section entry that cannot be resolved still throws (ADR 0061), so validate and sync agree even when removals are withheld.
- **`beforeWrite` still fires before the write** (ADR 0050), and `SyncResult` and `SectionSummary` keep their shape; `clean` still means "no changes found".
