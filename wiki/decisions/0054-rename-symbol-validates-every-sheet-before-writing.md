---
type: decision-record
title: "0054. rename-symbol validates every changed sheet before writing any"
description: >-
  Amends the write order of `renameSymbols`. It clones each event sheet and
  applies the replacements in memory, then runs one editor-validation pass over
  every changed sheet before the preview, dry-run and apply branches. A refusal
  writes nothing, all three modes report the same first error, and the sheet
  label is project-relative everywhere. Rejects routing the writes through the
  `OverlayIo` journal of ADR 0047
  ([#283](https://github.com/GenvidTechnologies/construct3-chef/issues/283))
tags: [decision, recipes, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-20T00:00:00Z }
---

# 0054. rename-symbol validates every changed sheet before writing any

- **Status:** Accepted
- **Date:** 2026-10-20
- **Issues:** [#283](https://github.com/GenvidTechnologies/construct3-chef/issues/283) (a refused rename leaves earlier sheets written; dry-run validates nothing). Related: [#280](https://github.com/GenvidTechnologies/construct3-chef/issues/280) (recipe dry-run and apply unification, out of scope here).
- **Builds on:** ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md), whose reasoning for recipe apply is applied here to a pipeline with a single refusal source.

## Context

`renameSymbols` (`src/c3/recipeApplier.ts`, exported through the barrel and surfaced as the CLI `rename-symbol`) already computes every replacement in memory: it clones each event sheet, applies the replacements and collects the changed sheets. What it did not do was validate them together. Each sheet went through `assertEditorValid` (c3source `validateForEditor`) only just before its own write, which produced four defects, all reproduced before the fix:

- an invalid sheet later in the list was refused after the earlier sheets had already been written, leaving the project half-renamed;
- plain `--dry-run` validated nothing and reported success for a rename that apply would refuse;
- `--preview` validated per sheet, interleaved with its diff output, so a refusal could arrive after diffs had been printed;
- the error named the sheet by absolute path in apply and by relative path in preview.

## Decision

1. **One validation pass over every changed sheet, before any branch.** After the compute step collects the changed sheets, a single loop runs `assertEditorValid` over all of them. Only then do the preview, dry-run and apply branches diverge.
2. **Writes go straight to `writeSourceJson`.** The private `writeEventSheet` helper, which bundled validation with the write, is removed; the validation it carried now lives in the shared pass.
3. **Observable behaviour.** A refusal writes nothing. Apply, dry-run and preview refuse with the same first error. `--preview` prints no diff when it refuses. The sheet label is project-relative in every mode.

Validating first is sufficient here, where it was not for recipe apply. ADR 0047 rejected hoisting only the validators because recipe apply has several refusal sources that fire mid-compute (file ops, layout ops, `addInstVars`), so validators alone could not stop earlier writes. A rename has exactly one refusal source after compute, editor validation, and no step reads another step's output. Validating every changed sheet up front therefore closes the whole window.

## Rejected alternatives

- **B: OverlayIo replay.** Route the writes through ADR 0047's `OverlayIo` journal and replay it after validation. It gives the same result with more machinery, and it closes no extra failure window, since the replay is itself a sequence of writes.

## Consequences

- A refused rename writes nothing, in every mode, and `--dry-run` now predicts apply's refusal. It still prints the lines logged before the validation pass (the replacement list, the scan count and the matched files) before it throws.
- Writes can still fail after the first one has begun, as in ADR 0047: an I/O error part-way through the write loop can leave a partial rename, and regeneration after the write can fail (reported by `regenerateAfterWrite`'s message).
- Recipe apply is unaffected: its dry-run and apply branches keep the differences ADR 0047's Consequences lists, and unifying them stays with #280.
