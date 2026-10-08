---
type: decision-record
title: "0043. A `files` CREATE refuses a target that already exists"
description: >-
  A recipe `files` entry with `create: true` whose resolved path already
  exists used to replace the whole sheet (events, SIDs, comments) while
  dry-run reported a plain CREATE. It is now strict: any existing CREATE
  target rejects the whole recipe before anything is written, in apply,
  dry-run, `--preview`, and the MCP recipe tools, with one error listing every
  offending path. The check is a module-private `checkCreateTargets` in
  `recipeApplier.ts`, beside `checkMoveVariableDemotions`; "exists" is
  `existsSync` on disk, with no overwrite flag. This deliberately differs from
  the idempotent SKIP of `objectTypes`/`addInstVars`, which carry no content a
  skip would drop
  ([#249](https://github.com/GenvidTechnologies/construct3-chef/issues/249))
tags: [decision, recipes, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-08T00:00:00Z }
---

# 0043. A `files` CREATE refuses a target that already exists

- **Status:** Accepted
- **Date:** 2026-10-08
- **Issue:** [#249](https://github.com/GenvidTechnologies/construct3-chef/issues/249); related [#245](https://github.com/GenvidTechnologies/construct3-chef/issues/245) / PR #250

## Context

A recipe `files` entry `{ "create": true, "events": [...] }` whose resolved
path already existed replaced the whole sheet. Step 3 of
`src/c3/recipeApplier.ts` called `writeEventSheet` with no existence check,
and dry-run, `--preview` and MCP `validate-recipe` reported the entry as a
new-file CREATE. Reproduced: a 5634-byte, 29-SID sheet became 144 bytes with
1 SID and rc 0. The canonical user-defined op example in
[`reference/ops.md`](../reference/ops.md) is a CREATE op, so re-running it
with the same parameter silently wiped the sheet.

The sibling create paths are idempotent: `objectTypes` (`createObjectType`)
and `addInstVars` SKIP with a log line when the target exists. But those
carry no content a SKIP would drop. A `files` CREATE carries events.

## Decision

1. **A `files` CREATE is strict.** If any CREATE target already exists on
   disk, the whole recipe is rejected before anything is written, in apply,
   dry-run, `--preview`, and MCP `validate-recipe` / `apply-recipe` / user op
   tools. One error lists every offending path (normalized repo-relative keys)
   and points at the ops-array form. The asymmetry with
   `objectTypes`/`addInstVars` is deliberate.
2. **The check is a module-private `checkCreateTargets(rootDir, files)`** in
   the I/O applier (`recipeApplier.ts`), called in the existing disk-aware
   pre-write slot beside `checkMoveVariableDemotions`, before the dry-run
   branch and before Step 1 writes objectTypes and layouts.
3. **"Exists" means `existsSync`** on `path.join(rootDir, <normalized key>)`:
   on disk, not registration in `project.c3proj`. There is no opt-in overwrite
   flag.
4. **Ships as a `fix:` (patch).** No exported symbol is removed. The
   behaviour change, a recipe that "succeeded" by overwriting now failing, is
   called out in the CHANGELOG.

## Rejected alternatives

- **SKIP the CREATE, mirroring `createObjectType`.** It silently drops the
  recipe's content, the same silent-loss class as the bug.
- **An opt-in `overwrite: true` flag.** No demonstrated need; it can be a
  later issue.
- **Check inside `validateRecipe` (`recipeInterpreter.ts`).** It is pure and
  barrel-exported with no `rootDir`, so adding disk I/O changes a published
  signature (breaking) and mixes I/O into the pure interpreter. MCP
  `validate-recipe` also renders `validateRecipe` errors differently from
  thrown errors, so CLI and MCP output would diverge.
- **Per-entry checks inside the dry-run and Step 3 loops.** In a real apply,
  Steps 1-2 have already written by then, so a rejection would leave partial
  writes, and the check would be duplicated.
- **Merging into a renamed demotion helper.** It would mix two unrelated
  refusals with different behaviour: demotion throws on the first violation
  and logs success, while this reports all and logs nothing.

## Consequences

- Step 3's sync-project reminder gate becomes unconditional, since every
  surviving CREATE writes a new file.
- On a case-insensitive filesystem (Windows) a case-variant key of an
  existing sheet is now refused. On a case-sensitive filesystem it still
  creates a second file; that is tracked as a follow-up.
- Library consumers who call the pure `executeRecipe` and write its `created`
  map themselves bypass the check. That is out of scope: callers own their
  I/O.
