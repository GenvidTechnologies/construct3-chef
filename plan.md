# Plan: Fix Issues #18 (rich index searchText), #19 (read-event-sids matched-line display), #20 (global-layers.txt generator + tool)

## Branch
`feat/index-search-global-layers`

## Dependencies
None. `main` is clean.

## Locked decisions
1. #18 rich condition/action content goes in a **hidden search column** (not the visible Description).
2. #18 row model = **Option A**: extract one shared pure helper `buildBlockSearchText`; attach its output as a hidden `searchText` on the **block-level** `DslIndexEntry`; **remove** the visible per-action `describeAction` index rows; do NOT add literal per-condition/per-action rows; delete `describeAction` once dead.
3. #19 = render-time change in the `read-event-sids` handler only.
4. #20 = new `buildGlobalLayerReport` **sibling** in layoutFormatter.ts (do NOT change `buildGlobalLayerMap`'s `Map` return type); new `generateGlobalLayers` 6th generator; `list-global-layers` READ_ONLY MCP tool **in scope**. Instance count = source layer's total recursing sublayers. Multi-source case recorded in-file as `[WARNING: …]` annotation (no `console.warn`).
5. Add fixture coverage: add a small event-sheet block with a parameterized action (e.g. `GoToLayout` with a layout param) to the sample-project fixture so #18's hidden-searchText change shows up in the `.dsl.idx.txt` golden.

## The hidden-column mechanism (verified against code)
- `.dsl.idx.txt` block rows render as `... | <short description> ⟪search⟫ <flattened searchText>`. The `⟪search⟫` sentinel is in-band within the existing Description column — **NO new pipe column** (a new `|` column would corrupt `resolve-anchor`'s `parseIndexText`, which does `descParts.join("|")`, anchorResolver.ts:46-49).
- **PAIRED REQUIRED CHANGE:** `parseIndexText` (anchorResolver.ts:~49) must strip everything from `⟪search⟫` onward before assigning `description`, so resolve-anchor's name matching + display stay clean. Highest-risk line — gets its own test.
- `filterIndex` (dslFormatter.ts:648-675) unchanged — it greps the whole line, so it now matches the hidden tail. Keep its "keep all `#` lines" contract.
- `formatIndex` (dslFormatter.ts:458-511): when an entry has `searchText`, render `${description} ⟪search⟫ ${searchText.replace(/\n/g," ")}`. Column-width calc unaffected (Description is last, unpadded). Newlines MUST be flattened.
- `DslIndexEntry` (dslFormatter.ts:31-44) gains optional `searchText?: string` (block rows only).
- Define `const SEARCH_SENTINEL = " ⟪search⟫ "` once in dslFormatter.ts; reuse the exact same characters in `parseIndexText`. `⟪` is U+27EA, `⟫` is U+27EB.

---

## Tasks

### P1 — Extract `buildBlockSearchText` pure helper (zero behavior change)
**Issue:** #18 (prep). **Agent:** genvid:ts-implementer.

Move the `summarize` inner function inside `buildShallowSidMap` (dslFormatter.ts:541-561) out as an exported module-level function:
```
export function buildBlockSearchText(
  event: BlockEvent | FunctionBlockEvent | CustomAceBlockEvent,
  sheet: EventSheet,
  eventNumber: number,
): string
```
Body identical to extracted `summarize`. The three call sites (dslFormatter.ts:615,625,635) call `buildBlockSearchText(event, sheet, ctx.eventNumber ?? 0)`. Delete the inner closure.

**Tests** (test/c3/dslFormatter.test.ts, new `describe("buildBlockSearchText")`): purity (same input → same output); parity (block with parameterized action `GoToLayout`/`layout:"BattleLayout"` → result contains `"BattleLayout"`); empty block → `""`; multiline script action → full text present (vs describeAction truncation); function-block variant → conditions + actions present.

**Validation:** `npm run lint && npm run typecheck && npm test`. **Golden:** stays byte-identical.
**Commit:** `refactor: extract buildBlockSearchText pure helper from buildShallowSidMap inner fn`

---

### P2 — Add global-layer report/formatter/deep-count helpers (pure, unwired)
**Issue:** #20 (prep). **Agent:** genvid:ts-implementer.

Add to src/c3/layoutFormatter.ts (after `buildGlobalLayerMap`):
- `countInstancesDeep(layer: Layer): number` — recursively sums `(layer.instances ?? []).length` across the layer + all sublayers (use existing `getSubLayers`/`visitLayersRecursive`). NOT the shallow `countInstances`.
- `interface GlobalLayerReport { name; sourceLayout; overridingLayouts: string[]; instanceCount; multiSourceWarning?: string }`.
- `buildGlobalLayerReport(layouts): GlobalLayerReport[]` — sibling to `buildGlobalLayerMap` (do NOT change its signature). Source = `layer.global && !isOverriden(layer) && hasInstances(layer)` (reuse `isOverriden` :206, `hasInstances` :228). Collect overriding layouts where the same-named layer has `isOverriden === true`. `instanceCount = countInstancesDeep(sourceLayer)`. Multi-source → set `multiSourceWarning` string, NO `console.warn`. C3 spelling `"overriden"` verbatim.
- `formatGlobalLayers(reports): string` — `#`-header block + one line per layer; empty → `(no global layers found)`; trailing newline.

**Before coding:** read `Main Layout.json` to confirm it overrides "global layer" with `overriden:1`; confirm Second Layout instanceCount = 2 (subsublayer g.1.1 `Sprite2` + sublayer g.2 `Sprite`).

**Tests** (test/c3/layoutFormatter.test.ts — create if absent): fixture report has `{name:"global layer", sourceLayout:"Second Layout", overridingLayouts:["Main Layout"], instanceCount:2}`; multi-source in-memory fixture → `multiSourceWarning` present; `formatGlobalLayers([])` → `(no global layers found)`; non-empty → name/source/overriders/count rendered.

**Validation:** `npm run lint && npm run typecheck && npm test`. **Golden:** none.
**Commit:** `feat: add buildGlobalLayerReport + formatGlobalLayers pure helpers to layoutFormatter`

---

### F1 — #18 index wiring + fixture block + golden regen (highest-risk)
**Issue:** #18 core + paired anchorResolver. **Agent:** genvid:ts-implementer.

**dslFormatter.ts:**
1. `DslIndexEntry` (:31) add `searchText?: string` (block/function-block/custom-ace-block only).
2. Define `const SEARCH_SENTINEL = " ⟪search⟫ "`.
3. `formatBlock`/`formatFunctionBlock`/`formatCustomAceBlock` (:329-335/:364-370/:392-398): add `searchText: buildBlockSearchText({ name: sheetName } as EventSheet, …)` to the pushed block entry, using `counter.value` as the event number (after increment). `buildBlockSearchText` only reads `sheet.name`.
4. `formatBlockLike` (:271-277): **DELETE** the per-action `indexEntries.push(...)` block.
5. **DELETE** `describeAction` (:183-229); confirm no remaining callers via lint.
6. `formatIndex` (:488-511): block-row render → `entry.searchText ? \`${entry.description}${SEARCH_SENTINEL}${entry.searchText.replace(/\n/g," ")}\` : entry.description`. Delete the now-dead `actionIndex` render branch (:494-499); the `pathW` guard (:469-473) referencing `actionIndex` may stay harmlessly.

**anchorResolver.ts (PAIRED):** `parseIndexText` (:49):
```
const rawDesc = descParts.join("|").trim();
const i = rawDesc.indexOf(SEARCH_SENTINEL);  // import/share the same const
const description = i >= 0 ? rawDesc.slice(0, i) : rawDesc;
```

**Fixture (decision 5):** add a block event with ≥1 condition + a parameterized action (`GoToLayout`, layout param e.g. `"Main Layout"`) to `test/fixtures/sample-project/eventSheets/Event sheet 2.json`. New unique SIDs in `[1e14,1e15)` not colliding with `extracted/sid-registry.txt` (block + condition + action each need a SID).

**Golden regen:** `npx tsx src/cli.ts generate --project-dir test/fixtures/sample-project`; commit changed `Event sheet 2.dsl.idx.txt` + `sid-registry.txt`.

**Tests:**
- dslFormatter.test.ts: **rewrite** `describe("action-level index entries")` (:1268-1465) — it currently asserts action rows exist; invert to: block with actions → exactly ONE index entry, `searchText` populated + contains param value, no entry has `actionIndex`. Add: `formatIndex` block entry with `searchText` → line contains the sentinel + flattened tail; embedded newlines flattened; `filterIndex` grep for a param value (only in searchText) returns the block row. **Remove the `describeAction` import** (:22).
- anchorResolver.test.ts: inline row with `⟪search⟫ GoToLayout(...)` → `description` stripped of sentinel/tail; `resolveByName("<param value>")` → null; `resolveByName("block")` → matches. Verify the existing fixture row count (18) is unaffected.

**Validation:** `npm run lint && npm run typecheck && npm test`. **Golden:** INTENTIONAL (index + sid-registry).
**Commit:** `feat: #18 hidden searchText in DSL index blocks, remove action-level rows, parseIndexText strips sentinel`

---

### F2 — #19 show matched searchText in read-event-sids output
**Issue:** #19. **Agent:** genvid:ts-implementer.

src/mcp/server.ts (:407-410): when `grep` is set and `e.searchText` matches, append `  [matched: <first searchText line the regex hits>]` (`.trim()`) to the row. Skip when the match came only via `description`. Header + unfiltered output unchanged.

**Tests** (test/mcp/readEventSids.test.ts — new): build a `SidMapEntry` for a parameterized-action block, apply grep, assert rendered row contains `[matched: …]`; grep matching only `description` → no `[matched:]` suffix. (Server handler is not unit-instantiable; test the render logic / `buildShallowSidMap` shape; note golden also exercises it via F1's fixture block.)

**Validation:** `npm run lint && npm run typecheck && npm test`. **Golden:** none.
**Commit:** `feat: #19 show matched searchText content in read-event-sids output`

---

### F3 — #20 generator + CLI/server wiring + list-global-layers tool + golden file
**Issue:** #20. **Agent:** genvid:ts-implementer.

**generators.ts:** add `generateGlobalLayers(rootDir, outDir, log = console.log)` after `generateTemplateScope` (~:448), mirroring it: `find_all_layouts_path` → parse → `buildGlobalLayerReport` → `formatGlobalLayers` → write `global-layers.txt` → `log` a count line. Extend `./layoutFormatter.js` import (:17). Export it.

**cli.ts:** `GENERATOR_NAMES` (:29) add `"global-layers"`; generators array (:39-45) add 6th entry; import `generateGlobalLayers` (:8-14).

**server.ts:**
- import `generateGlobalLayers` (:29-35).
- `GENERATOR_STEPS` (:113-119) append 6th step.
- `runGenerators` `progressTotal = 5` → `6` (:129).
- Step-total constants: apply-recipe `6:1`→`7:1` (:779); clone-layout `7:2`→`8:2` (:1058); workflow `6:1`→`7:1` (:1305); regenerate description "all 5"→"6" + add global layers to the list (:834). Grep `totalSteps`/`progressTotal` after editing to confirm no stale `5`/`6`/`7`.
- Register `list-global-layers` after `list-layouts` (~:304), mirroring `read-template-scope`: `READ_ONLY`, `{ ...PAGINATION_PARAMS }`, `rwlock.read` → `readExtracted("global-layers.txt")` → `notFound` on null → `paginatedResponse(text, offset, limit)`. No `checkSourceFreshness` (multi-source, like read-sid-registry; dirty flag covers staleness).

**Golden regen:** `npx tsx src/cli.ts generate --project-dir test/fixtures/sample-project`; commit new `global-layers.txt`.

**sampleProjectGolden.test.ts** (:14-21, :74-78): import + call `generateGlobalLayers(tmpRoot, outDir, noop)` in `before`. File-set/byte assertions auto-cover the new file.

**Tests:** unit test on `buildGlobalLayerReport`+`formatGlobalLayers` over the fixture asserting `"global layer"`/`"Second Layout"`/`"Main Layout"` appear (full handler test needs a server spawn; formatter test + golden suffice).

**Validation:** `npm run lint && npm run typecheck && npm test && npm test -- sampleProjectGolden`. **Golden:** INTENTIONAL (new file).
**Commit:** `feat: #20 generateGlobalLayers 6th generator, CLI + server wiring, list-global-layers MCP tool`

---

### F4 — Docs
**Issues:** #18/#19/#20. **Agent:** genvid:ts-implementer.

- `docs/generators.md`: "Running" (add `--only global-layers`, "all 5"→"all 6"); "Output Structure" (add `global-layers.txt`); "DSL Index Format" (action rows no longer appear; block rows carry the hidden `⟪search⟫` tail used for grep; `filterIndex` searches the whole line).
- `docs/c3/layout-reference.md` § Tooling gap (:108-110): mark #20 resolved; describe `global-layers.txt`.
- `docs/TOC.md`: no change expected.

**Commit:** `docs: update generators + layout-reference for #18 index searchText, #19 matched display, #20 global-layers`

---

## Final validation
`npm run lint && npm run typecheck && npm test && npm test -- sampleProjectGolden`

## Risks
| Risk | Mitigation |
|------|-----------|
| `parseIndexText` paired strip is highest-risk: wrong sentinel → resolve-anchor matches param values as names. | Dedicated round-trip tests in F1; single shared `SEARCH_SENTINEL` const. |
| Sentinel codepoint drift between formatIndex and parseIndexText. | One shared const (`⟪`=U+27EA, `⟫`=U+27EB); round-trip test. |
| Existing `action-level index entries` suite asserts action rows EXIST. | F1 rewrites the whole suite + removes the `describeAction` import. |
| Four hidden `totalSteps`/`progressTotal` constants in server.ts. | F3 lists all four; grep after editing. |
| Golden touched twice (F1 index, F3 new file). | Work branch sequentially; full regen in both F1 and F3. |
| Main Layout `overriden:1` / instanceCount=2 unverified. | P2 reads `Main Layout.json` + `Second Layout.json` before coding; corrective fixture edit if wrong. |

## Close-out
After merge: comment resolution on issues #18, #19, #20 and close them.
