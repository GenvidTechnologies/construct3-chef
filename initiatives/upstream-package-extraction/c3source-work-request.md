# Work Request → `c3source`

> **For:** the agent/maintainer working in the **`c3source`** repo.
> **From:** the `construct3-chef` repo (a downstream consumer of `c3source`).
> **Type:** additive API + type enrichment. **No breaking changes** are requested except where explicitly flagged in §2 (and that one is opt-in).
> **Status:** proposal / not yet started.

## Context

`c3source` is the C3 JSON domain layer — the source of truth for Construct 3's on-disk schema (types, file discovery, formatting primitives). `construct3-chef` mutates C3 projects and is one of its consumers.

An audit of `construct3-chef` found that the **same C3-domain logic has been reimplemented many times downstream**, almost always because a primitive or a type field that *belongs in `c3source`* is missing, forcing the consumer to hand-roll a traversal and cast through `as Record<string, unknown>`. There are ~85 such structural casts in `construct3-chef/src`, and the single most-duplicated shape is "recursively walk a C3 tree."

The goal of this request is to move that domain knowledge **up into `c3source`**, where the schema is already owned, so every C3 tool stops re-deriving it. Items are priority-ordered; each is independently shippable.

Each item lists **consumer evidence** (the `construct3-chef` call sites that will collapse once the API exists) purely as justification — you do not need access to that repo to implement anything here. After each item ships, `construct3-chef` will bump `.packages-version` and delete its local copy in a follow-up PR.

---

## 1. Add the type fields C3 actually stores (highest payoff, lowest risk)

`c3source`'s event/layout types omit several fields that C3 writes to disk, so consumers probe them with `"x" in obj && (obj as Record<string, unknown>).x`. All additions below are **optional** fields — purely additive, no behavior change.

### 1a. `disabled` / `isOrBlock` on events and conditions

```ts
export interface Condition {
  // ...existing...
  disabled?: boolean;          // C3 stores this; currently missing
}

export interface BlockEvent {
  // ...existing...
  disabled?: boolean;
  isOrBlock?: boolean;
}
```
`GroupEvent.disabled` already exists and is correct — no change there. Consider also adding `disabled?: boolean` to `FunctionLikeEvent` (covers `function-block` / `custom-ace-block`) if C3 emits it there.

**Consumer evidence:** `dslFormatter.ts:186, 332, 335, 627, 630` — five `"disabled" in cond` / `"isOrBlock" in event` structural probes that exist *only* because these fields aren't typed.

### 1b. Layout / Layer fields used for read-only inspection

```ts
export interface Layout {
  // ...existing...
  eventSheet?: string;
  width?: number;
  height?: number;
}

export interface Layer {
  // ...existing...
  overriden?: number;          // 0 | 1 — C3's global-layer-override marker
}
```

**Consumer evidence:** `layoutFormatter.ts:206-236` (`isOverriden`, `getLayoutSize`, `getLayoutEventSheet`) all cast through the index signature today.

### 1c. Correct a stale downstream assumption about `Layer.subLayers`

No change needed in `c3source` — `Layer.subLayers?: Layer[]` is already correct (camelCase, typed). This item is a **note**: `construct3-chef`'s `layoutFormatter.ts:210` carries a comment claiming the interface uses lowercase `sublayers` and casting around it. That is now false against your current API; the downstream fix is to delete the cast. Flagged here so the two repos agree on the contract.

**Acceptance:** all fields optional; existing consumers compile unchanged; `construct3-chef` can drop ~25 casts.

---

## 2. Make `formatCondition` handle `disabled` itself (opt-in behavior change)

`formatAction` already prefixes `[DISABLED] ` for disabled actions. `formatCondition` does **not**, so every consumer wraps it. Once §1a lands, `formatCondition` can do the same:

```ts
export function formatCondition(cond: Condition): string {
  const base = /* existing rendering */;
  return cond.disabled ? `[DISABLED] ${base}` : base;
}
```

⚠️ **Backward-compat flag:** this changes `formatCondition`'s output string for disabled conditions. If any consumer parses that output, it's a behavior change. Two safe options — **your call as the owner**:
- (a) bake the prefix in (mirrors `formatAction`, recommended for consistency), or
- (b) add a separate `formatConditionWithDisabled(cond)` export and leave `formatCondition` untouched.

**Consumer evidence:** `construct3-chef/dslFormatter.ts:184-189` defines exactly this wrapper today and notes the inconsistency in its docstring. Either option lets the consumer delete the wrapper.

---

## 3. In-memory tree visitors (the core of this request)

`c3source` already exposes **path-based** layout visitors (`visit_layers_in_layouts`, `visit_instances_in_layouts`) that read files. Consumers that already hold a parsed object in memory can't use those, so they hand-roll the recursion — repeatedly. Provide **in-memory siblings**, and refactor the existing path-based functions to be thin wrappers (read file → parse → call the in-memory visitor) so there is one traversal, not two.

### 3a. In-memory layout/layer/instance visitors

Mirror the existing visitor signatures (`LayerVisitor = (layer, fullLayerName) => number`, `InstanceVisitor = (instance, index, layer, fullLayerName) => boolean`):

```ts
export function visitLayers(layers: Layer[], visitor: LayerVisitor): number;
export function visitInstances(layout: Layout, visitor: InstanceVisitor): number;
```
Semantics: depth-first, recurse `subLayers`, build the dotted `fullLayerName`, honor the same early-return/count contract the path-based versions already use. Reuse this inside `visit_*_in_layouts`.

**Consumer evidence (≈12 hand-rolled copies that become one-liners):** `layoutMutator.ts` `findLayerInList`(35), `removeLayerFromList`(76), `findInstanceInLayers`(197), `collectChildInstances`(235), `findLayerOfInstanceInList`(270), `removeInstanceFromLayers`(740), `findTemplateInLayers`(897); `layoutFormatter.ts:484` `visitLayersRecursive`; `layoutScaffold.ts` `collectLayerUids`/`collectLayerSids`/`remapLayerInPlace`; `templateLister.ts`; `instVarMutator.ts:95` `walkLayerInstances`.

### 3b. Event-tree visitor with canonical C3 coordinate counter

This is the subtle, high-value one. C3 assigns each "counting" event a 1-based index used by `generateFunctionName` / `extractScriptsFromSheet` (both already in `c3source`). The counter increments on `group`, `block`, `function-block`, `custom-ace-block` and **not** on `variable` / `include` / `comment`. Consumers currently re-create this counter by hand and must keep it in lockstep with your `extractScriptsFromSheet` — a documented fragility (`dslFormatter.ts:548-552` exists solely to mirror it).

Own the canonical walk:

```ts
export interface EventVisitContext {
  parent: EventSheetEvent[];   // the array this event lives in (for mutation)
  index: number;               // index within `parent`
  jsonPath: string;            // e.g. "events[1].children[2]"
  eventNumber: number | null;  // C3 1-based counter; null for non-counting events
  depth: number;
}
export type EventVisitor = (event: EventSheetEvent, ctx: EventVisitContext) => void | boolean;
// returning `false` stops descent into that node's children (or halts; pick one and document it)

export function visitEvents(events: EventSheetEvent[], visitor: EventVisitor): void;
```
The `eventNumber` must match what `generateFunctionName` expects so a single source of truth backs both.

**Consumer evidence (5+ separate event walks):** `dslFormatter.ts:63` (`formatEvent`) and `:576` (`buildShallowSidMap.walk`), `includeTree.ts:44` and `:121`, `previewDiff.ts:19`, `sidUtils.ts:107`, `eventSheetMutator.ts` (`buildSidIndex`), `recipeApplier.ts:481/402`.

---

## 4. Pure-domain primitives currently stranded downstream

These are generic C3 operations with no consumer-specific (recipe/DSL) coupling. They build naturally on §3.

### 4a. Type-narrowing predicates + script-action helpers
```ts
export function hasChildren(e: EventSheetEvent): e is EventSheetEvent & { children: EventSheetEvent[] };
export function hasActions(e: EventSheetEvent): boolean;     // block | function-block | custom-ace-block
export function hasConditions(e: EventSheetEvent): boolean;
export function isScriptAction(a: ScriptAction | Record<string, unknown>): a is ScriptAction;
export function walkScriptActions(sheet: EventSheet): ScriptAction[];  // sibling of extractScriptsFromSheet
```
**Consumer evidence:** `isScriptAction` is defined **twice** (`eventSheetMutator.ts:646`, `recipeInterpreter.ts:1507`); the `eventType === "block" || ...` discriminator is inlined ~4× in `recipeInterpreter.ts`; `walkScriptActions` lives in `eventSheetMutator.ts:603`.

### 4b. SID discovery
```ts
export function collectSids(node: unknown): Set<number>;                 // all sids in a C3 JSON subtree
export function collectSidsWithPaths(node: unknown): Array<{ sid: number; path: string }>;
export function findSid(sheet: EventSheet, sid: number):
  { node: EventSheetEvent; slot: "event" | "condition" | "action" | "function-parameter" } | null;
```
`findSid` encodes which C3 slots carry SIDs (event / condition / action / function-parameter) — pure schema knowledge. **Consumer evidence:** `collectSids` is duplicated (`sidUtils.ts:101`, `generators.ts:465`); `findSidLocation` + the `SidSlot` union live in `recipeApplier.ts:480` and currently cast `(ev as { conditions?: ... })` for every slot.

### 4c. `extractFunctions`
```ts
export function extractFunctions(sheet: EventSheet):
  Array<{ kind: "function" | "custom-ace"; name: string; objectClass?: string }>;
```
"List the functions/custom-ACEs a sheet defines." **Consumer evidence:** `includeTree.ts:44`.

> **Scoping note for §4:** keep `c3source`'s additions *generic*. `construct3-chef` layers its own recipe addressing (`"sid:123…"` parsing, `resolveNode("events[0]…")`, `buildSidIndex`) on top — those stay downstream and will become thin wrappers over §3b + §4b.

---

## 5. C3 scene-graph & layer-default schema knowledge (medium priority)

This is genuine schema-owner territory but a larger surface; ship after §1–4 if bandwidth allows.

- **Default layer template** — `construct3-chef/layoutMutator.ts:94` (`buildLayer`) hardcodes C3's 24-field default layer JSON (`renderingMode:"3d"`, `backgroundColor:[0.369,…]`, …). "What a fresh C3 layer looks like" is a schema default; consider `c3source.makeDefaultLayer(name)`.
- **Scene-graph-root invariant** — root instances must be registered in `layout["scene-graphs-folder-root"].items`. Consumer inlines push/find/splice 3× (`layoutMutator.ts:515, 766, 868`). Consider `addSceneGraphRoot(layout, sid)` / `removeSceneGraphRoot(layout, sid)`.
- **Instance id remapping** — the rules "`parent-uid` and `children[].uid` are uids; `instanceFolderItem.sid` mirrors instance sid; scene-graph-folder-root items carry sids" are reimplemented 3× (`layoutMutator.ts:351`, `layoutScaffold.ts:137`, `spriteScaffold.ts:148`). Consider `remapInstanceIds(inst, uidMap, sidMap)`.

These also imply typing the relevant `Instance` scene-graph fields (`uid`, `parent-uid`, `sceneGraphData`, `instanceFolderItem`) rather than leaving them to the index signature.

---

## Summary / suggested order

| # | Item | Risk | Consumer casts/dupes removed |
|---|------|------|------------------------------|
| 1 | Optional type fields (`disabled`, `isOrBlock`, layout size/eventSheet, `overriden`) | none | ~25 casts |
| 2 | `formatCondition` disabled-prefix (opt-in) | low* | deletes a wrapper |
| 3 | In-memory `visitLayers`/`visitInstances`/`visitEvents` | medium | ~17 hand-rolled walks |
| 4 | predicates, `collectSids`, `findSid`, `extractFunctions` | low | several duplicates |
| 5 | scene-graph / layer-default schema | medium | 3× remap + 3× scene-graph-root |

\* §2 risk depends on chosen option (a vs b).

**Acceptance criteria (all items):** additive and non-breaking (except §2 option a, which must be a deliberate, documented output change); existing `c3source` consumers compile and pass tests unchanged; new exports covered by unit tests in `c3source` (especially §3b's `eventNumber` counter, which must agree with `generateFunctionName`/`extractScriptsFromSheet` on a multi-group/nested fixture).
