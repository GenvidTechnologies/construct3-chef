---
type: decision-record
title: "0070. validate and sync report duplicate names and skipped links as advisories"
description: >-
  `validate-project` and `sync-project`, on the CLI and on MCP, print a `[duplicates]` and a `[links]` section after
  `[strays]`. They come from one standalone `detectManifestDrift` call with `skipFileSections`, are advisory (no exit
  code and no `clean` change), and render every occurrence on both sides as written. The record holds the eight
  policy answers of #344
  ([#344](https://github.com/GenvidTechnologies/construct3-chef/issues/344))
tags: [decision, sync, validate, mcp]
status: stable
generated: { by: process:tech-writer, at: 2026-11-05T00:00:00Z }
---

# 0070. validate and sync report duplicate names and skipped links as advisories

- **Status:** Accepted
- **Date:** 2026-11-05
- **Issues:** [#344](https://github.com/GenvidTechnologies/construct3-chef/issues/344) (a duplicates report). Related: [#368](https://github.com/GenvidTechnologies/construct3-chef/issues/368) (existing names C3 treats differently), [#375](https://github.com/GenvidTechnologies/construct3-chef/issues/375) (link divergence). Dependency adoption: [#374](https://github.com/GenvidTechnologies/construct3-chef/issues/374) (c3source 4.0.0).
- **Relates to:** ADR [0023](0023-stray-files-are-a-detection-only-report.md) (the detection-only report and its standalone call), ADR [0025](0025-stray-gating-is-cli-only-and-survives-a-manifest-failure.md) (gating is CLI-only), ADR [0068](0068-mcp-findings-ride-in-structured-content-and-iserror-stays-tool-failure.md) (`clean` equals the CLI's exit 0), ADR [0069](0069-file-section-admission-follows-the-editors-rescan-rule.md) (chef's own file-section walk).

## Context

c3source 4.0.0 returns two more lists from `detectManifestDrift`: `duplicates` (item names repeated within a uniqueness scope) and `links` (symbolic links or junctions that the walk did not follow). Drift keying stays exact upstream, so a case-only rename still reads as `missing` plus `untracked`; a duplicate is a separate finding.

Two facts make the report needed. Chef's finders now skip linked items silently, so `links` is where a skipped name-section link shows. A link under a file-section folder is skipped by chef's own file walk (`readDiskDir` keeps only regular files and directories) and is not listed, because the call skips the file sections ([#375](https://github.com/GenvidTechnologies/construct3-chef/issues/375)). And ADR 0066 set `ManifestDrift.duplicates` to carry no file-section entries in chef's runs, because chef hid those sections from the call.

The input to #344 said that upstream marks the per-section scope and the letter-case rule as unvalidated. That is out of date: the name scopes are audited against editor r495-2. Only the file-section scope and the `images` scope are unvalidated upstream.

## Decision

`reportDriftAdvisories(rootDir, log)` in `src/c3/driftAdvisories.ts` (off-barrel) makes one `detectManifestDrift(rootDir, undefined, { skipFileSections: true })` call and prints two sections: `[duplicates]` and `[links]`. Each prints at least one line, `(no duplicates)` or `(no links)` when empty, in the shape of `reportStrayFiles`. It returns the full findings, and prints at most 20 lines per list. It is called after the strays report in `validate-project` and in `sync-project`, on both surfaces. In `validate-project` it is called only when the manifest was readable, because the unreadable case is already reported.

The line shapes:

- `! <scope> '<key>': manifest <occurrence>, …; disk <occurrence>, …`, where an occurrence is `folder/path…/name` as written, and a side with no occurrence prints `(none)`.
- `! <folder>/<diskPath…>/<name> (not followed)` for a link.

### The eight policy answers

1. **Scopes: name scopes plus `images`.** File sections are excluded. `skipFileSections` skips them, and upstream marks their scope unvalidated.
2. **Sides: both, every occurrence.** The manifest side and the disk side are each listed in full.
3. **Folded or exact: render upstream's folded `key` plus each occurrence as written.** The case difference shows without chef re-deriving which scopes fold. Drift keying stays exact.
4. **`objectClasses`: reported here.** The duplicate across object types and families is reported by this change. It covers the "object type and family share a name" case of [#368](https://github.com/GenvidTechnologies/construct3-chef/issues/368).
5. **Gate: advisory.** The report changes no exit code and no `clean`. Upstream has not traced whether the editor fails to load a project with such a duplicate, so "the project fails to open" is unverified.
6. **Placement: a standalone call next to `reportStrayFiles`** (the precedent of ADR 0023). Scaffold syncs stay silent.
7. **Links: reported, advisory.** The report is where a name-section link that chef's finders skipped shows. File-section links are not covered (see Context).
8. **The stale premise** about unvalidated name scopes is corrected, as in Context.

## Compromise

- **Fail `validate-project` on a name-scope duplicate (rejected).** It needs the editor's behaviour on such a project, which upstream has not traced. It would also have to change the CLI exit code and the MCP `clean` together (ADR 0068).
- **A CLI opt-in flag, `--fail-on-duplicates`, on the shape of ADR 0025 (rejected for now).** It can be added later without breaking anything.
- **A `runSync` callback or a render inside `runSync` (rejected).** A callback exposes `ManifestDrift` in the barrel-exported signature. The cost of the standalone call is a second name-section walk per validate or sync.
- **Include the file sections (rejected).** Chef walks them itself (ADR 0069), and upstream's scope for them is unvalidated.
- **Show folded keys only, or exact names only (rejected).** Either hides what the other shows.

## Testing

Tests by id:

- `DB4-U1`, `test/c3/driftAdvisories.test.ts`: an object type and a family with the same name give the exact `[duplicates]` line.
- `DB4-U2`, same file: two layouts differing in letter case, in different folders, give the exact line.
- `DB4-U3`, same file: a clean copy of the canonical fixture gives one `(no duplicates)` and one `(no links)` line.
- `DB4-U4`, `test/mcp/serverHandlers.test.ts`: the CLI and MCP `validate-project` advisory lines are byte-identical, and a duplicate changes neither the exit code nor `clean`.
- `DB4-U5`, same file: `scaffold-layout` and `scaffold-sprite` output holds no `[duplicates]` or `[links]` line.
- `DB4-U6`, `test/c3/driftAdvisories.test.ts`: an unparsable `project.c3proj` gives one `Could not parse` line, then `[images]` and `[strays]`, and no advisories.
- `DB4-U7`, `test/c3/syncFileSectionWalk.test.ts`: a junction at `layouts/sub/loop` gives the exact `[links]` line.

## Consequences

- **A project with a duplicate prints it.** The exit code and `clean` are as before.
- **A duplicate that the editor cannot load is not detected as such.** The report says what is repeated, not what the editor does with it.
- **Each validate or sync makes a second name-section walk.**
- **File-section duplicates are not reported.**
- **Links are visible.** Whether chef's finders and upstream's walks agree on which links to skip is tracked in [#375](https://github.com/GenvidTechnologies/construct3-chef/issues/375).
- **The CLI reference and the CHANGELOG** describe the two sections.
