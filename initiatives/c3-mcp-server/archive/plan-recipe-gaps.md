# Plan: Recipe Gap Features

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch
`BUR-0000-episode-list-session3` (continuing on current branch)

## Summary

Implement two missing recipe system features that block the Thumbnail Loading task: `custom-ace-block` builder shorthand and `add-inst-vars` recipe operation.

## Feature 1: `custom-ace-block` Builder Shorthand

**Problem**: The recipe builder supports `function-block` but not `custom-ace-block`. They share 90% of their structure (via `FunctionLikeEvent`), with `custom-ace-block` adding `aceType`, `aceName`, and `objectClass`.

**Design**: Mirror the `function-block` shorthand exactly, adding the three extra fields.

Shorthand format:
```json
{
  "custom-ace-block": {
    "name": "SetupThumbnail",
    "object": "VODStateJSON",
    "aceType": "action",
    "params": [
      { "name": "vodId", "type": "string" },
      { "name": "vodPath", "type": "string" }
    ],
    "actions": [ ... ],
    "children": [ ... ]
  }
}
```

**Files to modify**:
- `bin/c3/eventSheetMutator.ts` — add `buildCustomAceBlock()` (parallel to `buildFunctionBlock`)
- `bin/c3/recipeInterpreter.ts` — add `CustomAceBlockShorthand` interface, extend `BuilderEvent` union, add expansion in `expandEvent()`
- `test/C3/recipeInterpreter.test.ts` — add tests for builder, expansion, and insert-event with custom-ace-block
- `docs/recipe-reference.md` — document the new shorthand

## Feature 2: `add-inst-vars` Recipe Operation

**Problem**: Adding instance variables to an existing objectType requires manual edits to three locations: objectType JSON, all layout instances, and `instanceTypes.d.ts`.

**Design**: New top-level recipe section `addInstVars` (parallel to `objectTypes`). Processing order: `objectTypes` → `addInstVars` → `layouts` → `files`.

Recipe format:
```json
{
  "addInstVars": [
    {
      "type": "VODStateJSON",
      "instanceVariables": [
        { "name": "episodeCount", "type": "number" },
        { "name": "language", "type": "string" }
      ]
    }
  ]
}
```

**What it does** (3 locations):
1. **ObjectType JSON** — find `objectTypes/**/VODStateJSON.json`, append to `instanceVariables` array with `desc`/`show`/`sid: 0` format
2. **Layout instances** — scan all layout JSON files for instances with `"type": "VODStateJSON"`, add default values to their `instanceVariables` object
3. **TypeScript defs** — update `scripts/ts-defs/instanceTypes.d.ts`: add `instVars` block to existing class, or add fields to existing `instVars` block

**Edge cases**:
- ObjectType file location: search recursively under `objectTypes/` (not just root level)
- InstVar already exists: skip with warning (idempotent)
- Class doesn't exist in `instanceTypes.d.ts`: create it (need to know the plugin base class → read from objectType JSON)
- Non-world instances: JSON/Dictionary/Arr plugins appear in `nonworld-instances` array (not layers)
- World instances: Sprite/TiledBg/etc. appear in layer `instances` arrays (need recursive layer scan)

**Files to modify**:
- `bin/c3/recipeInterpreter.ts` — add `AddInstVarsEntry` type, extend `Recipe` interface, add validation
- `bin/applyRecipe.ts` — add `processAddInstVars()` function (objectType JSON + layouts + ts-defs)
- `test/C3/recipeInterpreter.test.ts` — add validation tests
- `test/C3/applyRecipe.test.ts` (new or existing) — add integration tests for the 3-location update
- `docs/recipe-reference.md` — document the new section

## Friction Audit

1. **Seams already exist**: `buildFunctionBlock` and `createObjectType`/`updateInstanceTypes` provide clean patterns to extend.
2. **No async joins needed** — both features are synchronous file mutations.
3. **ObjectType file discovery**: Need a helper to find `objectTypes/**/Name.json` recursively. The `scaffold-sprite` tool already has `findJsonFiles` — reuse that pattern.
4. **Layout instance scanning**: Need to scan both world instances (in layers) and non-world instances. `collectAllUids` in `scaffoldLayout.ts` already walks this structure — similar traversal needed.
5. **`instanceTypes.d.ts` mutation**: The existing `updateInstanceTypes` in `applyRecipe.ts` inserts new classes. For `add-inst-vars`, we need to find an existing class and add/update its `instVars` block — different logic, but same file.
6. **VODStateJSON instVar format mismatch**: VODStateJSON currently uses `initial-value`/`comment` (non-standard), while all other objectTypes use `desc`/`show`. The `add-inst-vars` op should use the standard `desc`/`show` format. Optionally normalize the existing VODStateJSON entry on first use.

## Todo List

1. Add `buildCustomAceBlock()` to eventSheetMutator.ts and commit
2. Add `CustomAceBlockShorthand` to recipeInterpreter.ts (interface, BuilderEvent union, expandEvent) and commit
3. Add tests for custom-ace-block builder and expansion, and commit
4. Add `AddInstVarsEntry` types and validation to recipeInterpreter.ts, and commit
5. Add `processAddInstVars()` to applyRecipe.ts (objectType + layouts + ts-defs), and commit
6. Add tests for add-inst-vars operation, and commit
7. Update recipe-reference.md with both features, and commit
8. Fix VODStateJSON objectType instVars to use standard `desc`/`show` format (normalize `initial-value`/`comment`), and commit
9. Run code review and final validation

## Risks

| Risk | Mitigation |
|------|------------|
| `instanceTypes.d.ts` class parsing fragile | Use regex matching existing class patterns; test with real file content |
| Layout instance scan misses nested layers | Reuse proven recursive layer walking from `scaffoldLayout.ts` |
| ObjectType instVar format varies (`desc`/`show` vs `initial-value`/`comment`) | Use standard `desc`/`show` format; C3 editor normalizes on save |
| `add-inst-vars` on Sprite objectTypes needs different layout scan than Json | Scan both `nonworld-instances` and layer `instances` arrays |
