---
type: decision-record
title: "0050. Self-written watched paths are registered before the write"
description: >-
  Amends ADRs 0005 and 0017. Every watched path an MCP mutation call writes is
  registered with `watcher.expect()` immediately before its write through one
  per-call tracker (`suppressSelfWrites`), and all registrations are refreshed
  in a `finally` at the end of the call, because `suppress()` never catches the
  events of synchronous writes; rejects a batch pre-registration, server-side
  after-the-fact registration, and a longer or fingerprint-sealed TTL
  ([#277](https://github.com/GenvidTechnologies/construct3-chef/issues/277))
tags: [decision, mcp, concurrency]
status: stable
generated: { by: process:tech-writer, at: 2026-10-14T00:00:00Z }
---

# 0050. Self-written watched paths are registered before the write

- **Status:** Accepted
- **Date:** 2026-10-14
- **Issues:** [#277](https://github.com/GenvidTechnologies/construct3-chef/issues/277) (MCP mutation tools move their own returned txId and mark `extracted/` stale)
- **Amends:** ADR [0005](0005-mcp-server-optimistic-concurrency-model.md) (the watcher suppress/expect mechanics) and ADR [0017](0017-sync-addon-metadata-separate-mutation-command.md) (its recorded "No `watcher.expect()` call" for `sync-addon-metadata`). Consistent with ADR [0048](0048-a-failed-mcp-mutation-reports-what-it-may-have-written.md), whose write ledger it complements.

## Context

Mutating MCP tools wrapped their writes in `watcher.suppress(async () => { ... })` and treated that as enough to keep the server's own writes from looking like external edits. It is not. `@genvidtech/mcp-utils` 0.10.0's `OptimisticWatcher` handles an `fs.watch` event in three layers:

1. `suppress(fn)` is a depth counter (incremented, then decremented in a `finally`), with no time window. An event that arrives while the depth is above zero is dropped.
2. `expected.consume(path)`: an event for a path registered with `expect()` is dropped. Registration is one-shot, and `ExpectedChanges` expires an entry 5000 ms after `add()`.
3. `observedState.isChanged`: a fingerprint comparison. A changed path bumps the `txId` and fires `onExternalChange`.

Chef's writes are synchronous, so their `fs.watch` events arrive after `suppress()` has returned. Layer 1 never catches them; only a prior `expect()` does. Measured on Windows with a real `fs.watch`:

- a flat file write under `suppress()` alone moved the `txId` by +1 about 1.5 s later; the same write with `expect()` called first moved it by 0;
- a write inside a subfolder with `expect()` still moved it by +1, because the parent directory's event is not the registered path (issue [#284](https://github.com/GenvidTechnologies/construct3-chef/issues/284));
- `project.c3proj` under `suppress()` alone bumped the `txId` (without marking `extracted/` stale); with `expect()` it did not;
- TTL: registering before the write and then doing 1.5 s of synchronous work, with a 1 s TTL, let the entry expire and the event bumped; re-registering at the end of the work gave 0;
- masking: if a suppress body yields a macrotask after a write, the event is consumed at Layer 1 without consuming the `expect()` entry, and that entry then masks a genuine external edit 300 ms later.

The visible effect was that a client which sent the `txId` returned by one mutation to the next could be rejected for a change it made itself, and `extracted/` was reported stale after a successful call that had regenerated it. Only the scaffold tools registered paths, and `sync-addon-metadata` deliberately did not (ADR 0017).

## Decision

**Every watched path a tool call writes is registered with `expect()` immediately before its write, through one per-call tracker.**

- New off-barrel module `src/mcp/selfWrites.ts`. `suppressSelfWrites(watcher, fn)` runs `fn(sw)` inside `watcher.suppress`. `sw.before(absPath)` calls `expect(absPath)` and remembers the path. `sw.refresh()` re-registers every remembered path, and runs in a `finally` at the end of the call so a registration made early in a long call (generators have no upper bound on run time) does not expire before its event arrives.
- The library write sites take the absolute path to the hook. `ApplyOptions.beforeSourceWrite(absPath)` was nullary; it is unreleased since 2.0.0, so widening it is not a break. `runSync(root, dryRun, log, section?, { beforeWrite? })` and `syncAddonMetadata`'s options gain an optional `beforeWrite`. Each fires immediately before the write and only when it actually writes.
- All MCP mutation handlers use `suppressSelfWrites`: `apply-recipe` and the op tools, the workflow and layer tools, `sync-project`, `sync-addon-metadata`, `scaffold-layout` and `scaffold-sprite`. `regenerate` keeps plain `suppress()`, since it writes only `extracted/`, which is unwatched.

Like ADR 0048's write ledger, which is marked before each write, the registration happens before each write, so a write that throws partway has still registered every path it may have touched (the "register before the write" requirement, labelled R3 in the design and first applied to `scaffold-sprite` in [#259](https://github.com/GenvidTechnologies/construct3-chef/issues/259)).

## Compromise

The design labels below are kept verbatim. "R3" is that register-before-the-write requirement. "P3" is the accepted masking risk described under Consequences.

- **Option A, with TTL option T2 (chosen): "widen the per-write hooks, and route them through one per-call tracker", with TTL handling "refresh in `finally`".**
- **Option B (rejected): "register everything in one batch before the replay".** "If a write throws, paths later in the journal were registered but never written. Each one masks a real edit for the TTL ... The addon pre-pass needs a second copy of applyAddonMetadataSync's 'mutated' condition ... runSync would also do its work twice."
- **Option C (rejected): "register after the fact on the server side, with no library change".** "It violates R3 / #259 (register before the write) ... When a write throws, there is no return value, so paths already written stay unregistered."
- **T1 (rejected): "raise the TTL at projectContext.ts:88".** "Generator time has no upper bound, so no constant is safe. It also widens every masking window twelvefold."
- **T3 (rejected): "seal the content by injecting ObservedState and calling record() at the end of the call".** "adds a ctx field, a new createSourceWatcher option and a fingerprint re-read, and P3 already accepts the masking risk."
- **Filtering editor-local paths in `before()` (rejected as unnecessary).** An unconsumed entry for an editor-local path is harmless: `createSourceWatcher`'s filtering factory drops those events before the watcher sees them, and the 30 s `purgeExpired` interval removes the entry.

## Consequences

- A successful mutation call no longer moves its own returned `txId` or marks `extracted/` stale because of its own writes.
- **Accepted masking risk (P3).** An unconsumed registration can mask the first genuine external edit to that path for up to the 5 s TTL after the call. Because the refresh in `finally` restarts the TTL when the call ends, the window runs from the write until up to 5 s after the call returns.
- **Still open, not fixed here.** Directory events: a write in a subfolder fires an event for the parent directory, which is not a registered path ([#284](https://github.com/GenvidTechnologies/construct3-chef/issues/284), blocked on GenvidTechnologies/mcp-utils#27). Read-induced file events: with last-access updates enabled, a first read of a file whose atime is over an hour old fires a `change` event that Layer 3 counts as changed ([#290](https://github.com/GenvidTechnologies/construct3-chef/issues/290)).
  **Amended by ADR [0053](0053-the-source-watcher-owns-a-project-sized-editor-local-aware-ledger.md) (2026-10-16):** the directory-event and read-induced items above were closed by adopting mcp-utils 0.12.0 ([#296](https://github.com/GenvidTechnologies/construct3-chef/issues/296)).
- `sync-addon-metadata` now registers `project.c3proj` before its write, reversing ADR 0017's "No `watcher.expect()` call". Its test T24 was rewritten to expect the registration.
- `beforeSourceWrite` changes signature before it ships in a release. `runSync` and `syncAddonMetadata` gain additive optional options.
- A new mutation handler must go through `suppressSelfWrites` and call `sw.before(absPath)` before each watched write; the rule is stated in [mcp-architecture.md](../architecture/mcp-architecture.md).
