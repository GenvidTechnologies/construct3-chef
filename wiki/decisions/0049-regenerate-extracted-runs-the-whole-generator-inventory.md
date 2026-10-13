---
type: decision-record
title: "0049. `regenerateExtracted` runs the whole generator inventory"
description: >-
  Amends ADR 0022. After a successful CLI or library apply, `regenerateExtracted`
  runs every `GENERATORS` entry in place with an unchanged signature (`withLayouts`
  kept, ignored, `@deprecated`), so `extracted/` equals a full regeneration and the
  CLI/library and MCP paths agree; rejects a separate full-set helper and a targeted
  subset ([#256](https://github.com/GenvidTechnologies/construct3-chef/issues/256))
tags: [decision, architecture, generators]
status: stable
generated: { by: process:tech-writer, at: 2026-10-13T00:00:00Z }
---

# 0049. `regenerateExtracted` runs the whole generator inventory

- **Status:** Accepted
- **Date:** 2026-10-13
- **Issues:** [#256](https://github.com/GenvidTechnologies/construct3-chef/issues/256) (a CLI or library apply leaves `extracted/` different from a full regeneration)
- **Amends:** ADR [0022](0022-single-exported-generator-inventory.md). Consistent with ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md), which names `regenerateExtracted` as a post-write failure site; that stays accurate.

## Context

ADR 0022 recorded `regenerateExtracted` (`src/c3/recipeApplier.ts`, public through the `src/index.ts` barrel) as deliberately not routed through `GENERATORS`: it ran `extractScripts`, `generateDSL`, and `generateLayoutSummaries` only when `withLayouts` was set. That ADR recorded the decline but no rationale for the subset itself.

The subset left `extracted/` stale. Measured at a6304e9, after a CLI or library apply `extracted/` differed from a full regeneration:

- a files-create: `sid-registry.txt` differed;
- an addInstVars-only apply: two `*.layout.txt` summaries plus `sid-registry.txt`;
- `templatize-in-place`: `template-scope.txt`;
- `remove-layer`: `global-layers.txt` plus `sid-registry.txt`.

The MCP path already ran all six generators after every apply (`applyParsed(..., { regenerate: false })`, then `runGenerators` over `GENERATORS`), so the two surfaces left `extracted/` in different states. A freshly launched MCP server then served the stale `template-scope.txt`, `global-layers.txt` and `sid-registry.txt` with no warning.

## Decision

`regenerateExtracted` runs every `GENERATORS` entry, in place, with an unchanged signature. The `withLayouts` parameter is kept but ignored, and marked `@deprecated`. Its log lines come from each generator's `label`.

This fits ADR 0004's rule that both surfaces share the library: the apply result no longer depends on which surface ran it.

## Compromise

- **Option A (chosen):** `regenerateExtracted` runs the whole `GENERATORS` inventory in place, keeping its signature.
- **Option B (rejected):** a new internal full-set helper, with `regenerateExtracted` left on the subset and deprecated. The published function would keep producing exactly the staleness #256 reports, and there would be two regeneration paths forever.
- **Option C (rejected):** targeted subset. It creates a lockstep site the CLAUDE.md enumeration doesn't name.

## Consequences

- A seventh generator is picked up automatically, so `recipeApplier.ts` is not a lockstep site.
- Each CLI apply now runs six full-project scans instead of two or three. The cost is indicative only: under 0.4 s on the sample fixture, and MCP users already paid it.
- `generateLayoutSummaries` now runs even on recipes that touched no layout, which exposes its `project.c3proj` read on those runs.
- It is a behaviour change to a public function with the same signature, so it ships as a minor release with a CHANGELOG note, not a major.
- ADR 0022's decline paragraph is reversed; it carries an amendment note pointing here.
