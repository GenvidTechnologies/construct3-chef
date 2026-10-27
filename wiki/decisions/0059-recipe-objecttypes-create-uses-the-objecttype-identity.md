---
type: decision-record
title: "0059. Recipe objectTypes CREATE uses the objectType identity"
description: >-
  A recipe `objectTypes` entry and an `addInstVars` `type` now resolve through
  the one objectType identity (basename, any subfolder, letter case ignored).
  Only an exact re-declaration at the entry's own path is a `SKIP`; a near-match
  is refused before anything is written, in dry-run and apply alike. Names and
  folders that escape `objectTypes/`, and in-recipe duplicate names, are
  refused by `validateRecipe`
  ([#274](https://github.com/GenvidTechnologies/construct3-chef/issues/274))
tags: [decision, recipes, objecttypes, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-26T00:00:00Z }
---

# 0059. Recipe objectTypes CREATE uses the objectType identity

- **Status:** Accepted
- **Date:** 2026-10-26
- **Issues:** [#274](https://github.com/GenvidTechnologies/construct3-chef/issues/274) (an objectTypes CREATE matched existing files by exact path only, and its `name`/`folder` were not contained). Related: [#260](https://github.com/GenvidTechnologies/construct3-chef/issues/260) item 2, [#304](https://github.com/GenvidTechnologies/construct3-chef/issues/304).
- **Applies:** ADR [0046](0046-recipe-and-scaffold-paths-have-one-canonical-case-insensitive-identity.md) §4 and ADR [0056](0056-scaffold-sprite-resolves-a-bare-source-across-objecttypes-subfolders.md).

## Context

The recipe objectTypes CREATE decided "already exists" with a path `existsSync`, and `addInstVars` took the first exact-name hit. Reproduced with the real CLI, all exit 0:

- `{"name":"navbutton"}` was skipped on Windows (it would create on Linux).
- `{"name":"Sprite"}` created `objectTypes/Sprite.json` beside `objectTypes/images/Sprite.json`, with duplicate ts-def classes.
- `{"name":"EscapedF","folder":"../.."}` passed validation, and apply wrote a file two levels above the project root; `{"name":"../EscapedN"}` wrote `<root>/EscapedN.json`.
- `Widget` plus `widget` dry-ran as two CREATEs, while apply created one and skipped the other.

ADR 0046 §4 refuses a case-only match rather than resolving it, and ADR 0056 defined one objectType identity (basename, any subfolder, letter case ignored) for `scaffold-sprite`. Neither reached the recipe path.

## Decision

1. **Apply ADR 0046 §4 and ADR 0056's identity to the recipe objectTypes CREATE and to the `addInstVars` lookup.** A CREATE whose name matches an existing objectType elsewhere, or only by letter case, or in two or more places, is refused with the on-disk paths. An `addInstVars` `type` is resolved through `lookupObjectTypeByName`: a case-only match is refused naming the on-disk spelling, an ambiguous name is refused listing every match.
2. **The disk check lives in `applyRecipeInner`'s pre-write slot**, as the module-private `checkObjectTypeCreateTargets`, not in `createObjectTypeIo`. Dry-run, `--preview`, MCP `validate-recipe` and apply therefore refuse identically, before any write. In dry-run, a case variant of a same-recipe pending type is refused with the same message.
3. **The in-recipe check lives in pure `validateRecipe`.** It refuses a `name` that is not one path segment, a `folder` that is empty, non-string, absolute, drive-lettered, or has a `..`, `:` or dots-and-spaces segment, and two entries whose names are equal ignoring letter case in any folder (one error per group). The helper is `objectTypeEntryIssue` in off-barrel `recipeKeys.ts`.
4. **The exact-path `SKIP` is kept** for a benign re-declaration: exactly one match, at the entry's own target path, letter case included, POSIX-normalized. The dry-run log prints the ts-def `UPDATE` lines only for a type it would create, as apply does.
5. **`decideObjectTypeCreate` is a pure, off-barrel helper** (`objectTypeIdentity.ts`) over the c3source objectTypes listing, meant to be shared by a future families check (#260 item 2, #304).
6. **The public `findObjectTypeFile` / `findObjectTypeFileIo` are unchanged.** The recipe path resolves through the listing instead.

## Alternatives considered

- **Resolve a near-match to the on-disk spelling (rejected).** ADR 0046's own rejection applies: silently rewriting the author's name hides that the recipe disagrees with the project.
- **Check inside `createObjectTypeIo` (rejected).** The dry-run path calls it with disk I/O, so it does not see earlier same-recipe entries, while apply calls it against the in-memory overlay (ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md)), which does. The two modes would refuse different recipes.
- **Change `findObjectTypeFile` to the new identity (rejected).** It is reachable from the `src/index.ts` barrel, so a behaviour change there is a public-API change.

## Consequences

- **Inputs that were accepted are now refused:** case-variant or other-folder re-declarations, escaping names and folders, an empty or non-string `folder` (an empty string or `null` used to mean the `objectTypes/` root), in-recipe duplicate names (letter case ignored, any folder), and case-variant or ambiguous `addInstVars` types. Each fails before any write. The CHANGELOG records the change.
- A case-sensitive project with an intentional `Foo`/`foo` objectType pair can no longer create or re-declare either by recipe.
- A folder with a `.` segment, a trailing `/` or an interior `//` is tolerated by validation and POSIX-normalized before the comparison, so `folder: "images/."` re-declares `objectTypes/images/Sprite.json` as a `SKIP`. The `SKIP` line still prints the path as the recipe spelled it.
- A name present in two or more `objectTypes/` files is refused for every entry naming it, including one at an exact path, until the extras are renamed or removed.
- Whether C3 itself forbids same-named objectTypes in different subfolders is unverified (as ADR 0056 notes). The refusal does not depend on it.
