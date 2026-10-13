---
type: decision-record
title: "0047. Recipe apply computes every step in memory, then writes"
description: >-
  Amends ADR 0003. `applyRecipeInner` runs objectTypes, addInstVars, layouts
  and files against an in-memory `OverlayIo` that journals writes and log
  lines, and replays the journal to disk only after the whole recipe passed. A
  refused apply writes nothing and creates no folder. The first error, the
  success log, dry-run, validate-recipe and --preview are unchanged
  ([#279](https://github.com/GenvidTechnologies/construct3-chef/issues/279),
  [#278](https://github.com/GenvidTechnologies/construct3-chef/issues/278),
  [#255](https://github.com/GenvidTechnologies/construct3-chef/issues/255))
tags: [decision, recipes, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-13T00:00:00Z }
---

# 0047. Recipe apply computes every step in memory, then writes

- **Status:** Accepted
- **Date:** 2026-10-13
- **Issues:** [#279](https://github.com/GenvidTechnologies/construct3-chef/issues/279) (a refused apply leaves earlier writes on disk), [#278](https://github.com/GenvidTechnologies/construct3-chef/issues/278) (a refused apply leaves an empty folder), and [#255](https://github.com/GenvidTechnologies/construct3-chef/issues/255) (MCP bookkeeping for writes that can still happen).
- **Amends:** ADR [0003](0003-recipe-pipeline-pure-interpreter-vs-io-applier.md).

## Context

`applyRecipeInner` used to write as it went: Step 1 (objectTypes), Step 1b (addInstVars), Step 2 (layouts), Step 3 (files, one sheet at a time). A refusal in a later step therefore left the earlier writes on disk, and the project was half-edited. The measured scenarios:

- a layout op refused after another layout in the same recipe had been written;
- a `files` op refused after a layout had been written;
- `addInstVars` refused after an objectType had been created;
- a clone-replica whose second target was refused after the first had been written.

A CREATE into a new folder also left that empty folder behind when a later step refused (#278).

## Decision

1. **Compute against an overlay, then replay.** The apply branch runs the same Steps 1, 1b, 2 and 3, in the same order, against an `OverlayIo` (`src/c3/sourceIo.ts`). The overlay holds the serialized text of every write and an ordered journal of `log` and `write` entries. Only after Step 3 has passed does the replay loop in `applyRecipeInner` walk the journal: it forwards each log entry to the caller's logger, and creates the folder (when the entry asked for one) and writes the file for each write entry.
2. **Observable behaviour is otherwise unchanged.** The first error a recipe raises is the same as before, and the success log is the same lines in the same order. Dry-run, `validate-recipe` and `--preview` are untouched.
3. **No public signature change.** The exported helpers in `recipeApplier.ts` keep their signatures and stay bound to `diskIo`. The `SourceIo`-parameterised bodies live in the off-barrel `src/c3/recipeApplierIo.ts`, so nothing new is published through the `src/index.ts` barrel.

## Rejected alternatives

- **(a) Hoist only the two Step 3 validators** (`assertEditorValid`, `validateInsertedCustomActions`) ahead of all writes. Insufficient: refusals from file ops, layout ops and `addInstVars` would still arrive after earlier writes.
- **(b) Split only Step 3 into compute and write.** It changed which error a recipe with two defects reports, so apply and `validate-recipe` would disagree about the first error. Rejected by the user.
- **(c) One compute pass shared by dry-run and apply.** It would change `validate-recipe` output, because the two paths already differ in four places: the sheet label, the check order, the existing-objectType ts-defs lines, and the pending-objectType log. Deferred to [#280](https://github.com/GenvidTechnologies/construct3-chef/issues/280).

## Consequences

- A refused apply writes nothing and prints only the lines that were logged before the compute pass (the journal is never replayed). Folders are created only on success, which closes #278.
- Writes can still fail after a write has begun, in three places: the replay itself (an I/O error part-way through the journal), regeneration (the CLI's `regenerateExtracted` and the MCP generators), and the scaffold tools, which do not go through this path. #255 covers the MCP bookkeeping for those.
- Two reads during compute still hit the disk rather than the overlay. `collectAllUids` is valid because `addInstVars` never changes UIDs (see `addInstVarsToLayout`), so the overlay's layout edits cannot alter the UID set. The layouts listing used by `addInstVars` (`find_all_layouts_path` in `recipeApplierIo.ts`) is valid because a recipe never creates layouts.
- Hidden coupling: the helpers log after their writes, which keeps the replayed success log identical to the old interleaving. A helper that logged before its write would reorder the output.
- Dry-run and apply still differ in the four places above (#280).
