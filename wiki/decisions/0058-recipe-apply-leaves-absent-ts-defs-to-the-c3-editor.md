---
type: decision-record
title: "0058. Recipe apply leaves absent ts-defs to the C3 editor"
description: >-
  Apply-recipe `objectTypes` and `addInstVars` skip a missing `scripts/ts-defs/instanceTypes.d.ts` or `objects.d.ts` with a `SKIP` line, in dry run and apply alike, deciding each file independently and never creating one, because ts-defs are editor-local and written by the C3 editor on export; rejects creating stub files and failing with a clearer error ([#309](https://github.com/GenvidTechnologies/construct3-chef/issues/309))
tags: [decision, architecture, recipes]
status: stable
generated: { by: process:tech-writer, at: 2026-10-26T00:00:00Z }
---

# 0058. Recipe apply leaves absent ts-defs to the C3 editor

- **Status:** Accepted
- **Date:** 2026-10-26
- **Issues:** [#309](https://github.com/GenvidTechnologies/construct3-chef/issues/309) (a project without `scripts/` cannot take an objectType or instance-variable recipe)
- **Related:** ADR [0018](0018-editor-local-writes-are-not-source-changes.md) (ts-defs are editor-local); ADR [0057](0057-generators-compute-every-output-before-touching-extracted.md) (the same project shape, on the generator side).

## Context

Applying a recipe with `objectTypes` or `addInstVars` also updates the TypeScript declaration files `scripts/ts-defs/instanceTypes.d.ts` and `scripts/ts-defs/objects.d.ts`. A real editor-saved project can lack `scripts/` entirely (`GenvidTechnologies/c3addon-gcore-video-plugin` `sample/` is one), and the update failed on the missing file.

## Decision

Apply-recipe `objectTypes` and `addInstVars` skip a missing `instanceTypes.d.ts` or `objects.d.ts` with a `SKIP` line, in dry run and apply alike, and never create one. Each file is decided independently: one present and one absent updates the first and skips the second. The decision is "skip a missing ts-defs file and log a `SKIP` line; never create one."

Why skipping is right:

- **ts-defs are editor-local by chef's own rule** (`src/c3/editorLocal.ts`, ADR 0018), and the C3 editor writes them on export. The next export produces them from the project, including the new object types.
- **Creating them would mean inventing the editor's declaration scaffolding.** A file chef authored from nothing would not match what the editor generates, and the editor would overwrite it.
- **The `SKIP` line keeps the signal.** It mirrors the existing degrade in `src/c3/recipeApplierIo.ts` for a present file lacking the target class: `WARN: class "…" not found in instanceTypes.d.ts — manual update needed`. The user is told the declaration was not updated rather than discovering it later.

## Compromise

- **Chosen:** "skip a missing ts-defs file and log a `SKIP` line; never create one."
- **Rejected:** "create stub files; fail with a clearer error." A stub is invented scaffolding the editor will replace. A clearer error would leave the feature unusable on such projects, though the missing file does not affect the source JSON the recipe edits.

## Consequences

- The barrel-exported `updateInstanceTypes`, `updateObjects` and `processAddInstVars` now skip and log instead of throwing on an absent file. A CHANGELOG note records the behaviour change.
- On such a project the declaration files stay absent until the editor next exports; a recipe applied meanwhile reports `SKIP` for each.
