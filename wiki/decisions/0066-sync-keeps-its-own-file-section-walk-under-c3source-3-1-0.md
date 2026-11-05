---
type: decision-record
title: "0066. sync keeps its own file-section walk under c3source 3.1.0 and adds the video section"
description: >-
  c3source 3.1.0 walks undeclared file subfolders and reports folder entries, which discharges the two reasons ADR 0065 gave for not consuming upstream file drift. `runSync` still declines it: extension filters are section membership (ADR 0016 mismatch 3), and the new walks follow links, so a loop throws `ELOOP` and a dangling link throws `ENOENT`. `runSync` hides `rootFileFolders` from `detectManifestDrift`, classifies editor-local names at every depth in every file section, and syncs a `video` section
  ([#358](https://github.com/GenvidTechnologies/construct3-chef/issues/358))
tags: [decision, sync, architecture]
status: stable
generated: { by: process:tech-writer, at: 2026-11-02T00:00:00Z }
---

# 0066. sync keeps its own file-section walk under c3source 3.1.0 and adds the video section

- **Status:** Accepted. Superseded in part by ADR [0069](0069-file-section-admission-follows-the-editors-rescan-rule.md) (see Amendment, 2026-11-05).
- **Date:** 2026-11-02
- **Issues:** [#358](https://github.com/GenvidTechnologies/construct3-chef/issues/358). Upstream: [c3source#110](https://github.com/GenvidTechnologies/c3source/issues/110) (shipped in 3.1.0), [c3source#113](https://github.com/GenvidTechnologies/c3source/issues/113) (video facts), [c3source#114](https://github.com/GenvidTechnologies/c3source/issues/114) (link-safe drift walks).
- **Relates to:** ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) (upstream ownership), ADR [0016](0016-shared-file-walk-adoption-triage.md) (§2, the `readDiskDir` decline), ADR [0018](0018-editor-local-writes-are-not-source-changes.md) and ADR [0019](0019-two-walk-primitives-one-classification-rule.md) (one editor-local rule), ADR [0021](0021-section-item-axis-does-not-reopen-walk-declines.md) (a decline record that does not reopen), ADR [0024](0024-project-c3proj-shared-serializer.md) (the write serializes the manifest object), ADR [0065](0065-sync-withholds-removals-unless-pruning-is-requested.md) (removals are withheld).

## Context

c3source 3.1.0 ([c3source#110](https://github.com/GenvidTechnologies/c3source/issues/110)) makes `detectManifestDrift` walk undeclared file subfolders. It also reports folder entries (`folder-untracked`, `folder-missing`) for file sections. These were the two reasons ADR 0065 gave for not consuming upstream file-section drift, so 3.1.0 discharges both.

ADR 0016 §2 gave a third mismatch: the extension filters (`.ts`, `.webm`, `.ttf`, `.png` when ADR 0016 was written) are manifest-section membership, and upstream has no opinion on membership. 3.1.0 does not change that.

3.1.0 adds a new failure class. Its file-section walks use `statSync`, which follows links. Measured on Windows junctions: a loop under an undeclared file subfolder throws `ELOOP`, and a dangling junction throws `ENOENT`. On 3.0.0 both passed. `runSync` called `detectManifestDrift` for every `validate-project`, `sync-project`, `scaffold-layout` and `scaffold-sprite` run, on the CLI and on MCP, and discarded the file sections. After the bump, all of those callers would throw on a link under a file folder.

## Decision

Option A is chosen. 3.1.0 discharges ADR 0065's two reasons. It does not discharge ADR 0016 mismatch 3 (membership), and adopting upstream file drift would import a new failure class: link-following throws on every `runSync` caller.

### Option A: keep chef's walk, skip upstream's file-section walks, and align editor-local classification (recommended)

1. **`runSync` hides `rootFileFolders` from `detectManifestDrift`.** It passes a view of the manifest without that key (`nameView`), so upstream's file-section walks do not run. Name-section drift is unchanged. The write still serializes the manifest object itself (ADR 0024); the view is read-only. The view relies on c3source's `if (rff)` check in the drift loop. The test `I358-R2:` is the tripwire for one failure of that reliance: it goes red if upstream walks file folders regardless and the walk throws on its link loop. A file-folder walk that does not throw stays invisible, because chef discards its result.
   - Variants weighed. *Guard file sections only* (chosen). *Guard name sections too*: not available locally, because the only local mechanism is a try/catch around the whole call, which would hide real name-section failures. *Accept and record*: rejected, because the guard is two lines and removes the throw and the discarded walk together.
   - Side effect: `ManifestDrift.duplicates` no longer carries file-section entries in chef's runs ([#344](https://github.com/GenvidTechnologies/construct3-chef/issues/344)).
2. **Editor-local classification applies at every depth, on both sides, in every file section.** The disk side and the manifest side both go through `src/c3/editorLocal.ts` (`hasEditorLocalSegment`). A declared entry or subfolder with an editor-local name is inert while the folder that holds it stays: sync never adds, removes or moves it. The maintainer chose this over filtering the disk side only, which would turn such an entry into a permanent withheld removal and fail `validate-project`.
   - This is a deliberate behaviour change. It reverses ADR 0016 §2's stance that `sync-project`'s output must not change inside a refactor PR. `readDiskDir` keeps its signature and its filters.
   - Edge cases. A manifest item whose only disk copy is under an editor-local folder was a withheld move and is now a withheld removal. When an ordinary subfolder is missing on disk, sync reports every entry inside it, editor-local ones included, as a withheld removal, and a prune removes them with the folder.
   - Real-project impact is not measured. Whether C3 writes `uistate` files under file folders is unverified.
3. **A `video` file section is added.** `FILE_SECTIONS` gains `video`: `C3_ROOT_FILE_FOLDERS.video` (`videos`), info key `file-info`, extensions `.webm` and `.mp4`. The maintainer chose to add it now, with c3source's current answers, over the alternative of splitting it out until an editor-saved project attests the section.
   - Types come from c3source's `fileTypeForName` with no local override. A video `.webm` is therefore registered as `audio/webm; codecs=opus`.
   - Upstream marks the folder name as INFERRED. The `file-info` key is unattested for video.
   - All three are requested upstream in c3source#113.
4. **A junction loop under a name-section folder still throws `ELOOP`.** It did on 3.0.0 too. This is accepted and pinned by `I358-R4:`. chef cannot guard it locally; link-safe drift walks are requested upstream in [c3source#114](https://github.com/GenvidTechnologies/c3source/issues/114).

### Option B: adopt upstream `rootFileFolders` drift and deprecate the local walk (alternative)

`runSync` would read the `rootFileFolders` sections from the full `detectManifestDrift` call. A new apply engine would turn `untracked`, `moved`, `missing`, `folder-untracked` and `folder-missing` entries into manifest edits. An extension post-filter would keep membership.

## Alternatives considered

- **Chosen: Option A** (above).
- **Rejected: Option B.** It needs a second apply engine that re-derives what `syncFileFolder` already does, plus output churn. Line order would follow upstream's sort. Links would be followed, so the throw could not be guarded locally. `video` would arrive with the audio-type defect. It would also decide [#354](https://github.com/GenvidTechnologies/construct3-chef/issues/354) (membership) as a side effect.
- **What would reopen B:** c3source tolerating links, plus a #354 decision on membership.

## Consequences

- Every full sync or validate report gains a `[video]` line. A manifest without `rootFileFolders.video` logs a warning.
- On the canonical fixture, the `validate-project` output is otherwise unchanged.
- The change is not breaking.
- #354 stays open and unchanged. Adopting upstream drift would have decided it.
- [#349](https://github.com/GenvidTechnologies/construct3-chef/issues/349) is unchanged.
- A name-section link loop still fails the run with one `Error:` line on the CLI and `isError` on MCP.
- When c3source tolerates links ([c3source#114](https://github.com/GenvidTechnologies/c3source/issues/114)) or changes the `if (rff)` check, update this record and the ledger entry for 3.1.0.
- When c3source attests the video section ([c3source#113](https://github.com/GenvidTechnologies/c3source/issues/113)), update the `video` entry, the test `I358-V1:` and this record together. *(Done: see the Amendment.)*

## Amendment (2026-11-05): superseded in part by ADR 0069

The decisions above are kept as written. This amendment records what the c3source 4.0.0 and mcp-utils 0.13.0 adoption ([#374](https://github.com/GenvidTechnologies/construct3-chef/issues/374), [#299](https://github.com/GenvidTechnologies/construct3-chef/issues/299)) changed. The new decision is ADR [0069](0069-file-section-admission-follows-the-editors-rescan-rule.md).

- **The link reason is discharged.** c3source 4.0.0 ships link-safe drift walks ([c3source#114](https://github.com/GenvidTechnologies/c3source/issues/114)) and reports skipped links in `ManifestDrift.links`. Decision 4 and the Consequences line about a name-section link loop no longer describe 4.0.0. Chef reports the skipped links in ADR [0070](0070-validate-reports-duplicate-names-and-skipped-links.md).
- **The video facts are attested.** [c3source#113](https://github.com/GenvidTechnologies/c3source/issues/113) shipped them in 4.0.0, from an r506.3 editor save. New items take their type from `fileTypeForSection`, and decision 3's statement that upstream marks the folder name as INFERRED no longer holds.
- **Option B is weighed again and declined again, for new reasons.** The link reason is gone. The cost reason is new: consuming upstream file-section drift needs a post-filter, a re-pairing step, a second apply engine and a reordered report, for no behaviour that keeping chef's walk lacks. Chef's walk stays, and `runSync` now passes `skipFileSections` to `detectManifestDrift` instead of hiding `rootFileFolders` with `nameView`.
- **"Extension filters are section membership" was wrong on both editor rules.** On load, every listed file is a member, with no extension check. On rescan, the editor admits an unlisted file by its section's category rule, not by an extension list. The extension filters therefore hid listed files, which is [#354](https://github.com/GenvidTechnologies/construct3-chef/issues/354). ADR 0069 replaces them with the editor's rescan rule and records the editor trace that settles #354.
- **Unchanged.** Editor-local classification at every depth (decision 2), the withheld removals of ADR 0065, and the `video` section itself.
