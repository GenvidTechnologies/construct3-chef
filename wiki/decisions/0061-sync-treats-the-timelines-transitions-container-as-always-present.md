---
type: decision-record
title: "0061. sync treats the timelines transitions container as always present"
description: >-
  `sync-project`'s apply step resolves drift paths the way c3source's manifest
  walk produces them (the nameless direct child of the timelines root is the
  `transitions` segment), throws on a drift entry it cannot resolve, and
  writes `project.c3proj` only when the synced bytes change, reporting that as
  `SyncResult.wrote`. A temporary local bridge dropped upstream's
  `folder-missing ["transitions"]` entry because C3 saves that container on
  every save; it was retired when c3source 3.0.0 shipped c3source#97 (#343)
  ([#310](https://github.com/GenvidTechnologies/construct3-chef/issues/310))
tags: [decision, sync, timelines, upstream]
status: stable
generated: { by: process:tech-writer, at: 2026-10-27T00:00:00Z }
---

# 0061. sync treats the timelines transitions container as always present

- **Status:** Accepted
- **Date:** 2026-10-27
- **Issues:** [#310](https://github.com/GenvidTechnologies/construct3-chef/issues/310). Upstream request: [c3source#97](https://github.com/GenvidTechnologies/c3source/issues/97).
- **Supersedes:** the description of `sync-project`'s MCP bump as unconditional in ADR [0017](0017-sync-addon-metadata-separate-mutation-command.md), and ADR [0048](0048-a-failed-mcp-mutation-reports-what-it-may-have-written.md)'s statement that `sync-project` bumps the txId after the write (it now bumps only when it reports `wrote`).
- **Relates to:** ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md), ADR [0023](0023-stray-files-are-a-detection-only-report.md), ADR [0030](0030-c3-source-json-written-without-a-trailing-newline.md), ADR [0048](0048-a-failed-mcp-mutation-reports-what-it-may-have-written.md).

## Context

The C3 editor saves the timelines root with a nameless direct subfolder (the `transitions` container) on every save, even with no transitions and no `timelines/transitions/` directory. Evidence: all 15 commits of `sample/project.c3proj` in GenvidTechnologies/c3addon-gcore-video-plugin (`savedWithRelease` 39700, 39702, 40702 and 47604, i.e. r397, r407 and r476) hold `{"items":["Timeline"],"subfolders":[{"items":[],"subfolders":[]}]}` with only `Timeline.json` under `sample/timelines/`. Git cannot track an empty directory either, so a checkout cannot carry the directory.

Upstream's drift report names that container as `folder-missing ["transitions"]`, so `validate-project` reported permanent `- transitions/` drift on an editor-saved project. Sync's apply step then made it worse, because it did not resolve paths the way upstream's manifest walk produces them:

- an untracked ease wrote a second `{"name":"transitions"}` subfolder next to the nameless container (the c3source#28 corruption);
- a missing ease inside the container was silently dropped, so validate was falsely clean;
- a move into or out of the container duplicated the item;
- nested folders under the container never converged;
- nameless subfolders in other sections never converged.

Separately, `runSync` wrote `project.c3proj` and logged `Updated` on every successful call, and the MCP `sync-project` handler bumped the `txId` unconditionally. A phantom change therefore rewrote the file and invalidated every other client's token for a file whose content had not changed.

## Decision

**Option A (recommended): honest apply engine, bridge in `runSync`, byte guard, `SyncResult.wrote`.** It has six parts.

1. **Resolver.** In `src/c3/projectSync.ts`, `segmentOf`, `withTransparent`, `foldersAt` and `ensureFolder` resolve a drift path the way c3source's walk produces it. The nameless direct child of the timelines root is the `transitions` segment (`TIMELINE_TRANSITIONS_FOLDER`); other nameless subfolders are transparent. A missing container is created nameless at index 0, never as a folder named `transitions`. Removals resolve in dry-run too, so `validate-project` and `sync-project` agree.
2. **`applyNameDrift` throws** `sync: cannot apply <kind> drift for <section> "<name>"` for an entry it cannot resolve. It used to record a phantom change or drop the entry. It is a barrel-exported function, so this is a behaviour change on invalid input.
3. **Bridge.** `isTransitionsContainerFolderMissing` (module-private, in `runSync`) drops upstream's `folder-missing ["transitions"]` entry when the timelines root has the nameless container, whatever it holds ("container always present"). The predicate is not "empty only": a non-empty container with no directory would still report `- transitions/`, which the fixed engine would then delete and C3 would add back on the next save.
   *(Superseded in part: the bridge was retired when c3source 3.0.0 shipped c3source#97, in [#343](https://github.com/GenvidTechnologies/construct3-chef/issues/343). `isTransitionsContainerFolderMissing`, its `runSync` call and `I310-T1` are deleted; decisions 1, 2 and the rest stand.)*
4. **Write guard.** `runSync` writes `project.c3proj`, logs `Updated` and calls `beforeWrite` only when the serialized manifest differs from the serialization taken right after parsing. The comparison is against the parsed object, not the raw file, so a phantom change never reformats a non-canonical file (CRLF, a trailing newline; see ADR 0030 for the no-trailing-newline convention).
5. **`SyncResult.wrote: boolean`**, an additive public-API field, true iff the call wrote `project.c3proj`.
6. **MCP `sync-project` bumps the `txId` only when `wrote`**, the rule `sync-addon-metadata` already follows. `scaffold-layout` and `scaffold-sprite` are unchanged, since they always write source first. This replaces ADR 0017's description of `sync-project` as bumping unconditionally.

## Alternatives considered

- **Option A (recommended): honest apply engine, bridge in `runSync`, byte guard, `SyncResult.wrote`** (CHOSEN).
- **Option B (alternative): bridge inside `applyNameDrift`.** Rejected: it mixes interpretation of upstream's detection into a pure apply engine, and retiring the bridge would then mean editing the engine.
- **Wait for upstream.** Rejected by the user. ADR 0006's default is request-and-wait; this is a deliberate, recorded deviation, and the bridge's retirement is mechanised by a tripwire test (below). The upstream request is c3source#97.
- **Converge by deletion** (remove the empty container from the manifest). Rejected: sync and the editor would rewrite each other's change on every save, since gcore shows 15 of 15 commits saving the empty container.
- **Keep `SyncResult` as it is and have the MCP handler set a flag inside the `beforeWrite` hook.** Rejected: it makes `wrote` implicit in the hook's contract, which is the invariant this bug broke. ADR 0023 weighed widening `SyncResult` as a cost and did not forbid it; here the field is one boolean and the alternative is worse.

## Consequences

- **The bridge is temporary.** The tripwire test `I310-T1` goes red when c3source ships the rule. Retirement: delete `isTransitionsContainerFolderMissing`, its call in `runSync` and `I310-T1`, then revert-confirm that the `I310` convergence tests (`I310-R1`, `I310-R2`, `I310-C1`) stay green on upstream's rule alone (CLAUDE.md § Leaf dependencies). The resolver stays: it is chef's apply step, not the bridge. The pending check is recorded in `wiki/process/leaf-dependency-ledger.md`. *(Done in [#343](https://github.com/GenvidTechnologies/construct3-chef/issues/343): see the superseded-in-part note under decision 3 and the ledger's 3.0.0 entry.)*
- **Public-API changes.** `SyncResult.wrote` is additive. `applyNameDrift` throwing on an unresolvable entry is a behaviour change for callers of the barrel-exported function that passed such an entry.
- **A no-op sync is now a no-op.** It leaves the file's bytes alone, logs no `Updated` line, and leaves the MCP `txId` unchanged. A client that relied on `sync-project` always advancing the token no longer gets that.
- **Nameless subfolders outside timelines are covered too,** by the same transparent-segment rule.
- **A duplicated container is collapsed to one.** Upstream emits one `folder-missing ["transitions"]` entry per nameless timelines root child, and the bridge drops only one. A manifest with two such containers and no directory therefore loses the second on sync, leaving the single container C3 itself saves, after which validate is clean. This is not the rejected "converge by deletion": the container C3 writes survives. *(No longer holds since [#343](https://github.com/GenvidTechnologies/construct3-chef/issues/343): c3source 3.0.0 treats every nameless timelines root child as the container and emits no `folder-missing` for any of them, so sync leaves a duplicated container in place and validate reports it clean. Accepted rather than re-bridged; detection belongs with the corrupted-manifest work in [#333](https://github.com/GenvidTechnologies/construct3-chef/issues/333).)*
- **Out of scope: an already-corrupted manifest is not repaired.** A manifest an earlier sync corrupted (an empty nameless container plus a `{name:"transitions",items:[…]}` sibling, with the directory present) shows no drift upstream, so nothing detects or repairs it. That is tracked as a follow-up, not handled here.
- **Failure bookkeeping is unchanged.** `sync-project` writes only `project.c3proj`, as its last step, so ADR 0048's ledger is still not needed for it.
