---
type: decision-record
title: "0056. scaffold-sprite resolves a bare source across objectTypes subfolders"
description: >-
  `scaffold-sprite --source <name>` now finds the objectType in any subfolder of
  `objectTypes/`, through c3source's collector plus a pure off-barrel identity
  helper shared with the target-name conflict check. A name matching only by
  letter case, or present in more than one location, is refused rather than
  guessed. Paths are still rejected and the clone stays flat
  ([#294](https://github.com/GenvidTechnologies/construct3-chef/issues/294))
tags: [decision, scaffold, objecttypes]
status: stable
generated: { by: process:tech-writer, at: 2026-10-24T00:00:00Z }
---

# 0056. scaffold-sprite resolves a bare source across objectTypes subfolders

- **Status:** Accepted
- **Date:** 2026-10-24
- **Issues:** [#294](https://github.com/GenvidTechnologies/construct3-chef/issues/294) (`scaffold-sprite` could only clone an objectType kept at the flat `objectTypes/` root). Related: [#274](https://github.com/GenvidTechnologies/construct3-chef/issues/274), [#304](https://github.com/GenvidTechnologies/construct3-chef/issues/304), [#267](https://github.com/GenvidTechnologies/construct3-chef/issues/267).
- **Amends:** ADR [0045](0045-scaffold-plan-write-split-and-cli-path-containment.md) (decisions 1 and 4).
- **Resolves:** ADR [0051](0051-sprite-image-copies-are-derived-from-the-source-objecttype.md)'s known limit.

## Context

`planSpriteScaffold` looked for its source only at `objectTypes/<source>.json`. C3 keeps objectTypes in subfolders that mirror the manifest tree, so on the canonical fixture no objectType with an image (`Sprite2` under `images/`, `JPEGTileBackground` under `tiles/`) could be a source. Tests worked around it by copying the source JSON up to the flat root.

The flat `existsSync` also left two cases to the host or to chance. On Windows `text` found `Text.json`; on a case-sensitive filesystem it did not. A name present both flat and in a subfolder silently took the flat file. ADR [0046](0046-recipe-and-scaffold-paths-have-one-canonical-case-insensitive-identity.md) §2 makes names one case-insensitive identity, and ADR [0044](0044-scaffold-tools-refuse-existing-targets.md) Decision 1 records that two same-named items are ambiguous to every by-name reference, so taking the first hit is not a safe answer.

## Decision

1. **Resolve a bare name against a listing.** `planSpriteScaffold` lists `objectTypes/` with c3source's `find_all_objectTypes_path` and passes the listing to `lookupObjectTypeByName` in the pure, off-barrel `src/c3/objectTypeIdentity.ts` (no `node:fs`). `scaffoldGuard`'s target-name conflict check now uses the same module's `objectTypeNameMatches`, so there is one definition of objectType-name identity. It has the same pure, listing-injected shape as `findSpellingMismatches` in `recipeKeys.ts`, and applies ADR 0046 §4's rule (refuse a case-only match, naming the on-disk spelling) to the scaffold source.
2. **Four dispositions.**
   - *found*: exactly one match with the exact spelling.
   - *not-found*: no match. The message is unchanged: `Source objectType not found: objectTypes/<source>.json`.
   - *case-mismatch*: one match with different letter case. Refused as `source-case-mismatch`, naming the on-disk spelling to use (ADR 0046 §2 and §4).
   - *ambiguous*: two or more matches, exact or differing only in case (for example `Text.json` plus `tiles/text.json`). Refused as `source-ambiguous`, naming every file, sorted by POSIX-relative path so the message is the same on every host. It is never resolved to the first hit, since ADR 0044 Decision 1 holds two same-named items to be ambiguous.
3. **Check order** is invalid-name, then source resolution, then target conflict. A case-mismatched or ambiguous source is reported before a conflict on the target name.
4. **Paths are still rejected.** `--source` stays a bare name: `/`, `\` and `..` give `invalid-name`, as ADR 0045 §4 decided. Only the bare name now resolves in any subfolder.
5. **The clone stays flat.** The new objectType is written to `objectTypes/<name>.json`; `output-exists`, the success line and the image-copy derivation are unchanged.
6. **Editor-local files are never a source**, and only regular files count. Both come from the collector, which excludes `*.uistate.json` and `tsconfig.json`, does not enter `uistate/` or `ts-defs/`, and returns files only. No hand-written predicate is added (ADR [0019](0019-two-walk-primitives-one-classification-rule.md)).
7. **A missing `objectTypes/` directory** is guarded with `existsSync` before listing, because the collector throws on one; the result is the ordinary not-found message.

`ScaffoldRejection.kind` gains `source-case-mismatch` and `source-ambiguous`. It is off-barrel, and the CLI and MCP handlers read only `plan.ok` and `plan.message`, so the two surfaces stay byte-identical with no handler change.

## Alternatives considered

Option A — pure, listing-injected identity helper, off-barrel (CHOSEN).

Option B — inline in `planSpriteScaffold` (rejected). ~15 lines, no new module; `scaffoldGuard.ts` keeps its own identity copy and #274/#304 write a third — exactly the drift the #274 comment warns about.

Option C — request a c3source `find…ByName` primitive and wait (rejected). Discovery/traversal is already upstream (`find_all_objectTypes_path`); what remains is a basename filter + a refusal policy, which ADR 0046 places in chef; an upstream primitive would have to pick a disposition for case/duplicates (shape-fit risk) and waiting blocks a user-visible bug.

Considered and dropped:

- **A path-qualified source such as `--source images/Sprite2`.** It contradicts ADR 0045 §4 and its path-rejection test, and collides with #267.
- **Writing the clone into the source's subfolder.** It would change `output-exists`, the success line and the documented `objectTypes/<name>.json` output, with no requirement behind it.

## Consequences

- **Inputs that were accepted are now refused.** A source that matches only by letter case (previously host-dependent; Windows accepted it), a name present in more than one location (previously a silent flat or first hit), and `*.uistate` or `tsconfig` names (previously cloned). Each exits 1 with nothing written. The CHANGELOG records the change.
- **A bare name now reaches objectTypes in subfolders**, so every object type on the canonical fixture can be cloned, including those with images.
- **`findObjectTypeFileIo` is unchanged.** The `addInstVars` lookup (`recipeApplierIo.ts`, reachable from the barrel as `findObjectTypeFile`) keeps its exact-match, first-hit behaviour. Aligning it is #274, which can adopt the helper through `io.listObjectTypeFiles`. *(Resolved by ADR [0059](0059-recipe-objecttypes-create-uses-the-objecttype-identity.md): the `addInstVars` lookup is now aligned, while `findObjectTypeFile` itself remains unchanged.)*
- The test copy-ups that planted a flat source are removed; left in place, each would now read as ambiguous.
- Whether C3 itself forbids same-named objectTypes in different subfolders is unverified. The refusal does not depend on it: an ambiguous name is refused either way.
