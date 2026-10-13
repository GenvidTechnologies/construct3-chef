---
type: decision-record
title: "0048. A failed MCP mutation reports what it may have written"
description: >-
  Amends ADR 0005. Each mutating MCP call carries a per-call WriteLedger
  marked before every write. On a non-cancel failure `recordFailedMutation`
  bumps the txId iff source or manifest may have been written, and marks
  `extracted/` stale iff source or generators may have run; a cancel still
  always does both ([#255](https://github.com/GenvidTechnologies/construct3-chef/issues/255))
tags: [decision, mcp, concurrency]
status: stable
generated: { by: process:tech-writer, at: 2026-10-13T00:00:00Z }
---

# 0048. A failed MCP mutation reports what it may have written

- **Status:** Accepted
- **Date:** 2026-10-13
- **Issues:** [#255](https://github.com/GenvidTechnologies/construct3-chef/issues/255) (a mutation that fails after a write leaves a valid txId and a "fresh" `extracted/`); the watcher gap that partly masks it is [#277](https://github.com/GenvidTechnologies/construct3-chef/issues/277), a separate defect.
- **Amends:** ADR [0005](0005-mcp-server-optimistic-concurrency-model.md). Builds on ADR [0047](0047-recipe-apply-computes-every-step-in-memory-then-writes.md).

## Context

Only `CancelledError` bumped the txId and set `extractedDirty`. Any other error thrown after a source write left the old token valid and `extracted/` reported fresh, so a client holding the pre-call token could apply against a project that had changed. On the apply path the real file watcher happens to mask part of this; that masking is #277 and the fix must not rely on it.

## Decision

- **A per-call `WriteLedger {source, manifest, extracted}`** (`src/mcp/writeLedger.ts`). Each flag is marked *before* the corresponding write, so it means "may have written", not "did write".
- **apply-recipe, the op tools and the workflow/layer tools** mark `source` through `ApplyOptions.beforeSourceWrite`, which fires only in ADR 0047's replay loop, once per write entry, before it lands.
- **The scaffold tools** (scaffold-layout, scaffold-sprite) mark `source` before their write function and `manifest` before `runSync`.
- **Every ledger-carrying handler that runs generators marks `extracted`** before they run (apply-recipe and the op tools, the workflow/layer tools, scaffold-layout; scaffold-sprite runs none). `regenerate` carries no ledger: see below.
- **`recordFailedMutation`** (`src/mcp/server.ts`) keeps cancel's unconditional bump and stale mark. For any other error it applies `failureEffects`: bump iff `source || manifest`; dirty iff `source || extracted`.
- **`regenerate`** marks dirty on any failure and never bumps (no source changed).
- **A refusal before any write** changes neither. Since ADR 0047 every recipe refusal falls in that case.

## Compromise

- **(a) Bump on any non-cancel error** — rejected: it stales every client's token on a pre-write refusal such as a typo'd layer name.
- **(b) One "entering the write phase" mark** — adequate for apply after ADR 0047, where only the replay writes, but the scaffold tools need per-step marks to tell a manifest-only failure apart from a source failure.
- **(c) Rely on the watcher** — rejected (#277).

## Consequences

- Over-reporting is conservative and accepted: a mark set before a write that then throws counts as written.
- A manifest-only failure bumps without staling `extracted/`, following the `project.c3proj` convention.
- Tests use the fake watcher, so they exercise the ledger and not the real watcher's masking.
- A new mutating tool that can fail after one of its writes must create a ledger, mark it before each write, and route its `onError` through `recordFailedMutation`. `sync-project` and `sync-addon-metadata` are outside the ledger for that reason: each writes only `project.c3proj`, as its last step, and bumps the txId after the write (the addon sync only when it reports `wrote`).
