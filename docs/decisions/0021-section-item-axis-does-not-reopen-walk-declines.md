# 0021. `find_all_section_items_path` does not reopen ADR 0016's walk declines

- **Status:** Accepted
- **Date:** 2026-08-12
- **Issue:** [#175](https://github.com/GenvidTechnologies/construct3-chef/issues/175)

## Context

ADR [0016](0016-shared-file-walk-adoption-triage.md) declined adopting
c3source's shared file walk at three sites — `projectSync.readDiskDir`
(§2), `generators.findJsonFiles` (§3), and the then-new `descend`
parameter (§4, no consumer in chef) — and ADR
[0019](0019-two-walk-primitives-one-classification-rule.md) generalized
the resulting choice into a selection rule: reach for the c3source named
collector when a site owns a project root / `C3Project` handle and can
afford to fail loudly on an I/O fault; reach for `walkFiles` +
`editorLocal.isEditorLocalPathUnder` when the site's contract is a bare
directory, is barrel-exported, or depends on the missing-directory/
`ENOENT` degrade.

Both records were reasoned against a c3source that offered only the
**reachability** axis (`descend`) on `find_all_files_path` — classification
(item-hood by extension, editor-local provenance) stayed the caller's
`predicate`. `@genvidtech/c3source@2.0.0`, adopted in this PR (#175),
introduces `find_all_section_items_path(dir)`: a **new named walk axis**
that folds both dimensions into one collector. Verified from the published
package's `dist/layouts.js`:

```js
export function find_all_section_items_path(dir) {
    return find_all_files_path(dir, (file) => isSectionItemName(file) && !isEditorLocalPath(file));
}
```

`find_all_files_path` itself (`dist/layouts.js` L190–207) is **unchanged**
between 1.9.0 and 2.0.0 — verified by a line-for-line diff of the two
compiled files. It still does a bare `readdirSync(dir)` with no
try/catch (so it throws on a missing directory), a `.sort()` on the
entries, and a per-entry `statSync(filepath)` inside the walk.

The question this record settles: does a both-dimension named axis
existing at all reopen ADR 0016's declines, now that the objection
"upstream only classifies by reachability" is gone?

## Decision

**No. All three declines stand.** But the *reasoning* behind one of them
shifted, and that shift must be on the record rather than left for a
future reader to discover unaided.

### §3 (`findJsonFiles` / `generateSidRegistry`) — decline stands, on narrower grounds

Its three cost objections are properties of `find_all_files_path`, which
2.0.0 leaves untouched:

- it throws on a missing directory, where mcp-utils' `walkFiles` swallows
  `ENOENT` — `generateSidRegistry` relies on that tolerance so a partial
  project missing `objectTypes/` still produces a registry;
- its per-entry `statSync` would convert a per-file TOCTOU into a
  whole-directory abort at the second caller, `server.ts`'s sid-registry
  freshness scan, whose loop is written to skip a vanished file and keep
  scanning rather than mask later staleness;
- its `.sort()` is a third observable difference.

All three still land on `findJsonFiles` and `SID_SOURCE_DIRS`, both
barrel-exported at 1.0.0.

**What changed, and must be said plainly:** ADR 0016 §3's *"buys nothing"*
half is now genuinely weaker, not merely unaffected. At the time it was
written, the editor-local *classification* was already delegated locally
(`generateSidRegistry`'s post-hoc path-segment filter), so there was no
duplicated *rule* to dedup by adopting upstream's walk — only a duplicated
*walk*, and the walk was exactly where the tolerances diverged. That was
the section's stated reason there was nothing to gain.
`find_all_section_items_path` removes that reason: it combines item-hood
*and* editor-local provenance in one collector, which is precisely the
"reachability is not classification" gap ADR 0016 §5 identified as
missing, now closed upstream. So the decline no longer rests on the three
costs **plus** the absence of any classification gain — it rests on the
three costs **alone**. The verdict is unchanged; one leg of the argument
that used to support it is gone. Recording this is the point of this ADR:
a record that only restated "the decline stands" would let a future
reader who notices the both-dimension primitive and finds no note
reasonably conclude nobody looked.

### §2 (`readDiskDir` / `projectSync`) — decline stands, untouched

None of §2's three independently-sufficient mismatches turn on which axis
a collector classifies by. A files-only collector — named-axis or not —
structurally cannot return the *directories* `syncFileFolder` mirrors into
`rootFileFolders[].subfolders[]`; it cannot be stepped per-level in
lockstep with the manifest tree `syncFileFolder` owns the recursion for;
and its `ignorePaths`/`ignoreDirs` still encode manifest-section
*membership* semantics (`.ts`/`.webm`/`.ttf`/`.png` extension filters)
that are chef's concern, not upstream's. `find_all_section_items_path`
speaks to none of these — it is still a flat, recursive, files-only
collector. Unaffected.

### §4 (the `descend` parameter) — decline stands, unchanged

Still no walk in chef to parameterize: `ts-defs/` is reached by two
hardcoded filenames, a tsconfig `include` glob string, and a skip — not a
walk. The new axis doesn't create one.

## Compromise

- **The "buys nothing" argument is retired, not the decline.** Future
  triage of this site should reason from the three cost objections alone,
  not from "there's nothing upstream offers that we don't already have" —
  that framing is now false and would mislead the next reader who tries
  to restate the case from memory.
- **No code change accompanies this record.** #175's deliverable is the
  bump plus its revert-confirm guard (`test/c3/strayFileTolerance.test.ts`)
  — this record is the required accompanying honesty check on the walk
  declines, not a trigger for new adoption work.

## Consequences

- ADR 0019's selection rule is unaffected and still governs: reach for a
  c3source named collector when the site owns a project root /
  `C3Project` handle and can afford to fail loudly on an I/O fault; reach
  for `walkFiles` + `editorLocal.isEditorLocalPathUnder` when the site's
  contract is a bare directory, is barrel-exported, or depends on the
  missing-directory/`ENOENT` degrade. `findJsonFiles` and `readDiskDir`
  remain firmly in the second category.
- **What would actually reopen `findJsonFiles`** is not a further named
  axis but an upstream walk carrying `walkFiles`' error tolerances — a
  version of `find_all_files_path` (or a named collector built on it) that
  swallows `ENOENT`, tolerates a per-entry TOCTOU without a whole-directory
  abort, and doesn't impose ordering. That is the concrete signal to watch
  for at the next c3source bump, not "a new named axis shipped."
- This is ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md)'s
  posture applied again, at the same three sites ADR 0016 already
  triaged: owning the fact upstream isn't sufficient, and neither is
  owning a broader axis of the walk — check the primitive against the
  same cost objections the call site raised last time, not against
  whether it looks superficially more capable now.
