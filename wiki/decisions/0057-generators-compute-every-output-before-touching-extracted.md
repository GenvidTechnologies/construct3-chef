---
type: decision-record
title: "0057. Generators compute every output before touching `extracted/`"
description: >-
  `extractScripts`, `generateDSL` and `generateLayoutSummaries` compute every output in memory, then hand the set to the off-barrel `replaceOwnedOutputs` (`src/c3/generatorOutputs.ts`), which writes in place, always, then deletes only owned-suffix orphans, so a failing run touches nothing in `extracted/`; a missing `scripts/importsForEvents.ts` (or `scripts/` folder) means zero imports, answering [#181](https://github.com/GenvidTechnologies/construct3-chef/issues/181); rejects clean-then-write and a temp-dir rename-swap ([#309](https://github.com/GenvidTechnologies/construct3-chef/issues/309))
tags: [decision, architecture, generators]
status: stable
generated: { by: process:tech-writer, at: 2026-10-26T00:00:00Z }
---

# 0057. Generators compute every output before touching `extracted/`

- **Status:** Accepted
- **Date:** 2026-10-26
- **Issues:** [#309](https://github.com/GenvidTechnologies/construct3-chef/issues/309) (`regenerate` fails with ENOENT on a project without `scripts/` and has already deleted the extracted files); answers [#181](https://github.com/GenvidTechnologies/construct3-chef/issues/181)
- **Amends:** ADR [0022](0022-single-exported-generator-inventory.md), whose "does not fix #181" paragraph this reverses. Same compute-first principle as ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md), applied to `extracted/` rather than to source JSON.

## Context

A real project (`GenvidTechnologies/c3addon-gcore-video-plugin`, `sample/`) has no `scripts/` folder. Before this change `regenerate` failed on it with ENOENT, because `extractScripts` read `scripts/importsForEvents.ts` unguarded. By then `cleanOwnedFiles` (`src/c3/fsUtils.ts`) had already deleted the extracted `.ts` files and `tsconfig.json`, so the failure also destroyed existing output.

Two defects, then: a project lacking the imports file could not be extracted at all, and a failing generator left `extracted/` worse than it found it. The requirement the design carries is **R3: a failing run must not delete existing outputs.**

## Decision

`extractScripts`, `generateDSL` and `generateLayoutSummaries` compute every output in memory first, as a map of path to content. They then hand the set to `replaceOwnedOutputs` (`src/c3/generatorOutputs.ts`, off-barrel). The helper:

- writes every output in place, **always**, even when the content is unchanged, because the server judges freshness by mtime;
- then deletes only orphans, meaning files under the output directory that end with one of the generator's owned suffixes and are not in the output set;
- then prunes directories the orphan pass emptied, never the output directory itself;
- renames a file that differs from an output only by case (`FOLD_CASE` platforms) before writing, so the orphan pass cannot delete a just-written file.

Any exception during compute, which is where a malformed sheet or an unreadable file surfaces, propagates before `extracted/` is touched.

Separately, a missing `scripts/importsForEvents.ts`, or no `scripts/` folder at all, means zero imports: `extractScripts` logs `No scripts/importsForEvents.ts found; extracting without imports.` and carries on. Only ENOENT is treated this way; any other read error is rethrown. A real editor-saved project can lack the file, so requiring it was the bug.

## Compromise

- **Chosen: "Option A (recommended): compute → write in place → delete orphans, via a new off-barrel helper".**
- **Rejected: "Option B: compute → `cleanOwnedFiles` (unchanged) → write".** "It's the smallest diff, but a write-phase failure after the clean still deletes outputs, so it doesn't fully honour R3."
- **Rejected: "Option C (rejected): stage into a temp dir, then rename-swap".** "`extracted/` is shared by six generators and by other tools, so it can't be swapped as a whole. Per-file atomicity isn't required and costs about twice the code."
- **Also rejected: never skip an unchanged write (mtime freshness).** Skipping the write of an unchanged output would leave its mtime old, and freshness is judged by mtime, so the server would report a regenerated tree as stale. Hence "always".

## Consequences

- `cleanOwnedFiles` stays barrel-exported and unchanged, but the generators no longer call it. A future generator that owns files by suffix should write through `replaceOwnedOutputs`.
- This is not all-or-nothing atomic. A write that fails midway leaves new and old files mixed on disk and deletes no orphan; the next successful run converges. R3 is met: nothing existing is deleted by a failing run.
- Every unchanged output is rewritten on every run, which costs I/O but keeps the mtime freshness check correct.
- ADR 0022's statement that #181 is not fixed no longer holds; it carries an amendment note pointing here.
