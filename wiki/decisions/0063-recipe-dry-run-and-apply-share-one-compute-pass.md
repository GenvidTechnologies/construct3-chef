---
type: decision-record
title: "0063. Recipe dry-run and apply share one compute pass"
description: >-
  Amends ADR 0047. `applyRecipeInner` runs objectTypes, addInstVars, layouts
  and files through one private `computeRecipe` against an in-memory
  `OverlayIo` in both modes. Dry-run discards the journal; the modes differ only
  in the narration of `recipeNarration.ts`. `validate-recipe` and apply now give
  the same first error, with a project-relative label and editor-load first, and
  apply refreshes its source-layout cache so it no longer refuses a recipe that
  validated
  ([#280](https://github.com/GenvidTechnologies/construct3-chef/issues/280))
tags: [decision, recipes, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-29T00:00:00Z }
---

# 0063. Recipe dry-run and apply share one compute pass

- **Status:** Accepted
- **Date:** 2026-10-29
- **Issues:** [#280](https://github.com/GenvidTechnologies/construct3-chef/issues/280). Known open limitation: [#341](https://github.com/GenvidTechnologies/construct3-chef/issues/341).
- **Amends:** ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md), whose rejected alternative (c) this adopts.
- **Relates to:** ADR [0054](0054-rename-symbol-validates-every-sheet-before-writing.md) (the precedent for one first error in every mode, a project-relative label, and a dry-run that narrates live).

## Context

`applyRecipeInner` had two step implementations: a dry-run branch that ran against disk through the public helpers, and an apply branch that ran against an `OverlayIo`. ADR 0047 deferred unifying them because doing so changes `validate-recipe` output. They had drifted, and the audit for #280 found these divergences:

- **E1.** The editor-validation label was the project-relative recipe key in dry-run and the absolute path in apply.
- **E2.** Dry-run checked editor-load validity first, apply checked the custom-action rule first, so a sheet failing both gave a different first error.
- **E4.** The ts-def lines for an objectType that already exists. Already fixed by #274, so not new here.
- **E5.** `addInstVars` on a type created by the same recipe printed a synthetic `UPDATE pending objectType` line in dry-run and the real lines in apply.
- **D7.** A repeated `addInstVars` entry for one type printed the same lines twice in dry-run; apply SKIPs the second.
- **D8.** `addInstVars` on an existing type the recipe re-declares took the pending branch in dry-run.
- **L1.** Dry-run read layouts from disk, apply from the overlay.
- **L2.** Dry-run minted SIDs from a generator per layout, apply from one recipe-wide generator.
- **D6.** Apply's source-layout cache was filled on a miss and never refreshed. A layout copied from before it was mutated was served stale to a later layout, so apply refused a recipe that `validate-recipe` had passed. Dry-run refreshed its cache after each layout.
- **D9.** A refused dry-run printed its partial lines; a refused apply printed none after the summary.

L1 and L2 had no observable symptom. D6 was a false green from `validate-recipe`, and the defective side was apply.

## Decision

**One compute pass, narrated per mode.** A private `computeRecipe` in `src/c3/recipeApplier.ts` runs Steps 1, 1b, 2 and 3 against an `OverlayIo` for both modes. Apply replays the journal to disk afterwards, as ADR 0047 decided. Dry-run and `--preview` discard the journal, so nothing is replayed, no folder is made and `beforeSourceWrite` never fires.

- **Narration is the only mode difference.** The off-barrel `src/c3/recipeNarration.ts` owns every mode-specific line: dry-run keeps present tense (`CREATE`, `UPDATE`, `MODIFY`), section headers, per-op descriptor lines (including gotcha 21's `find:` line), and the `--preview` diff. Apply keeps `CREATED`, `UPDATED`, `MODIFIED` and its journaled lines.
- **Dry-run narrates live,** so a refused dry-run still prints the lines before the error (D9), as ADR 0054 does for rename. Apply stays silent after the summary until the replay.
- **The `dryRun` flag in the Io helpers selects tense only.** It no longer means "don't write". A dry-run Io helper handed anything but an `OverlayIo` throws, so a future caller cannot write to disk by passing `dryRun`.
- **Public wrappers keep their signatures.** `createObjectType`, `updateInstanceTypes`, `updateObjects` and `processAddInstVars` compute on a private overlay in dry-run. `processAddInstVars`'s `pendingObjectTypes` is deprecated but still honoured: it seeds that overlay the way Step 1 would.

**The per-divergence rulings:**

- **E1:** the label is the project-relative recipe key in both modes (ADR 0054 §3).
- **E2:** editor-load first, then the custom-action check, in both modes. This changes apply-recipe's own first error for a sheet that fails both.
- **E4:** unchanged, already shipped with #274.
- **E5, D7, D8:** dry-run prints the lines apply prints, in dry-run tense. The pending branch is gone, and a repeated entry SKIPs.
- **L1, L2:** fixed by construction; both modes read through the overlay and use the recipe-wide SID generator.
- **D6:** apply refreshes the source-layout cache after each layout, as dry-run did. Recipes that were refused now apply.
- **D9:** dry-run keeps its live partial output, apply stays silent.

## Alternatives considered

- **Chosen: Option A: one `computeRecipe` pass, narrated per mode.**
- **Rejected: Option B: dry-run is apply minus replay, rendered from the journal** — it cannot produce the per-op descriptor lines or `(plugin: X)`, and rewriting tense inside strings is fragile. Making it work needs structured journal events, which is Option A by another name.
- **Rejected: Option C: shared step functions, two orchestrators** — it leaves logger, cache and SID-generator wiring duplicated per branch, which is where D6 and L2 came from.
- **Rejected: unifying the rendering too.** The user ruled that dry-run keeps its own rendering, because users read the `find:` line (gotcha 21) and the preview diff.

## Consequences

- **Output changes.** `validate-recipe` and apply give the same first error for a double-defect sheet, with a project-relative `/` label. Dry-run prints the real `UPDATE` lines where it printed a `pending` line, and SKIPs a repeated `addInstVars` entry.
- **Apply accepts what it used to refuse (D6).** A recipe that `validate-recipe` passed and apply refused now applies.
- **Direct library callers.** A pending type with an unknown plugin now throws `createObjectType: unknown plugin`. `validateRecipe` already refuses that plugin on every recipe path, so only a direct call can reach it.
- **`layouts/` parity.** An `addInstVars` entry on a pending type in a project with no `layouts/` now fails in dry-run with the `ENOENT` apply already gave.
- **Same memory profile as apply.** Dry-run now holds every serialized write in memory, as apply already did.
- **Rule for later work.** Never add a `dryRun` branch to a compute step; a mode difference belongs in the narration.
- **Open limitation, filed.** [#341](https://github.com/GenvidTechnologies/construct3-chef/issues/341): `renameSymbols` still builds its label with OS path separators, so on Windows it differs from the recipe key's `/`.
- **ADR 0047 is amended, not rewritten.** Its Decision 2, rejected alternative (c) and Consequences describe the state before this change.
