---
type: decision-record
title: "0046. Recipe and scaffold paths have one canonical, case-insensitive identity"
description: >-
  Amends ADRs 0043 and 0044. A recipe `files`/`layouts` key now has one
  canonical form (forward slashes, section folder, `.json`), and its identity
  is that form lowercased on every host. Two keys with one identity are a
  `validateRecipe` error; `..`, absolute and empty keys are rejected; op
  templates whose keys render to one string throw. Against the disk, the
  applier refuses a key that matches an existing sheet or layout only when
  letter case is ignored, before workflow expansion, using the c3source
  listing so the answer is the same on every filesystem. The CREATE-target
  check and the scaffold name conflicts use the same case-insensitive match
  ([#252](https://github.com/GenvidTechnologies/construct3-chef/issues/252),
  [#253](https://github.com/GenvidTechnologies/construct3-chef/issues/253),
  [#273](https://github.com/GenvidTechnologies/construct3-chef/issues/273))
tags: [decision, recipes, scaffold, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-12T00:00:00Z }
---

# 0046. Recipe and scaffold paths have one canonical, case-insensitive identity

- **Status:** Accepted
- **Date:** 2026-10-12
- **Issues:** [#252](https://github.com/GenvidTechnologies/construct3-chef/issues/252) (two spellings of one key collapse), [#253](https://github.com/GenvidTechnologies/construct3-chef/issues/253) (case-variant keys differ by filesystem), [#273](https://github.com/GenvidTechnologies/construct3-chef/issues/273) (keys escape the project root), and part of [#260](https://github.com/GenvidTechnologies/construct3-chef/issues/260) item 3 (scaffold case). This record does not close #260.
- **Amends:** ADR [0043](0043-files-create-refuses-existing-targets.md) and ADR [0044](0044-scaffold-tools-refuse-existing-targets.md).

## Context

A recipe addresses a file by a `files` or `layouts` key, and bare keys are expanded to full paths. Three defects shared one root, that the recipe layer had no single definition of "the same file":

- Two spellings of one key (`"a"` and `"eventSheets/a.json"`, or a `\` and a `/` form) collapsed into one object entry, so one silently overwrote the other (#252).
- Keys differing only in letter case were two files on a case-sensitive filesystem and one file on a case-insensitive one, so the same recipe behaved differently per host (#253).
- A key containing `..`, an absolute path, or a drive letter could point outside the project root (#273).

The scaffold tools and the CREATE-target check (ADRs 0044 and 0043) compared names exactly or via `existsSync`, so they inherited the host dependence.

## Decision

1. **A canonical form.** `canonicalizeRecipeKey` (off-barrel `recipeKeys.ts`) turns backslashes into `/`, collapses `./` and `//`, re-cases or adds the section folder (`eventSheets/`, `layouts/`), and re-cases or adds `.json`. `keyIssue` rejects a `..` segment, an absolute or drive-letter path, and an empty name. It also rejects a key ending in `/` (it must name a file, not a folder), a `:` in any segment (an NTFS alternate data stream on Windows, a literal name elsewhere, so host-dependent), and a segment made only of dots and spaces (`.. `, `...`), which Windows strips to `.` or `..`. These refusals apply to keys and to cross-layout field values. `validateRecipe` leaves the `files`/`layouts` maps as written when a key is invalid or colliding, so repeated calls keep reporting.
2. **Identity is the lowercased canonical form, on every host.** The same recipe means the same thing on Windows, macOS and Linux.
3. **In-recipe collisions are `validateRecipe` errors.** One error per group of keys with one identity, naming every original spelling (`N keys name the same event sheet <path>`, plus `(letter case is ignored)` for a case-only group). Invalid keys and invalid cross-layout field values (`from`, `sourceLayout`, `templatesLayout`, `targets[].layout`) are errors too, and so are cross-reference spelling splits. Op-template keys that render to one string throw at substitution in `substituteNode`. The extract-template self-check and the clone-replica duplicate-target check compare identity.
4. **Against the disk, refuse rather than resolve.** `checkKeySpelling` (module-private in `recipeApplier.ts`) runs right after `validateRecipe` and before workflow expansion, in dry-run as well. It refuses any recipe path (key, CREATE folder, cross-layout field) that matches the c3source event-sheet or layout listing only when letter case is ignored, and names the on-disk spelling. Case-folded matches are decided by the listing, so that answer does not depend on the host filesystem. `checkCreateTargets` refuses when `existsSync` is true (covering existing paths the listing does not hold) or when the listing has a case-folded match. `checkCreateTargets` matches the CREATE leaf case-insensitively too and prints `(on disk: …)`.
5. **Scaffold names use the same identity.** `scaffoldGuard` compares layout and objectType name conflicts with letter case ignored and reports the on-disk spelling. `output-exists` uses the exact basename in the directory listing. Layout SIDs seed from normalized keys (`layoutSidSeed`), where bare keys used to skip seeding.
6. **No public signature change.** `normalizeRecipePaths` keeps its signature and return type but throws on a collision. The new modules stay off-barrel. Everything ships as `fix:` with CHANGELOG callouts, the ADR 0043 precedent.

## Rejected alternatives

- **Resolve to the on-disk spelling.** Ambiguous when `Foo` and `foo` both exist on a case-sensitive filesystem; it needs re-validation after the rewrite; and a case-insensitive resolver is a discovery primitive that the leaf posture would send to c3source.
- **Host-dependent folding.** #253 requires the same behaviour everywhere; CI on Linux would disagree with a Windows dev machine.
- **Change `normalizeRecipePaths`' return type** to carry the original keys. Semver-major.
- **Disk I/O inside `validateRecipe`.** Already rejected by ADR 0043; it stays pure.
- **A side channel carrying the original keys** to the applier. A second source of truth for one fact.
- **Resolve `..` instead of rejecting it.** A rewritten key can silently name a different file; rejection is predictable.

## Consequences

- A case-sensitive project with an intentional `Foo`/`foo` pair cannot edit both in one recipe.
- Behaviour change: recipes relying on loose case on Windows, two spellings of one key, `..`/absolute/empty keys, and case-only scaffold names are now refused. The CHANGELOG lists each.
- Identity lowercases only and does no Unicode normalization: NFC and NFD spellings of one name compare unequal, while macOS APFS treats them as one file, so on macOS two spellings could target one file.
- The public `normalizeFileKey`/`normalizeLayoutKey` now return the canonical form, so their output changed for backslash, `./`, `//` and `.JSON` inputs and for a mis-cased section folder.
- The MCP read tools join a `sheet` argument without containment; that read-side gap is the follow-up [#275](https://github.com/GenvidTechnologies/construct3-chef/issues/275), out of scope here.
- `toLowerCase` Unicode folding may differ from NTFS's own folding for exotic characters.
- A case variant of an *empty* folder is not detected, since the listing is derived from files.
- Non-sheet CREATE targets still use `existsSync`. The objectTypes CREATE case/subfolder gap is [#274](https://github.com/GenvidTechnologies/construct3-chef/issues/274). *(Resolved by ADR [0059](0059-recipe-objecttypes-create-uses-the-objecttype-identity.md).)*
- The CLI help text is untouched; it stays with [#266](https://github.com/GenvidTechnologies/construct3-chef/issues/266). *(Resolved by ADR [0055](0055-cli-handler-errors-are-rendered-by-a-registration-guard.md).)*

**Amended by ADR [0064](0064-windows-reserved-device-names-are-refused-in-every-write-target-segment.md):** `keyIssue` also refuses a reserved device name segment, in every key and cross-layout field.
