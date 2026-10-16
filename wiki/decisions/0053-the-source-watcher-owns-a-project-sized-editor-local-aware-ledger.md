---
type: decision-record
title: "0053. The source watcher owns a project-sized, editor-local-aware ObservedState ledger"
description: >-
  Amends ADR 0050. With mcp-utils 0.12.0, directory events are markers and the
  watcher primes a content baseline at start, but only while its ledger holds the
  whole baseline. Each project context now builds its own ledger sized
  max(10 000, 4 x watched entries), fingerprints editor-local paths as absent,
  routes the baseline log lines to stderr and the MCP log, and starts before the
  start-up read of the tree; rejects a fixed capacity, a bare multiple, a null
  ledger, a stat-based fingerprinter and expect() on directories
  ([#296](https://github.com/GenvidTechnologies/construct3-chef/issues/296))
tags: [decision, mcp, concurrency]
status: stable
generated: { by: process:tech-writer, at: 2026-10-16T00:00:00Z }
---

# 0053. The source watcher owns a project-sized, editor-local-aware ObservedState ledger

- **Status:** Accepted
- **Date:** 2026-10-16
- **Issues:** [#296](https://github.com/GenvidTechnologies/construct3-chef/issues/296) (canonical: adopt mcp-utils 0.12), [#284](https://github.com/GenvidTechnologies/construct3-chef/issues/284) (a directory event alone moved the txId), [#290](https://github.com/GenvidTechnologies/construct3-chef/issues/290) (a first read of a long-unread file moved the txId on Windows)
- **Amends:** ADR [0050](0050-self-written-watched-paths-are-registered-before-the-write.md), whose "still open" directory-event and read-induced-event items this closes. Builds on ADR [0018](0018-editor-local-writes-are-not-source-changes.md) and ADR [0019](0019-two-walk-primitives-one-classification-rule.md) (the editor-local classification rule).
- **Upstream:** GenvidTechnologies/mcp-utils#27, #29 and #33.

## Context

`@genvidtech/mcp-utils` 0.12.0 classifies directory events as markers (not changes) and primes a content baseline in its `ObservedState` ledger at `start()`. That fixes #284 and #290, but only while the ledger holds the whole baseline: an entry evicted from a full ledger makes it lossy, and a lossy ledger judges unknown paths changed.

The ledger's default capacity is 1000 entries. A real project is larger: burbank is about 2.7k files and directories. Capacity is an `ObservedState` constructor option only, so chef has to construct the ledger itself to size it.

Two further facts shaped the work:

- The baseline walk counts editor-local content (`uistate/`, `ts-defs/`, `*.uistate.json`), which the watcher's filtering factory otherwise hides from events. Left alone, those entries consume capacity and an atomic save or delete of one still reads as a change.
- `start()` primes before `server.connect()`, and `emitLog` drops everything until the connection exists, so the library's baseline summary and incomplete-baseline warnings would be silent.

## Decision

1. **Each project context gets its own ledger, built inside `createSourceWatcher`.** Its capacity is `max(LEDGER_FLOOR = 10_000, LEDGER_HEADROOM = 4 x countWatchedEntries(...))`. The count mirrors what `prime()` records: files and subdirectories at any depth, editor-local content included, symlinked directories not descended, plus one for `project.c3proj`. Capacity is an eviction cap, not a preallocation, so the floor costs nothing on small projects.
2. **An editor-local-aware fingerprinter, `editorLocalAwareFingerprint`.** It returns `"absent"` for any path `isEditorLocalPathUnder` classifies as editor-local (the same predicate `filteringFactory` uses) and delegates to `contentFingerprint` byte-for-byte otherwise. An atomic save or a delete of an existing editor-local file in a source subfolder is therefore not a change, and editor-local entries never flip the ledger lossy on eviction.
3. **Baseline logging.** `setupWatchers` passes a logger that routes only the baseline summary (info) and the incomplete or failed lines (warning) through `routeWatcherLog`, to stderr and to `emitLog`. Never stdout, which is the MCP stdio transport.
4. **Start before reading.** `startServer` wires the watchers before the start-up auto-generation reads the source tree, so a write landing in between cannot be absorbed into the primed baseline unreported.

## Compromise

The design labels below are kept verbatim.

**Capacity**

- **C: "max(floor, count × factor)" (chosen).** Scales with the project and never goes below a size that suits small ones.
- **A: "fixed constant (e.g. 50 000)" (rejected).** A project over the cap is lossy at start: the watcher logs an incomplete baseline and falls back to extra bumps.
- **B: "count × factor" (rejected).** Too small on tiny projects: 396 entries for the 99-entry fixture, which leaves little room for growth.

Measured on a synthetic tree of 2466 files of about 13 KB and 269 subdirectories (2736 entries), three runs on Windows. These are synthetic figures, not a profile of a real project:

| | min | median | max |
|---|---|---|---|
| `countWatchedEntries` | 40.5 ms | 76.6 ms | 91.0 ms |
| `start()` including prime | 648 ms | 930 ms | 4057 ms (one outlier) |

**Editor-local content**

- **"close the edit/delete half now" (chosen).** The fingerprinter above.
- **"document + follow-ups only" (rejected).** Atomic saves and deletes of editor-local files would keep bumping the txId.

This is not the declined stat-based `Fingerprinter` (the 0.7.0 entry in [leaf-dependency-ledger](../process/leaf-dependency-ledger.md)). That one compared equal on different source content, so Layer 3 could suppress a real change. This one never changes how a source path is fingerprinted: it only maps paths already classified editor-local to `"absent"`. It does couple to `"absent"` being `contentFingerprint`'s documented value for ENOENT; the MU12-D10 test catches a semantic change there.

**Declined**

- **A null ledger (`observed: null`).** It forfeits the #284 and #290 fixes.
- **A stat-based fingerprinter.** Staleness, as above.
- **`expect()` on parent or new directories to hide the self-create +1.** Consuming a directory's expectation re-records its siblings and could absorb a concurrent external edit. Staleness is the one failure this server does not tolerate.
- **Calling `prime()` before `start()`.** Upstream warns of a window in which a write is never reported.

## Consequences

- **Self-writes.** A self-write that creates a file in a new subfolder costs one extra bump and marks `extracted/` dirty when the directory's event is handled first. This is accepted, and MU12-S2 pins it. Real `fs.watch` on Windows (MU12-R2) gave settled deltas of [0, 0, 1] for a root-level create, an existing-subfolder create and a new-subfolder create, stable over three runs.
- **In-place edits** cost nothing once directory stamps are trusted, meaning more than 1 s old (MU12-S3). Within 1 s of a structural change they can cost +1 (MU12-S4).
- **Editor-local creates.** A newly created editor-local file in a source subfolder still bumps (MU12-D11), because `ObservedState` judges a never-seen path changed before any fingerprint is compared. Requested upstream as GenvidTechnologies/mcp-utils#35; chef's adoption is tracked in [#299](https://github.com/GenvidTechnologies/construct3-chef/issues/299).
- **`extractedDir` overlap.** An `extractedDir` configured inside a watched source directory is unsupported: regenerate's writes would bump and mark dirty, and would enter the baseline. Tracked in [#298](https://github.com/GenvidTechnologies/construct3-chef/issues/298).
- **Layer 1 masking.** A directory event during a `suppress()` window re-records that directory's children, so a concurrent external edit to a sibling can be absorbed. Upstream accepts this (mcp-utils ADR-0008); only the mtime freshness backstop catches it.
- **Start-up cost** is one synchronous walk-and-hash per project, run sequentially before connect.
- **Test vacuity found by revert-confirm.** After the bump, the #277 self-write test W3 seeded its layer outside the primed baseline, so it guarded nothing: a mutation disabling both registration sites left it green. W3 now seeds into the ledger. The lesson is that an upstream baseline can silently make a self-write test vacuous, so revert-confirm such tests after any watcher bump.
