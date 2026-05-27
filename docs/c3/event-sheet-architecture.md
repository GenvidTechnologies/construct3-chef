# C3 Event Sheet Architecture

> Part of the [C3 platform reference](README.md). Describes how Construct 3 event sheets are structured on disk — the JSON that construct3-chef reads and mutates.

## Composition via Includes

Event sheets build complex behavior through composition. A sheet can include other sheets:

```json
{
  "eventType": "include",
  "includeSheet": "CommonEvents"
}
```

This creates a hierarchical structure where high-level orchestrator sheets pull in feature-specific sheets.

**Include removal safety**: Removing an include silently breaks **all trigger-based events** in the removed sheet and its transitive includes. This includes `on-instance-signal`, `on-created`, `on-destroyed`, `on-timer`, `on-tweens-finished`, `on-start-of-layout`, `on-any-touch-end`, and any other trigger. Triggers only fire if their event sheet is in the current layout's include chain — there is no runtime error when they stop firing.

Before removing an include, verify the removed sheet (and all its transitive includes) has no triggers needed by the current layout. If a function depends on trigger handlers (e.g., a CloudScript call that needs an `on-instance-signal` response handler), co-locate the trigger handler in the same group as the function and document the dependency in the function's description.

**Layout event sheets should be unique**: The event sheet directly associated with a layout should contain logic specific to that layout. Exceptions exist (e.g., level layouts sharing a base sheet), but even those should be narrowly scoped. If a layout's event sheet contains logic for multiple unrelated layouts, it should be split.

**`LayoutName ==` guards are a code smell**: If an event sheet needs a `LayoutName == "X"` guard to avoid running on the wrong layout, it means the include structure is pulling that sheet into layouts where it doesn't belong. The fix is usually to restructure includes so the sheet only runs where it's needed — not to add more guards. In TypeScript scripts, the equivalent guard is `runtime.layout.name === "X"`. Small behavioral variances across layouts (e.g., display formatting) are acceptable with a guard, but anything larger should use handler extraction with static parameterization (see below). When restructuring is too expensive (e.g., deep transitive dependency chains), a layout guard is an acceptable short-term pragmatic fix, but should be flagged for future cleanup.

**Handler extraction via parameterization**: When two layouts need identical handler logic except for layout-specific names (layer names, object names), extract the handlers into a shared event sheet and parameterize the differences via a static variable with a sensible default. Each layout overrides the static on start-of-layout. This avoids both code duplication and layout guards.

## Layout Event Sheets vs Included Event Sheets

Every layout has one **layout event sheet** — the top-level sheet assigned directly to the layout. All other sheets reachable via `include` are **included event sheets**. This distinction has important implications:

**Rules:**

- A layout should have exactly one layout event sheet. That sheet is the layout's identity — it should contain logic specific to that layout.
- An included event sheet should never be assigned as the layout event sheet for a non-template layout. If the same eventsheet is the layout sheet for multiple unrelated layouts (e.g., MainMenuEvents serving both BattleLayout and HeroSelectLayout), the shared `on-start-of-layout` becomes a source of unintended side effects.
- The first include in every layout event sheet should be `CommonEvents` (the project's shared utilities sheet). This ensures common functions, audio, and networking are available everywhere.
- Exception: template/testing layouts may share a layout event sheet when they are intentionally identical.

**Constructor/destructor patterns (on-start/end-of-layout in included sheets):**

Included event sheets are analogous to base classes in an object hierarchy. Their `on-start-of-layout` and `on-end-of-layout` blocks fire for every layout that includes them, which leads to the same design constraints as constructors/destructors:

- **Keep construction to a minimum.** `on-start-of-layout` in an included sheet should only initialize state that is universally needed by all including layouts. Layout-specific init belongs in the layout's own event sheet.
- **Delegate complex logic to initialization functions.** If a layout needs complex setup (energy check, level source config, header refresh), define a function and have the layout event sheet call it explicitly. This makes the init explicit and avoidable.
- **Be mindful of static variables that may already be initialized.** Static event variables retain their values across layout changes. An `on-start-of-layout` that unconditionally resets a static may clobber a value set by the previous layout.

**Trigger execution order:**

- Triggers (`on-start-of-layout`, `on-end-of-layout`, `on-instance-signal`, etc.) fire in **include order** — the first trigger in the first included sheet fires before the same trigger type in the layout event sheet.
- Some function calls and actions are **dispatched** (async/deferred) and may not complete before the trigger handler returns. Use `System.wait-for-previous-actions()` when subsequent actions depend on dispatched results.
- Functions (non-trigger) are **always global** — they can be called from any sheet regardless of include tree. Include tree only controls trigger installation.
- **Action ordering within a block matters.** C3 actions execute sequentially. Variables consumed by a function call must be set *before* that call in the action list. Gotcha: if a layout displays wrong state on first load but corrects after re-triggering (e.g., arrow navigation, tab switch), check that all variables are assigned before the display-update call in `on-start-of-layout`.

**Script actions are always async.** Every `"type": "script"` action in C3 is compiled to an async function. Promises returned by scripts are collected per block, but they do **not** block the next action in the same block — two scripts in the same block race each other. `System.wait-for-previous-actions()` is the only way to serialize: it suspends the current block until every previously-dispatched promise resolves. When analyzing event sheet timing, always assume scripts run concurrently within a block; look for `wait-for-previous-actions` to identify the only deterministic serialization points.

**`wait-for-previous-actions` yields to other on-start blocks.** Because the wait suspends the current block (not the tick), other `on-start-of-layout` blocks queued for the same tick get a chance to run while it waits. When block A waits, blocks B/C/D fire; when A resumes, its remaining actions execute against whatever shared state B/C/D may have modified. Concrete trap: a block that sets a global, then waits, then reads the global is **not** safe — a sibling on-start handler can clobber the global during the wait. If shared state is contested across on-start blocks, the authoritative correction is a `trigger-once-while-true` block on the first tick, not action ordering within on-start. And — repeating the warning above — never add `wait-for-previous-actions` to a *shared* sheet's on-start unless the yield is safe for every layout that includes it.

## Per-Layout Event Sheet Pattern

When multiple layouts share a top-level event sheet, every unguarded `on-start-of-layout` handler fires on all of those layouts. This leads to guard proliferation (`LayoutName == "X"` conditions scattered everywhere) and subtle timing bugs when initialization order differs per layout.

The preferred pattern is to give each layout its own top-level event sheet:

- **Each layout gets its own top-level event sheet** — e.g., `HeroSelectLayoutEvents` for HeroSelectLayout
- **Shared logic stays in included sheets** — CommonEvents, HeroSelectionEvents, etc. are still included
- **Layout-specific initialization lives in the layout's own sheet** — no guards needed; the sheet only runs for that layout
- **C3 functions are global** — they work regardless of include tree. Only trigger-based events (`on-start-of-layout`, `on-tap`, `every-tick`) depend on the include tree
- **A function is safe to call without including its sheet** only if it doesn't rely on trigger-based events defined in that same sheet. A pure function with no trigger-handler dependencies is always safe; a function that relies on a signal handler registered by its sheet is not. Example: `startGameRequest()` calls `callCloudScript` (global — works), but its `on-instance-signal` success handler is a trigger that only fires if the defining sheet is included. Without it, the cloud script runs but the callback never executes.
- **Migration can be done one layout at a time** — other layouts continue using the shared sheet during the transition
- **Never add `wait-for-previous-actions` to shared event sheet blocks** — a wait added to a shared sheet's on-start block changes interleaving for EVERY layout that includes it, not just the target layout. If you need sequencing for a specific layout, add the wait in that layout's own event sheet.

**When to prefer splitting over guards**: If an initialization bug requires understanding how a shared sheet interacts across 5+ layouts, that is a signal to split rather than guard. The split makes all layouts' init paths explicit and independent. Guards are an acceptable short-term fix when splitting is too disruptive, but they compound over time.

## Event Sheet JSON Structure

Each event sheet is a JSON file with this shape:

```json
{
  "name": "EventSheetName",
  "events": [ ... ],
  "sid": 923318843836904
}
```

The `events` array contains five types of entries:

| Type | Purpose |
|------|---------|
| `comment` | Documentation annotations |
| `include` | Pulls in another event sheet |
| `variable` | Declares a local variable (number, string, boolean) |
| `group` | Organizes events into collapsible sections |
| `block` | Conditions + actions -- the core logic unit |

**Block structure:**

```json
{
  "eventType": "block",
  "conditions": [
    { "id": "condition-id", "objectClass": "ObjectType", "parameters": { ... } }
  ],
  "actions": [ /* see Action Types below */ ],
  "children": [ /* nested sub-events */ ]
}
```

Note the field name: nested events live under `children`, not `events`. Only the top-level event sheet object uses `events`. Hand-rolled JSON walkers that recurse on `events` will silently visit nothing past the root; recurse on `children`.

**Looking up SIDs in source JSON.** When you need the SID of a function or block from a `.json` source file (for a recipe's `in: "sid:X"`), don't parse the JSON yourself. Use `mcp__construct3-chef__read-event-sids` with a `grep` regex on the description — it returns a JSON-path-to-SID map for the matching events. Use this when SIDs from the latest mutation aren't yet in the extracted `.dsl.idx.txt`. Otherwise, prefer `read-dsl-index` for the §-prefixed SID column.

**Action types** -- actions in the `actions` array appear in five shapes:

**Standard action** (most common) -- C3 built-in or plugin action:

```json
{ "id": "set-text", "objectClass": "ScoreText", "sid": 123, "parameters": { "text": "0" } }
```

### Expression Parameters vs Enum Parameters

Action and condition `parameters` values are **C3 expressions**, not plain strings. This distinction matters for string literals:

- **Expression parameters** (e.g., `animation`, `layer`, `text`, `path`, `first-value`, `second-value`) — string literal values must be wrapped in escaped quotes: `"\"pressed\""`. A bare `"pressed"` is parsed as a variable name, producing "Unknown expression 'pressed'" errors. Numeric literals and variable references are bare: `"0"`, `"currentLevelIndex"`
- **Enum parameters** (e.g., `visibility`, `from`, `comparison`, `type`) — use bare keyword values: `"invisible"`, `"beginning"`, `"start"`. These are C3 enums, not expressions

```json
// ✓ Correct — string expression with escaped quotes, enum bare
{ "id": "set-animation", "parameters": { "animation": "\"pressed\"", "from": "beginning" } }
{ "id": "is-on-layer", "parameters": { "layer": "\"HUD Base\"" } }

// ✗ Wrong — bare string in expression param causes C3 errors
{ "id": "set-animation", "parameters": { "animation": "pressed" } }
{ "id": "is-on-layer", "parameters": { "layer": "BattleLayoutLayer Base" } }
```

When unsure whether a parameter is an expression or enum, check an existing eventSheet that uses the same action/condition.

**Script action** -- embedded TypeScript (what `extract-scripts` extracts):

```json
{ "type": "script", "language": "typescript", "script": ["const x = 1;", "console.log(x);"] }
```

**Function call action** -- calls a `function-block` defined in an event sheet:

```json
{ "callFunction": "playSFX", "parameters": ["\"menuNavClick\""] }
```

**Custom action** -- calls a `custom-ace-block` on a specific object class:

```json
{ "customAction": "Initialize", "objectClass": "CardScroller", "parameters": ["1", "\"heroes\""] }
```

**Comment action** -- inline documentation inside a block's actions array:

```json
{ "type": "comment", "text": "Setup player state" }
```

Note: script extraction only handles script actions. The other shapes contain significant game logic that is not visible in extracted TypeScript files -- read the `.dsl.txt` files to see the full picture.

## Event Sheet Hierarchy

Projects typically build behavior from a top-level orchestrator event sheet that `include`s many feature-specific sheets, organized into directories by domain. New object logic should live in dedicated event sheets pulled in via `include` rather than being concentrated in one large sheet.
