# C3 TypeScript Integration

> Part of the [C3 platform reference](README.md). Covers the C3 TypeScript scripting and async-execution semantics that construct3-chef's extracted `.ts` output reflects.

## The Facade Pattern (imports-for-events)

C3 event sheet script blocks can only access what a single barrel-export module re-exports. The C3 editor generates an `importsForEvents.ts` that imports the project's TypeScript modules and re-exports them for event sheet consumption. Adding a new module to script-block scope requires creating the module under `scripts/`, adding an import/export line to that barrel file, and registering the file with a unique SID in `project.c3proj`.

## Runtime Object Access

C3 exposes game objects through `IRuntime`. TypeScript modules access game data via these objects:

```typescript
// Reading a C3 JSON object
const data = runtime.objects.SomeJsonObject.getFirstInstance()!.getJsonDataCopy();

// Writing to a C3 JSON object
runtime.objects.SomeJsonObject.getFirstInstance()!.setJsonDataCopy(updated);

// Accessing a game object instance
const inst = runtime.objects.SomeSprite.getFirstInstance();

// Reading/writing global variables
const n = runtime.globalVars.someNumber;
runtime.globalVars.someFlag = true;
```

**`globalVars` is a member of `runtime`** — in TypeScript script actions, always use `runtime.globalVars.X`, not bare `globalVars.X`. The bare form is not in scope inside script blocks.

## TypeScript in C3

- `IRuntime` and other types from `scripts/ts-defs/` are globally available -- no explicit imports needed
- The generated barrel module provides whatever modules are made available to all script blocks
- Always import from index files (e.g., `common/public/index.js`), not specific internal files
- Types in `scripts/ts-defs/` may be stale -- re-export from the C3 editor to refresh
- All script blocks run in an async context (`await` is valid)

## Block Concurrency Model

C3 blocks are **not sequential** — sibling blocks within a function (or top-level event sheet) run concurrently. If one block contains a blocking action (e.g., `wait-for-signal`), sibling blocks do not wait for it. This also applies to **loop iterations** (`repeat`, `for-each`): iteration 0 can run in parallel with iteration 1.

`System.wait-for-previous-actions()` waits for prior actions **in the current block, for the current iteration only**. It cannot synchronize across sibling blocks or across loop iterations:

```text
// Sibling block 1: repeat loop — each iteration runs in parallel
block
  when: System.repeat(count=N)
  do: System.wait(seconds=loopindex / 2)       // staggered delay per iteration
  do: SomeObject.spawn-another-object(...)

// Sibling block 2: runs concurrently with the loop above
block
  do: SomeObject.SomeAsyncAction(...)
  do: System.wait-for-previous-actions()        // waits for the action above (this block only)
  do: System.set-boolean-eventvar(done, false)
```

**Chaining** — while it can't synchronize across iterations, `wait-for-previous-actions` composes through function/ACE calls: a `wait-for-previous-actions` placed after an ACE call waits for that ACE to finish all of its own dispatched work before continuing.

**Sync barrier pattern** — when an ACE/function's sibling blocks are all *conditional*, the function can return early (before matched blocks finish their async work, or if no block matched). A trailing *unconditional* block containing only `wait-for-previous-actions()` acts as a sync barrier that prevents the function from returning until prior async work settles:

```text
ace SomeObject.DoWork()
  block (else / conditional siblings ...)
    do: ... async work
    do: System.wait-for-previous-actions()

  block                                           // ← sync barrier (unconditional)
    do: System.wait-for-previous-actions()        // prevents the ACE from returning early
```

Combined with reentrance guards (instance variables that prevent redundant work) this is how C3 expresses complex async state machines.

**Implication for variables**: Don't declare a variable at function scope and expect a script action in one sibling block to set it before another sibling block reads it. Declare the variable in the narrowest scope (the block that both sets and reads it) to avoid race conditions.

### Script Action Async Model

All script actions in C3 event sheets are async functions. Within a block, each script action's promise is collected but does **not** block the next action. This means:

- Two script actions in the same block run concurrently — they race each other
- A non-script action placed after a script action may execute before the script completes
- `System.wait-for-previous-actions()` awaits all collected promises before continuing — it is the only way to serialize execution within a block
- Function calls (`call foo()`) dispatch synchronously, but any scripts inside the called function are still async within their own block

**Practical implications**:

- When a script action sets a value that a subsequent action depends on, insert `wait-for-previous-actions` between them. Without it, the subsequent action sees stale state.
- **`wait-for-previous-actions` causes block interleaving**: When block A has a `wait`, it yields execution. Other on-start-of-layout blocks (B, C, D) fire while A is suspended. When A resumes, B/C/D may have modified shared globals. Don't rely on on-start ordering for globals that other blocks clobber — use a `trigger-once-while-true` child on the first every-tick as the authoritative correction point.

## Async C3 Functions (Signal + Wait Pattern)

C3 functions can be made async using `System.wait-for-signal` internally and `System.wait-for-previous-actions` at call sites. This is the standard pattern for C3 functions that need to wait for an async operation (CloudScript call, timer, etc.) before returning:

**Inside the function** — wait for a named signal:

```text
function RefreshData() -> none
  block
    when: someGuardCondition
    do: ... (trigger async operation)
    do: System.wait-for-signal(tag="operationDone")
```

**At call sites** — call the function, then wait for it to complete:

```text
do: call RefreshData()
do: System.wait-for-previous-actions()
... (subsequent actions see the async result)
```

**Completing the signal** — the async operation's handler fires the signal:

```text
block
  when: SomeResponder.on-instance-signal(tag=...)
  do: ... (process response)
  do: System.signal(tag="operationDone")
```

**Key points:**

- Use `System.signal` / `System.wait-for-signal` (not instance signals) for generic coordination — no instance picking side effects
- Instance signals (`on-instance-signal`) are for response routing where picking the responding object matters
- Multiple callers waiting for the same signal all resume when it fires — use a guard boolean to prevent redundant async operations (e.g., only the first caller triggers the operation, others just wait)
- Both success and error handlers must fire the signal so callers always unblock

## `functionIsAsync` and Caller Waitability

`functionIsAsync: true/false` on a C3 function block does **not** decide whether the
body runs as a promise. Script blocks and most C3 actions always run inside an async
context — both async-marked and non-async-marked function bodies execute as promises.

The flag **only** controls whether the caller can use `wait-for-previous-actions` to
await the function's completion:

| `functionIsAsync` | Caller can wait | Body runs as |
|-------------------|-----------------|--------------|
| `true` | Yes — `wait-for-previous-actions` after `callFunction` will wait | Promise |
| `false` | No — `wait-for-previous-actions` after `callFunction` returns immediately | Promise |

### Consequences for trigger handlers

A trigger handler (`on-instance-signal`) that calls an async function via `callFunction`
without `wait-for-previous-actions` dispatches the function body but returns
immediately. Subsequent layout transitions or runtime state changes can cause queued
network work (e.g. an internal `callCloudScript`) to be dropped before it executes —
even though the function "is" being called.

**Anti-pattern** — flipping a function from `functionIsAsync: true` to `false` to
"fix" a downstream call that doesn't fire. Changing the flag does nothing about how the
body runs; it only removes the caller's ability to wait, making the problem harder to
diagnose.

**Canonical fix** — when a trigger handler invokes an async function whose completion
the cascade depends on, add `wait-for-previous-actions` after the `callFunction` action:

```text
block
  when: SomeResponder.on-instance-signal(...)
  do: call sendData()                      // async function with internal network work
  do: System.wait-for-previous-actions()   // ← ensures the next step runs after sendData completes
  do: ... (next cascade step)
```

Without the `wait-for-previous-actions`, the trigger handler returns before `sendData`'s
internal async work executes, silently dropping it.

## Function Return Types and Call Conventions

C3 has two ways to invoke a function, and the return type determines which is valid:

| Return type                          | `call FuncName()` action      | `Functions.FuncName` expression         |
|--------------------------------------|-------------------------------|-----------------------------------------|
| `-> none`                            | Valid                         | **Error** — no return value             |
| `-> number` / `-> string` / `-> any` | **Error** — wrong return type | Valid (use without `()` for zero args)  |

- **`call` action** (`callFunction` in JSON): For fire-and-forget invocations. Requires `-> none`.
- **`Functions.X` expression**: For using the return value in parameters or assignments. Requires a non-`none` return type. Syntax: `Functions.FuncName` for zero arguments, `Functions.FuncName(arg1, arg2)` when arguments are present. **Never use `()` on a zero-argument function** — C3 raises `')' can't go here`. Typically used in `compare-two-values` conditions (`first-value=Functions.canAffordGame`) or action parameters.

If a function needs to be called both ways (some callers need the value, others don't), prefer `-> none` and let callers that need the result check state independently (e.g., calling a pure helper function after the void call).

## Local Variable Scoping

C3 local variables (`var`/`static` event type) have scope rules that differ from most programming languages:

**Scope is determined by position in the event tree, not lexical nesting:**

- A variable declared inside a block's `children` array is scoped to that block's **sub-events** — it is NOT in scope for that block's own `actions`.
- A variable declared in a group's `children` is in scope for all events within that group, including nested blocks and their `actions`.

**Correct pattern** for using `localVars.X` inside an action — declare at group level (sibling before the block), not inside the block's children:

```text
group "My Group"
  var canAfford: number = 0       ← group-level: in scope for all child block actions
  block
    when: Touch.on-tap-object(...)
    do: script { localVars.canAfford = data.canAffordGame(runtime) ? 1 : 0; }
    block
      when: System.compare-two-values(first-value=canAfford, ...)
```

**Group-level variables reset every tick.** A group-level `var` (non-static) is re-initialized to its `initialValue` at the start of each tick. If any `wait`, `wait-for-signal`, or async pattern occurs between setting and reading the variable, the value will have been reset. For computed boolean checks that need to survive a yield, use a **function-block** instead:

```text
function canAffordGame() -> number
  do: script { runtime.setReturnValue(data.canAffordGame(runtime) ? 1 : 0); }
```

Then reference the result as `Functions.canAffordGame` in conditions — no variable, no tick-reset risk.

**Static variables** (`isStatic: true`) persist across ticks and are safe to use across yields. Use `static` when the value must survive a wait.

## JSON Plugin Iteration

C3's JSON plugin `for-each(path="")` behaves differently depending on whether the data is an object or an array:

- **Object**: iterates property names. `CurrentKey` returns the property name, `CurrentValue` returns the value.
- **Array**: iterates elements. `CurrentKey` returns the string index (`"0"`, `"1"`, ...), `CurrentValue` returns the element. **Default Array values are `0` (number), not `""` (string).** When iterating an Array that may have unset entries (e.g., after `set-size` before populating), guard against both `0` and `""` — the error message for `RemoveAnimation` says `''` but the actual value is `0`.

When replacing a JSON file loaded via AJAX with a TypeScript constant, verify the replacement produces the same **data shape** (object vs array) — the downstream `for-each` loops depend on it.

**TypeScript scripting limitation**: `CurrentKey` and `CurrentValue` are C3 expressions — they work in C3 action/condition parameters but are **not accessible from TypeScript script actions** (no runtime API equivalent). To use iterator values in script, capture them into an event variable with `System.set-eventvar-value` before the script block:

```text
block
  when: MyJSON.for-each(path="items")
  var currentItem: string = ""
  block
    do: System.set-eventvar-value(variable=currentItem, value=MyJSON.CurrentValue)
    do: script { /* localVars.currentItem is now available */ }
```
