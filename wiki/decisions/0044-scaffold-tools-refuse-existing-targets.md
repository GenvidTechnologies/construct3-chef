---
type: decision-record
title: "0044. The scaffold tools refuse existing targets"
description: >-
  Amends ADR 0043. `scaffold-layout` and `scaffold-sprite`, on the CLI and in
  MCP, wrote their output with no existence check, silently replacing an
  existing layout or objectType and copying images over its frames. Both now
  refuse, before any write, when the output path exists, when a same-named
  layout or objectType lives in another folder, or when an image the sprite
  scaffold would copy exists. All conflicts are collected into one message
  rendered by a shared off-barrel formatter, so CLI and MCP output are
  byte-identical. There is no overwrite flag
  ([#254](https://github.com/GenvidTechnologies/construct3-chef/issues/254))
tags: [decision, scaffold, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-08T00:00:00Z }
---

# 0044. The scaffold tools refuse existing targets

- **Status:** Accepted
- **Date:** 2026-10-08
- **Issue:** [#254](https://github.com/GenvidTechnologies/construct3-chef/issues/254)
- **Amends:** ADR [0043](0043-files-create-refuses-existing-targets.md), extending its refuse-don't-overwrite rule from recipe `files` CREATE to the scaffold commands.

## Context

`scaffold-layout` and `scaffold-sprite` wrote their results with no existence
check, on both the CLI and the MCP tools. A scaffold aimed at an existing
layout or objectType silently replaced it (instances, UIDs, SIDs), and the
sprite scaffold copied images over the target's existing frames. This is the
same silent-overwrite class ADR 0043 closed for recipe `files` CREATE
([#249](https://github.com/GenvidTechnologies/construct3-chef/issues/249)),
on a second surface that decision did not reach.

## Decision

1. **Both scaffold commands refuse before writing.** A shared, deliberately
   off-barrel module, `scaffoldGuard.ts`, exposes
   `findLayoutScaffoldConflicts`, `findSpriteScaffoldConflicts` and
   `formatScaffoldRefusal`, plus the `ScaffoldConflict` and
   `ScaffoldConflictReason` types. Four conflict kinds exist:
   - `output-exists`: the output file already exists.
   - `layout-name` / `objectType-name`: a layout or objectType with the same
     name lives in another folder. Two same-named items are ambiguous to every
     by-name reference, and sync does not catch them: with a top-level
     `objectTypes/Sprite.json` next to the registered `objectTypes/images/Sprite.json`,
     c3source's drift detection reports the project in sync and `sync-project`
     changes nothing, so the second `Sprite` is silently never registered
     ([probe on #254](https://github.com/GenvidTechnologies/construct3-chef/issues/254#issuecomment-6069558119)).
     So a name collision is a
     conflict even though no file is overwritten.
   - `image-target`: an image the sprite scaffold would copy already exists.
2. **Collect all, report once.** Every conflict is gathered, deduplicated by
   resolved path (compared lowercased), and ordered output-exists, then names,
   then images. One message lists them all.
3. **One shared formatter.** `formatScaffoldRefusal` renders the message once;
   the CLI prints it with `console.error` and exits 1, and the MCP tools return
   it through `mcpError` with the txId line. Output is byte-identical, per the
   shared-rendering rule in `CLAUDE.md`.
4. **Placement.** The check runs after the existing source-not-found checks and
   before any write. A refusal writes, syncs and regenerates nothing, and
   leaves `txId` and `extractedDirty` unchanged.
5. **No overwrite flag**, as in ADR 0043. It can be a later issue if a need
   appears.

## Rejected alternatives

- **Export the guard from the `src/index.ts` barrel.** Every barrel export is
  published API; removing or renaming it later would be semver-breaking. The
  guard is an internal safety check, so it stays off-barrel.
- **A shared write orchestrator for both scaffold tools.** Larger than the
  fix, and it belongs with the CLI-side hardening tracked in
  [#259](https://github.com/GenvidTechnologies/construct3-chef/issues/259).
- **A path-only check, as the issue body proposed.** It misses the
  same-name-in-another-folder case and the image-target case, both of which
  corrupt the project as surely as an overwrite.

## Consequences

- Behaviour change: a scaffold that previously "succeeded" by overwriting now
  fails. It is called out in the CHANGELOG.
- The dedupe compares lowercased paths. Two distinct case-variant files on a
  case-sensitive filesystem are therefore listed once, though both are still
  refused. Case-insensitive *name* matching is not part of this record; it is
  [#253](https://github.com/GenvidTechnologies/construct3-chef/issues/253).
- Declined here, filed separately:
  - [#259](https://github.com/GenvidTechnologies/construct3-chef/issues/259):
    CLI path containment and separators, an ENOENT partial write when `images/`
    is missing, and single-image objectTypes.
  - [#260](https://github.com/GenvidTechnologies/construct3-chef/issues/260):
    the layout JSON `name` versus the file basename, and the families
    namespace.
  - [#261](https://github.com/GenvidTechnologies/construct3-chef/issues/261):
    `scaffold-layout --no-regenerate` is rejected by yargs.
