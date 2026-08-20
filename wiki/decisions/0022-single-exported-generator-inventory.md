---
type: decision-record
title: "0022. `generators.ts` owns the generator inventory as a single exported source of truth"
description: >-
  `GENERATORS` in `src/c3/generators.ts` becomes the single source of truth for the six generators, replacing `cli.ts`'s private `GENERATOR_NAMES`/`generators` array and letting `server.ts`'s `GENERATOR_STEPS` derive rather than hand-list; this is what makes `test/c3/generatorOutDir.test.ts`'s structural "every generator creates its own outDir" guard self-extending; rejects hoisting a single `mkdirSync` into the caller and hand-enumerating generators inside the test; `recipeApplier.ts`'s fixed three-generator sequence stays deliberately unrouted; does not fix [#181](https://github.com/GenvidTechnologies/construct3-chef/issues/181) (`extractScripts` still requires a pre-existing `importsForEvents.ts`) ([#178](https://github.com/GenvidTechnologies/construct3-chef/issues/178))
tags: [decision, architecture]
status: stable
generated: { by: process:maintain-wiki, at: 2026-08-20T15:29:10Z }
---

# 0022. `generators.ts` owns the generator inventory as a single exported source of truth

- **Status:** Accepted
- **Date:** 2026-08-13
- **Issue:** [#178](https://github.com/GenvidTechnologies/construct3-chef/issues/178)

## Context

#178's acceptance criterion 4 asked for a cheap structural check that all six
generators create their own output directory, so a seventh generator added
later cannot silently reintroduce the ordering dependency the issue was filed
against (`generate --only templates` threw `ENOENT` on a project without an
existing `extracted/`, because `generateTemplateScope` relied on
`extractScripts` having run first and created the directory as a side
effect).

That check turned out to be unimplementable as originally scoped: no exported
generator inventory existed to drive it. `cli.ts` held a module-private
`GENERATOR_NAMES` plus its own local `generators` array, holding *names only*
in one and closures in the other; `server.ts`'s `GENERATOR_STEPS` was a
hand-written array of six `{ name, fn }` entries closing over the
module-level mutable `PROJECT_ROOT`/`EXTRACTED_DIR`. Neither was exported, so
a test could not iterate "the six generators" without hand-listing them a
third time — which would satisfy the letter of AC-4 while reopening exactly
the drift risk it exists to close.

## Decision

Extract the inventory into `src/c3/generators.ts` (the module that already
owns all six generator functions) as `GENERATORS: readonly GeneratorEntry[]`
— `{ name: GeneratorName, label, run }`, run in array order — alongside the
`GENERATOR_NAMES`/`GeneratorName` tuple type that already existed privately
in `cli.ts`. Both consumers now derive from it rather than hand-listing:

- `cli.ts`'s `runGenerators` filters `GENERATORS` by the `--only` CLI value
  instead of maintaining a parallel `generators` array.
- `server.ts`'s `GENERATOR_STEPS` is `.map()`-derived from `GENERATORS`, with
  each entry's closure reading `PROJECT_ROOT`/`EXTRACTED_DIR` at call time
  (not captured eagerly) — those two remain module-level mutable, reassigned
  by `startServer` and the `__setProjectRoot`/`__resetTestState` test seams,
  so an eager capture would go stale exactly the way `PROJECT` itself must be
  reassigned alongside `PROJECT_ROOT` (see CLAUDE.md's MCP server state model
  section).

`test/c3/generatorOutDir.test.ts` then drives its per-generator assertions
off `GENERATORS` directly (`for (const gen of GENERATORS) { it(...) }`), so a
future seventh entry is covered by the guard without editing the test file.
Its docstring records the harness deliberately committed RED (5 passing / 1
failing at `templates`) before the fix landed, so the red state is a
structural git-history artifact rather than a claim.

The fix itself — adding the missing `mkdirSync(outDir, { recursive: true })`
to `generateTemplateScope`, matching the placement convention the other five
generators already use — is a one-line change once the guard exists to prove
it. `GENERATORS`' own docstring now states plainly that generator run order
is presentational (progress labels, log sequence) rather than a correctness
constraint, which is what makes `--only <name>` safe for any single entry.

## Compromise

**Rejected alternative 1 — hoist a single `mkdirSync` into `runGenerators`.**
This is the alternative #178's own body considered and rejected. It fixes
the CLI call path but leaves the barrel-exported `generateTemplateScope`
still failing for any direct consumer that calls it without going through
`runGenerators` — and it moves the outDir guarantee *away* from the five
generators that already own it individually, trading one inconsistency
(templates lacking a guarantee the others have) for another (one generator's
guarantee living in its caller instead of itself).

**Rejected alternative 2 — enumerate the six generators inside the test.**
This satisfies AC-4's letter (a structural check exists) but not its intent:
a seventh generator not also added to the test's hand-written list slips
through uncaught, and the test itself becomes a new lockstep site — the
failure mode AC-4 was filed to prevent, only moved into test code.

**`src/c3/recipeApplier.ts` is deliberately NOT routed through `GENERATORS`.**
Its `extractScripts` → `generateDSL` → `generateLayoutSummaries` sequence
(inside `regenerateExtracted`) is a fixed subset — the third call gated by
that function's `withLayouts` parameter, which defaults to `false` — not a
filtered run over the full inventory. It predates
this ADR and stays local: recording the decline here so it doesn't later
read as an oversight, per this repo's habit of recording declines rather
than leaving them to be rediscovered (see ADR 0016, ADR 0021).

**This does not fix [#181](https://github.com/GenvidTechnologies/construct3-chef/issues/181).**
`extractScripts` still cannot run on a project lacking
`scripts/importsForEvents.ts` — it `readFileSync`s that file unguarded, five
lines before its own `mkdirSync(outDir)` call. `generatorOutDir.test.ts`'s
`seedProject` helper writes an empty `importsForEvents.ts` purely so the
`scripts` case can reach far enough to exercise the outDir property at all;
its docstring says explicitly that a green `scripts` case here is not
evidence `extractScripts` is healthy in general. The structural check this
ADR backs proves outDir self-sufficiency and nothing else.

## Consequences

- `GENERATORS`/`GeneratorEntry`/`GENERATOR_NAMES`/`GeneratorName` are now
  barrel-exported public API (`src/index.ts` re-exports `./c3/generators.js`
  wholesale, and the repo is past 1.0.0). The export is additive, so this is
  not a breaking change — but per CLAUDE.md's module-system-gotchas section,
  it is now permanently supported: removing or renaming any of the four
  requires a major bump, same as any other barrel symbol.
- The lockstep-site count for adding a generator drops: the two
  hand-maintained enumerations in `cli.ts` (`GENERATOR_NAMES` + the
  `generators` array) collapse into one import, and `server.ts`'s
  `GENERATOR_STEPS` becomes derived rather than hand-written. The remaining
  sites (the `totalSteps`/`progressTotal` constants and the `regenerate`
  tool's description string in `server.ts`, the golden test's `before` hook,
  `EXPECTED_TRACKED_FILES` in `scripts/verify-fixture-parity.mjs`, and the
  four docs) are unaffected by this change and still require a manual edit —
  see the updated count in CLAUDE.md's generator-lockstep note.
- `test/c3/generatorOutDir.test.ts` is self-extending, not a new lockstep
  site: it is the one place in the lockstep list that does *not* need
  editing when a seventh generator is added, because it iterates `GENERATORS`
  rather than a hand-listed set.
