---
type: decision-record
title: "0072. Recipe writes to boolean and combo slots are checked after compute"
description: >-
  The recipe applier gains a third check, run after every event sheet is
  computed and before anything is written. It refuses a value that a boolean
  slot or a "true"/"false" choice slot cannot hold, over the slots the recipe
  wrote. Slot types come from the callee's parameters and from a built-in table
  keyed by owner. Per sheet, a native boolean written into a "true"/"false"
  choice is stored as its string. The built-in table is a local bridge until
  c3source ships it, retired by a tripwire test
  ([#371](https://github.com/GenvidTechnologies/construct3-chef/issues/371))
tags: [decision, recipes, safety, upstream]
status: stable
generated: { by: process:tech-writer, at: 2026-11-10T00:00:00Z }
---

# 0072. Recipe writes to boolean and combo slots are checked after compute

- **Status:** Accepted
- **Date:** 2026-11-10
- **Issues:** [#371](https://github.com/GenvidTechnologies/construct3-chef/issues/371). Upstream request: [c3source#132](https://github.com/GenvidTechnologies/c3source/issues/132).
- **Amends:** ADR [0052](0052-id-shorthand-keeps-boolean-params-native-and-casts.md) (a native boolean is stored as a string in a "true"/"false" choice) and ADR [0003](0003-recipe-pipeline-pure-interpreter-vs-io-applier.md) (a third applier check).
- **Relates to:** ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) (this is a recorded deviation from request-and-wait), ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md), ADR [0063](0063-recipe-dry-run-and-apply-share-one-compute-pass.md).

## Context

A recipe could write an expression into a slot where the C3 editor keeps only a constant (#371). The recipe was accepted, the sheet was written, and the editor then changed the meaning of the value when it loaded the project.

The editor facts come from a read of the C3 editor r495-2 bundle, recorded on #371. The bundle was read, not run.

- A `boolean` parameter is loaded with `!!`. An expression or the string `"false"` therefore becomes true.
- A `combo` parameter whose items are exactly `"false"` and `"true"` accepts only those item strings. A native boolean there throws `TypeError: expected string` at load. Any other string falls back to the parameter's initial value.
- `callFunction` resolves its function project-wide, by case-insensitive name.

The two checks that already guard each sheet write (`assertEditorValid` and the custom-action check) pass such a recipe. Neither knows the type of a parameter.

## Decision

**Option A: a third applier chokepoint after compute, with normalization in the same pass (recommended).**

The third check runs in `computeRecipe` in `src/c3/recipeApplier.ts`, the one compute pass that dry-run, `--preview`, `validate-recipe` and apply share (ADR 0063). It runs after every event sheet is computed and before anything is written. Because it throws before the journal replays, a refusal writes nothing (ADR 0047).

- **Slots checked.** Only the slots the recipe wrote: every parameter of a new action or condition, and the parameters whose value changed on an existing SID. A defect already on disk in a node the recipe did not change is not reported.
- **Slot types.** A function call argument takes its type from the callee's declared parameter at the same position. A custom action resolves its callee the way the custom-action check does. A standard action or condition takes its type from a built-in table keyed by owner: a plugin id, a behavior id, or a common category. A plugin owner is the object type's (or family's) `plugin-id`, or `system` for `System`. A behavior owner is the `behaviorId` behind the action's `behaviorType` instance name.
- **Callee index.** The signature index holds every sheet on disk that the recipe did not touch, plus the computed version of every sheet it did. A definition in a later recipe key, or one the recipe changed, is therefore visible whatever the order of the keys.
- **Rules.** A `boolean` slot accepts only a native boolean. A "true"/"false" choice slot accepts only the strings `"true"` and `"false"`. Anything else is refused, not warned about. A refusal throws one `Boolean-slot validation failed:` error that lists every finding.
- **Skips.** A slot is skipped, never refused, when it cannot be resolved: an unknown callee, a position beyond the callee's parameters, duplicate definitions that disagree on that position's type, an unknown object class, or no table row.
- **Normalization.** Per sheet, a native boolean written into a "true"/"false" choice slot of the built-in table is stored as `"true"` or `"false"`, with one narration line per normalized slot. Only written slots are changed. A native boolean already on disk is left alone.
- **Order.** Per sheet: normalize, then the editor-load check, then the custom-action check. After all sheets: the boolean-slot check. A sheet that fails both the editor-load check and the boolean-slot check reports the editor-load error.
- **Scope of the pure layer.** The pure `executeRecipe` and `executeFileOps` are not checked or normalized. The two existing checks also live only in the applier.
- **Message.** A finding names the recipe's file key, the sheet locator, C3's event number and the action's SID. It does not name the recipe op index, because the check runs after compute and a created sheet or a nested event has no op index.

**Owner keying.** ACE ids repeat across owners with different parameter types. `set-enabled` is `boolean` on the Billboard, Follow and MoveTo behaviors and a `["disabled","enabled"]` choice on other behaviors. A lookup by id alone would refuse a correct `"enabled"`. Every lookup is keyed by owner kind, owner, ACE kind, ACE id and parameter id. When the object class resolves to a plugin owner (an object type or a family, not `System`), the node has no `behaviorType`, and that plugin has no row, the common rows are tried by ACE kind, ACE id and parameter id. The same read of r495-2 found no plugin or behavior that defines an ACE whose id equals one of the five boolean-bearing common ACE ids (`pick-highestlowest`, `set-boolean-instvar`, `pick-nearestfurthest`, `add-child`, `set-mesh-size`). That fallback rests on that finding.

**One overlap is kept.** `PARAM_TYPE_RULES` in `src/c3/recipeInterpreter.ts` already refused a non-boolean `interactive` on `set-layer-interactive`, keyed by id alone, before this check existed. The built-in table agrees that this param is `boolean`, so the two cannot give different verdicts; that rule only refuses earlier, at the shorthand level. It stays, and existing tests pin it. No new id-only rule is added for a slot this check owns.

## Compromise

| Decision | Option | Verdict | One-line reason |
|---|---|---|---|
| Where the check runs | Option A: a third applier chokepoint after compute, with normalization in the same pass (recommended) | chosen | it sees every write path, has project context, and reads the computed sheets, so it cannot drift from what is written |
| Where the check runs | Option B: extend `validateRecipe` (pure, at the shorthand level) | rejected | it cannot see this recipe's own computed definitions without re-implementing expansion, and normalization is impossible there because `validateRecipe` does not return a recipe |
| Where the check runs | Option C: both (cheap shorthand rules in `validateRecipe`, plus Option A) | rejected | two owners of one fact, and a shorthand rule requiring a string would refuse the native boolean that Option A normalizes |
| Built-in table | T1 (recommended): a committed, off-barrel table in `src/c3/builtinBooleanParams.ts` | chosen | small reviewable data, kept until c3source ships it |
| Built-in table | T2: commit an extraction script that reads a downloaded editor bundle | rejected | the bundle is proprietary and minified, and the script would make chef the owner of a platform fact that belongs in c3source |
| Built-in table | T3: read the optional `c3-reference` cache | rejected | it is absent by default, and its types do not distinguish boolean from combo |
| Normalization | After compute, in the applier, written slots only (recommended) | chosen | owner-aware, covers `patch-action-param`, and is narrated |
| Normalization | In `expandAction` keyed by id, or in `patchActionParam` plus `expandAction` | rejected | no owner context (ACE ids repeat across owners), it misses `patch-action-param`, and it edits lines that open #364 also edits |

**Deviation from ADR 0006.** ADR 0006's default is to request the fact upstream and wait. The 117-row table (`src/c3/builtinBooleanParams.ts`, off the barrel) is a platform fact and belongs in c3source. It ships here as a local bridge, and the upstream request is [c3source#132](https://github.com/GenvidTechnologies/c3source/issues/132).

**Retirement.** The tripwire test `I371-T1:` in `test/c3/booleanSlots.test.ts` goes red when c3source exports a matching table. When it does:

1. Check that the export is the boolean-slot table. If it is not, add its name to the test's allowlist.
2. Delete `src/c3/builtinBooleanParams.ts`, its import in `src/c3/booleanSlots.ts`, and the `I371-T1:` and `I371-R12:` tests.
3. Switch the lookup to the upstream export.
4. Revert-confirm that `I371-R3:`, `I371-R4:`, `I371-R6:` and `I371-R7:` stay green.

## Consequences

- **Values already on disk are not repaired.** A native boolean that an earlier chef release wrote into a "true"/"false" choice slot stays as it is. Detecting or repairing it is tracked in [#395](https://github.com/GenvidTechnologies/construct3-chef/issues/395).
- **Out of scope, tracked separately.** Addon ACE parameters ([#394](https://github.com/GenvidTechnologies/construct3-chef/issues/394)). Call sites that a recipe turns into boolean slots without writing them ([#396](https://github.com/GenvidTechnologies/construct3-chef/issues/396)). The custom-action check's same-recipe limitation ([#397](https://github.com/GenvidTechnologies/construct3-chef/issues/397)).
- **A refused dry-run still prints the lines it narrated before the refusal,** including any normalization line. This is ADR 0063's rule for a refusal after compute started.
- **Recipes that wrote an expression, or the string `"true"` or `"false"`, into a boolean slot are now refused.** A native boolean written into a "true"/"false" choice is accepted and stored as a string.
- **The pure interpreter is unchanged.** `expandAction` still keeps a native boolean for any id (ADR 0052). A barrel consumer that calls `executeRecipe` directly gets neither the check nor the normalization.
- **More reads per apply that touches an event sheet:** the check reads every object type (through the compute pass) and every family, and, after the sheets are computed, every event sheet on disk that the recipe did not touch.
