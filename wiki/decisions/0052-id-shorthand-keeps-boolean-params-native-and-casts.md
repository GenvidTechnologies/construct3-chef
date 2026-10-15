---
type: decision-record
title: "0052. The id shorthand keeps boolean params native and casts the parameters type"
description: >-
  `expandAction`'s `id` shorthand stringified every action param, so a native
  boolean was written as `"true"`, whereas C3 stores booleans natively. Booleans
  are now kept and everything else is stringified, with the result cast to the
  declared `Record<string, string>` (the `patch-action-param` precedent) rather
  than widening the public type, which is deferred to the next major release
  ([#285](https://github.com/GenvidTechnologies/construct3-chef/issues/285))
tags: [decision, recipes, event-sheets, public-api]
status: stable
generated: { by: process:tech-writer, at: 2026-10-14T00:00:00Z }
---

# 0052. The id shorthand keeps boolean params native and casts the parameters type

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issues:** [#285](https://github.com/GenvidTechnologies/construct3-chef/issues/285) (`id` shorthand writes booleans as strings)

## Context

`expandAction`'s `id` branch in `src/c3/recipeInterpreter.ts` stringified every action param with `String(v)`, so `"interactive": true` was written as `"true"`. C3 itself stores booleans as native JSON booleans and numbers and expressions as strings.

The declared type is the obstacle. `StandardAction.parameters` (`src/c3/eventSheetMutator.ts`) and `buildAction`'s `parameters` option are `Record<string, string>`, and both are public API through the `src/index.ts` barrel. The declared type already under-states the runtime shape: `patch-action-param` writes raw values through a cast (`action.parameters[key] = val as string`), and sheets read from disk carry booleans. c3source's own `Condition.parameters` is `Record<string, unknown>`.

## Decision

Keep native booleans, `String()` every other value, and cast the result to `Record<string, string>`, matching `patch-action-param`. No public type changes. A code comment at the cast says the declared type under-states the runtime shape.

## Compromise

| Decision | Option | Verdict | One-line reason |
|---|---|---|---|
| Typing | A: cast | chosen | no public type change, so it ships as a patch fix; the declared type stays an under-statement, as it already is for `patch-action-param` |
| Typing | B: widen to `Record<string, string \| boolean>` on `StandardAction` and `buildAction` | rejected | accurate, but TypeScript consumers reading `.parameters[k]` as a string stop compiling; since 1.0.0 that is a major bump, disproportionate for a P2 fix |

## Consequences

- A boolean passed to the `id` shorthand is written as a native boolean for any action, not just `set-layer-interactive`. `validateRecipe` still rejects the string form for params that require a boolean.
- The declared parameter type remains narrower than what is stored. Consumers reading `.parameters[k]` off a sheet may already see booleans.
- Widening is deferred to the next major release, when it should be revisited; `Record<string, unknown>` is c3source's `Condition.parameters` precedent.
- Out of scope: the `call` shorthand's stringify, since function-call params may legitimately be expression strings.
