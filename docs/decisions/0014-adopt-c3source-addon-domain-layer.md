# 0014. Partial adoption of the c3source 1.8.0 `.c3addon` domain layer

- **Status:** Accepted
- **Date:** 2026-07-23
- **Issue:** [#136](https://github.com/GenvidTechnologies/construct3-chef/issues/136)

## Context

`@genvidtech/c3source@1.8.0` (floor bumped in [#131](https://github.com/GenvidTechnologies/construct3-chef/issues/131)/PR #135) shipped a `.c3addon` **domain layer** (`addons.d.ts`) — `readAddonPackage`/`AddonPackage`, `parseAcesModel`/`AcesModel`, `parseAddonMetadata`/`AddonMetadata`, `aceIdentity`/`findAce`/`findExpression`, `collectAddonAttribution`/`attributeObjectType`/`attributeFamily`, `findAllAddons`, and the `stripBom`/`UTF8_BOM`/`C3ADDON_EXTENSION`/`ADDON_*_FILE` domain facts. This overlaps machinery construct3-chef rolls locally across ~10 off-barrel `addon*`/`ace*` modules built out during the #100 c3addon-tooling umbrella (#106–#111, #98, #124, #125).

#136 asked whether to adopt that layer to dedup the local modules. The adoption posture (ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md)) says push traversal/discovery/domain-facts upstream and keep rendering/operations local — but with the standing caveat (the #42 → c3source#21 lesson) that **owning a fact upstream is not sufficient: the upstream primitive's *shape* must fit the consuming *operation*.** This is a read-only refactor: no new capability, non-breaking tool surface, and **byte-identical addon-tool output** (locked by ~10 test files + the `addon-sample`/`addon-validate`/`addon-validate-lang`/`addon-ace-diff`/`addon-ace-usage` fixture roots).

## Decision

**Adopt the small surface where the shape fits; keep the rest local on verified shape-fit grounds.** Concretely, four adoptions:

1. **`stripBom`/`UTF8_BOM`** — replace chef's module-private `stripBom` (the #124 BOM fix) with c3source's, kept at the `readAddonEntryWithSource` chokepoint. Byte-identical (both drop one leading U+FEFF); centralizes the r487-pinned fact upstream.
2. **`aceIdentity(kind, id)`** — replace the *two* duplicated local `aceKey` helpers (`addonAceDiff.ts`, `addonAceUsage.ts`), both `` `${kind}:${id}` ``. Byte-identical keys; `objectClass` stays out of the key (the #109 stability trap — see [`ace-objectclass`] context in the module docs).
3. **`readAddonAcesModel(addon): AcesModel`** — a *new, additive* seam in `addonReader.ts`: read `aces.json` via the existing hybrid reader → `parseAcesModel`, wrapped try/catch → empty model (preserving never-throw). This is the `DiscoveredAddon → AcesModel` hook the sequenced-after [#123](https://github.com/GenvidTechnologies/construct3-chef/issues/123) (expression usage) consumes for `findExpression`. It is the cleanest justification for adopting `parseAcesModel` at all, and touches no existing rendered output.
4. **`C3ADDON_EXTENSION`** — replace the `.c3addon` extension-*matching* literals in `discoverAddons` and `addonValidator.findAllAddonArchives` (rendered message strings stay literal).

Everything else stays local — see Compromise.

## Compromise

The adoptable surface is **deliberately small**. Each large module was assessed and kept local for a concrete shape-fit reason, recorded here so future work doesn't re-litigate "why not `readAddonPackage` everywhere?":

- **Hybrid reader (`readAddonEntry`/`readAddonEntryWithSource`) — KEEP.** Upstream `readAddonPackage` picks *one* on-disk form (directory OR zip) at construction; chef unifies `archivePath` + `extractedDir` **per entry** (falls through an incomplete extracted dir to the zip). And upstream directory mode is **top-level-only**, so it cannot back chef's nested reads — `addonLangValidator` reads `lang/*.json`, `listAddonEntries` recursively walks the extracted dir. Only `stripBom` (#1) and the new `AcesModel` seam (#3, top-level `aces.json`) are adopted here, not a reader swap.
- **`mapAcesJsonToEntries`/`AceEntry` — KEEP as the primary ACE pipeline.** `AceEntry` carries `objectClass`, renames params `id→name`, and folds `expressionName→scriptName`; it also emits **per-category interleaved** order, whereas `parseAcesModel` groups by kind — a naive swap reorders and breaks `formatAddonInfo` byte-identity (pinned by `addonReader.test.ts`). Upstream `parseAcesModel` also **throws** on a missing `scriptName`/`expressionName`, vs `mapAcesJsonToEntries`'s per-entry tolerance. Adopted only via the new #3 seam, where the all-or-nothing tolerance is acceptable (no pinned output).
- **`readAddonMetadata` — KEEP.** Chef maps kebab→camelCase and models `minConstructVersion`, and is tolerant (returns `{}` on malformed). Upstream `parseAddonMetadata` keeps kebab keys, omits `min-construct-version`, and **throws** on any missing required string — flipping chef's tolerant-partial to a throw on its quirky minimal fixtures.
- **`readUsedAddons` — KEEP.** `getUsedAddons` is not in the addon layer (it lives in `manifest.d.ts`), needs a pre-parsed `C3ProjectManifest`, and returns an array; `readProjectManifest` throws. Chef's is a tolerant `project.c3proj` **file** reader returning a **Map** keyed by id.
- **`readProjectObjects`/`ObjectDefn` — KEEP.** `AddonAttribution` flattens behaviors/effects to id-arrays with **no per-instance names and no members** — but #124's family-member attribution and #125's effect-site names need exactly those. `AddonAttribution` cannot back `ObjectDefn`.
- **`ObjectType`/`Family` parse types (the one *type-only* dedup originally scoped in) — DROPPED.** c3source's `ObjectType`/`Family` require `name`/`plugin-id` and place `members` only on `Family`, but `readObjectDefn` is deliberately **tolerant** — all fields optional (`json.name ?? basename`, `json.members ?? []`) to survive malformed/legacy entries. Casting to the strict upstream types breaks the union access (`members` isn't on `ObjectType`) and neuters the tolerant fallbacks. This is the same tolerant-parse-vs-strict-domain-type mismatch as the runtime cases above — dropped rather than forced, per the "near-zero-value cosmetic, do not force it" call.
- **`findAllAddons` — KEEP the local finders.** `discoverAddons` / `findAllAddonArchives` need **kind-by-subdir** attribution and archive↔extracted-dir pairing; `findAllAddons` returns bare paths with no kind. Only the extension *const* (#4) is adopted.
- **All formatters, the diff/usage/inventory/validator operations, `addonPropertyExtractor`, `addonLangValidator.parseAceItems` — KEEP** (rendering/operations are local by posture).
- **`customAceIndex.ts` — OUT OF SCOPE.** It reads event-sheet `custom-ace-block` functions + `families/*.json`, never `.c3addon` packages — zero overlap (the issue's "possibly" was wrong).

## Consequences

- No public-API change: every touched module is off the `src/index.ts` barrel; removing the local `stripBom`/`aceKey` helpers is not semver-breaking, and no new export was added.
- The never-throw and `(kind, id)`-identity contracts are preserved; all addon-tool output stays byte-identical (full suite green).
- #123 (expression usage) now has a ready `DiscoveredAddon → AcesModel` seam (`readAddonAcesModel`) and can build its resolver on `findExpression` without re-adopting `parseAcesModel` itself.
- The per-module shape-fit boundary above is the durable record of *why* the bulk of the local `addon*` layer is not a candidate for further upstream adoption — a reference for any future "should this move to c3source?" question.
