# Construct 3 Scripting API — Quick Reference

Online docs: <https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference>

Use `WebFetch` to pull full details from any URL below when needed.

## Key Pages

| Topic | URL |
|---|---|
| **Scripting overview** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference` |
| **IRuntime** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/iruntime` |
| **IObjectType** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/object-interfaces/iobjecttype` |
| **IInstance** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/object-interfaces/iinstance` |
| **IWorldInstance** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/object-interfaces/iworldinstance` |
| **ILayout** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/layout-interfaces/ilayout` |
| **ILayer** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/layout-interfaces/ilayer` |
| **Plugin interfaces** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/plugin-interfaces` |
| **Behavior interfaces** | `https://www.construct.net/en/make-games/manuals/construct-3/scripting/scripting-reference/behavior-interfaces` |
| **System expressions** | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/system` |

## IRuntime — Summary

### Lifecycle Events
`beforeprojectstart`, `afterprojectstart`, `beforeanylayoutstart`, `afteranylayoutstart`, `beforeanylayoutend`, `afteranylayoutend`

### Tick Events
`pretick`, `tick`, `tick2`

### Input Events
`keydown`, `keyup`, `mousedown`, `mousemove`, `mouseup`, `dblclick`, `wheel`, `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `deviceorientation`, `devicemotion`

### Other Events
`resize`, `suspend`, `resume`, `save`, `load`, `instancecreate`, `instancedestroy`, `hierarchyready`, `loadingprogress`

### Key Properties
- `objects` — access all object types (e.g., `runtime.objects.Sprite`)
- `globalVars` — access global variables (e.g., `runtime.globalVars.Score`)
- `layout` — current ILayout
- `dt` / `gameTime` / `wallTime` — timing
- `timeScale` — game speed multiplier
- `mouse` / `keyboard` / `touch` — input state

### Key Methods
- `callFunction(name, ...params)` — call an event sheet function
- `setReturnValue(value)` — set return value from a script action
- `signal(tag)` / `waitForSignal(tag)` — signaling between event sheets and scripts
- `goToLayout(nameOrIndex)` — navigate to layout
- `getLayout(nameOrIndex)` — get ILayout reference
- `getAllLayouts()` — all layouts
- `getInstanceByUid(uid)` — find instance by UID
- `random()` — seeded random [0,1)

## Common Plugin Scripting Interfaces

Fetch full details with WebFetch when working with a specific plugin:

| Plugin | Scripting page |
|---|---|
| Sprite | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/sprite` |
| Text | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/text` |
| Spritefont | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/spritefont` |
| Button | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/button` |
| JSON | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/json` |
| Dictionary | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/dictionary` |
| Array | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/array` |
| Audio | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/audio` |
| AJAX | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/ajax` |
| Browser | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/browser` |
| Local storage | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/local-storage` |
| Touch | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/touch` |
| Tiled Background | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/tiled-background` |
| 9-patch | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/9-patch` |
| Timeline controller | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/timeline-controller` |

## System Expressions — Common Patterns

| Expression | Returns | Usage |
|---|---|---|
| `tokencount(string, delimiter)` | number | Count tokens in a delimited string. `tokencount("a,b,c", ",")` → 3. **Caveat**: `tokencount("", ",")` → 1 (empty token) |
| `tokenat(string, index, delimiter)` | string | Get token at 0-based index. `tokenat("a,b,c", 1, ",")` → `"b"` |
| `loopindex` / `loopindex("name")` | number | Current iteration index in `repeat` / named `for` loop |

## System Iteration Conditions

| Condition | When to use |
|---|---|
| `System.repeat(count)` | Fixed iteration count. Access index via `loopindex` |
| `System.for(name, start, end)` | Named loop with explicit range. Access index via `loopindex("name")` |
| `JSON.for-each(path)` | Iterate JSON object keys or array elements. Uses `CurrentKey`/`CurrentValue` (C3 expressions only — not accessible from script actions; capture via `set-eventvar-value` first) |

`repeat` and `for` are interchangeable for token iteration — `for` is clearer when nesting or when the range doesn't start at 0.

## Event Sheet Reference

| Topic | URL |
|---|---|
| Event sheets overview | `https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/events/event-sheets` |
| Actions, conditions, expressions | `https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/events` |
| Functions | `https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/events/functions` |
| System object | `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/system` |
| Families | `https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/families` |
| Layouts | `https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/layouts` |
| Templates | `https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/objects/templates` |
