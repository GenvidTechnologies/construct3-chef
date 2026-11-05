---
type: decision-record
title: "0069. File-section admission follows the editor's rescan rule"
description: >-
  sync keeps its own lockstep walk of the file sections (c3source 4.0.0 / Option B-2). A disk file takes part in
  classification when the manifest lists it, or when the C3 editor's rescan rule would add it. The rule is a local
  bridge, `src/c3/fileAdmission.ts`, with the tripwire DB4-T1 and the upstream request c3source#130. It replaces the
  per-section extension filters of ADR 0066, which treated an extension list as section membership. The editor
  trace that settles #354 is recorded, with its bundle hashes and offsets
  ([#354](https://github.com/GenvidTechnologies/construct3-chef/issues/354))
tags: [decision, sync, architecture, upstream]
status: stable
generated: { by: process:tech-writer, at: 2026-11-05T00:00:00Z }
---

# 0069. File-section admission follows the editor's rescan rule

- **Status:** Accepted
- **Date:** 2026-11-05
- **Issues:** [#354](https://github.com/GenvidTechnologies/construct3-chef/issues/354) (file-section membership). Dependency adoption: [#374](https://github.com/GenvidTechnologies/construct3-chef/issues/374) (c3source 4.0.0), [#299](https://github.com/GenvidTechnologies/construct3-chef/issues/299) (mcp-utils 0.13.0). Upstream: [c3source#130](https://github.com/GenvidTechnologies/c3source/issues/130) (an admission predicate), [c3source#113](https://github.com/GenvidTechnologies/c3source/issues/113) (video facts), [c3source#114](https://github.com/GenvidTechnologies/c3source/issues/114) (link-safe drift walks). Follow-up: [#375](https://github.com/GenvidTechnologies/construct3-chef/issues/375) (link divergence).
- **Supersedes in part:** ADR [0066](0066-sync-keeps-its-own-file-section-walk-under-c3source-3-1-0.md), whose claim that an extension filter is section membership does not hold. See that record's amendment.
- **Relates to:** ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) (the "user chooses not to wait" bridge), ADR [0016](0016-shared-file-walk-adoption-triage.md) (mismatch 1, empty directories), ADR [0018](0018-editor-local-writes-are-not-source-changes.md) (editor-local classification), ADR [0061](0061-sync-treats-the-timelines-transitions-container-as-always-present.md) (bridge with tripwire precedent), ADR [0065](0065-sync-withholds-removals-unless-pruning-is-requested.md) (removals stay withheld).

## Context

ADR 0066 kept chef's own walk of the `rootFileFolders` sections. It gave one reason that survived the c3source 3.1.0 bump: the per-section extension filters (`.ts`, `.webm`, `.ttf`, `.png`) decide which disk files belong to a section, and upstream has no opinion on that. It left [#354](https://github.com/GenvidTechnologies/construct3-chef/issues/354) open: what does the editor itself treat as a member?

With c3source 4.0.0 and mcp-utils 0.13.0 adopted, that question was settled from the editor bundle. The bundle files were read and never run.

**Observed in the editor bundle r495 (`editor.construct.net/r495/`)**

- `projectResources.js` has SHA-256 `fd5f971408a019098d72edf97200ff462df593ccdd337d37c62f141ed195b0f7`. `main.js` has SHA-256 `17cb8bb085a004e70d7177e6acbda4030515d60a89270e680d4ad43ce3c87f95`. Both equal the hashes in the c3source capture `raw/issue-115-mime-registry-r506-3-and-type-paths-2026-11-04.md`.
- **On load, every listed file is read, with no extension check.** A file the manifest lists is a member of its section.
- **On rescan, the editor admits an unlisted file by category.** The rescan loop is the function `l5e` in `projectResources.js`, near offset 302472. The checks run in this order:
  1. The name check `nsi` (`main.js`, near offset 84014).
  2. The reserved names, only where the folder prefix `ELt()` is `""`. The root folder's `ELt()` (near offset 299221) returns `i5e(section)`, which is `""` only for `general`. A subfolder's (near offset 5379) is its parent's prefix plus its own name. So the 17 reserved names apply only directly under `files/`.
  3. The per-section switch: `script` admits `.js` unless a `.ts` twin is registered; `general` admits any extension with the same `.js` twin rule; `sound`, `music`, `video` and `icon` admit by the registry type category (`audio`, `audio`, `video`, `image`); `font` tests a registry font flag (`MimeType.ILt()`).
- Unlisted folders are admitted when the name check holds. `ts-defs` at the script section root is skipped.

**Observed, not generalised.** Only `video` admission is observed in a real editor save (editor r506.3, [c3source#113](https://github.com/GenvidTechnologies/c3source/issues/113)). Every other section's rule is read from the bundle and not seen in a live editor.

**Not read.** The per-extension values of the registry font flag (`MimeType.ILt()`).

## Decision

**Option B-2: keep chef's lockstep walk and split presence from admission.** `planFileLevel` in `src/c3/projectSync.ts` reads each disk directory without an extension filter (presence). A disk file then takes part in classification when the manifest lists it at that path, or when the editor's rescan rule admits it. A disk file that is neither is invisible to sync, as filtered files were before. An unlisted subfolder takes part when the manifest lists it or `folderAdmitted` accepts it. Editor-local classification (ADR 0066 decision 2) still applies on both sides.

1. **The bridge is `src/c3/fileAdmission.ts`** (off-barrel). `fileAdmissionIssue(section, name, ctx)` returns why the editor skips a file, or `undefined` when it adds it. `folderAdmitted(section, name, ctx)` does the same for a folder. The name check reuses c3source's `itemNameIssue("layouts", name)`, with one carve-out: a `rewritten` result whose name equals `name.normalize()` is admitted, because the editor normalises to NFC internally and c3source compares the raw name. The carve-out is an inference from reading both bodies, pinned by `DB4-A4`.
2. **`skipFileSections` replaces the manifest view.** `runSync` calls `detectManifestDrift(rootDir, project, { skipFileSections: true })` and no longer builds a manifest copy without `rootFileFolders` (the `nameView` of ADR 0066). The option is kept for cost alone: chef discards upstream's file-section drift either way, and since c3source 4.0.0 those walks do not follow links ([c3source#114](https://github.com/GenvidTechnologies/c3source/issues/114)).
3. **`extensions` only narrows admission.** `FileSectionConfig.extensions` is `@deprecated` and kept for direct callers of the barrel-exported `syncFileFolder`. The `FILE_SECTIONS` entries no longer set it, `script` included.
4. **New items take `fileTypeForSection`.** `newItemType` uses c3source's per-section type for the seven known section keys and `inferMimeType` otherwise. This adopts the video facts attested by [c3source#113](https://github.com/GenvidTechnologies/c3source/issues/113): a video `.webm` is `video/webm`.

### Deviations from the editor

- **`script` also admits `.ts`.** The editor's rescan admits `.js` only. Without the deviation, sync would stop registering `.ts` scripts. This is a chef deviation. The editor's own `.js` admission is kept: an unlisted `.js` is registered unless its `.ts` twin is listed or present beside it. The `script` entry in `FILE_SECTIONS` sets no extension list, so nothing narrows the rule.
- **`font` uses a local extension set** (`.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`), because the registry flag's per-extension values were not read.
- **A `.js` file's `.ts` twin counts when it is listed in the folder or present on disk beside it.** The editor tests the registered twin.

### Tripwire and retirement

The test `DB4-T1` in `test/c3/fileAdmission.test.ts` goes red when `Object.keys` of the c3source module gains a name matching `/admi(t|ssion)|rescan/i`. The near miss `detectFamilyMemberIssues` must not match, and the test asserts that. When it goes red, adopt the upstream predicate and delete `src/c3/fileAdmission.ts`, its call site in `src/c3/projectSync.ts`, `test/c3/fileAdmission.test.ts` and `DB4-T1`. Afterwards `DB4-A1`, `DB4-A2`, `DB4-A3` and `DB4-A4` (moved over the adopted export), `DB4-S354` and `DB4-S2` must stay green. The upstream request is [c3source#130](https://github.com/GenvidTechnologies/c3source/issues/130).

## Compromise

The design's own labels are kept.

- **Option B-1: consume upstream file-section drift, post-filter through the admission rule (rejected).** It needs a post-filter, a re-pairing step (upstream pairs `moved` entries before chef can filter), a second apply engine that re-derives what `syncFileFolder` does, and a report order that follows upstream's sort instead of ADR 0065's walk order. That is roughly 200 more lines and broad output churn, for no behaviour that B-2 lacks. This weighs ADR 0066's Option B again and declines it again, for new reasons: ADR 0066's link-following reason no longer applies on 4.0.0, and its membership reason was wrong.
- **Option B-3: upstream `walkDiskFileTree` as the disk lister (rejected).** It returns files only, so the empty-directory mismatch of ADR 0016 still applies.
- **Keep the extension filters (rejected).** They hide a listed file whose extension is not in the list, which is the #354 defect, and they are not the editor's rule on either path.
- **No live-editor validation.** Every section but `video` rests on a read of the bundle. The rule can be wrong where the read was.

## Consequences

- **#354 is fixed.** A file the manifest lists takes part in classification whatever its extension.
- **Newly admitted.** An unlisted file the rescan rule admits is registered in its section. In `sound`, `music`, `video` and `icon` the test is the registry category; in `general` it is any extension; in `font` it is the local set; in `script` it is `.js` and `.ts`.
- **Newly refused.** An unlisted file the rescan rule refuses stays invisible: a name that fails the name check, one of the 17 reserved names directly under `files/`, a `.js` with a `.ts` twin, or an extension outside the section's category.
- **Real corpus.** The canonical fixture's file sections hold 18 regular non-editor-local files (2 `.ts` scripts, 7 `.png` icons, 9 general files), all listed. Against the old extension filters, 0 dispositions changed. The fixture holds no unlisted file and no subfolder, so the new admission paths are covered only by synthetic tests.
- **Mutation evidence** (HEAD 9478baf). Forcing admission true turns `DB4-S2` and `I358-V1` red. Ignoring the listed set turns `DB4-S354` red. Removing the NFC carve-out turns `DB4-A4` red. Removing the reserved-root check turns `DB4-A2` and `DB4-S2` red. The `script` section's `.js` admission is pinned by `DB4-S2` as well: the first implementation kept a `.ts` extension list on the `script` entry, which silently dropped an unlisted `.js`; that case failed when added to `DB4-S2` and passes since the list was removed.
- **The bridge is temporary** and ends at [c3source#130](https://github.com/GenvidTechnologies/c3source/issues/130), as above.
- **Link divergence** between chef's finders and upstream's walks is tracked in [#375](https://github.com/GenvidTechnologies/construct3-chef/issues/375).
