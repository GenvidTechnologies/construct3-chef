# 0024. `runSync` writes `project.c3proj` through c3source's shared serializer

- **Status:** Accepted
- **Date:** 2026-08-14
- **Issue:** [#154](https://github.com/GenvidTechnologies/construct3-chef/issues/154)

## Context

`project.c3proj` had two writers that agreed only by convention. `runSync`
(`src/c3/projectSync.ts`) serialized it by hand —
`writeFileSync(projectPath, JSON.stringify(project, null, "\t"))` — while
`applyAddonMetadataSync` (`src/c3/addonMetadataSync.ts`, ADR
[0017](0017-sync-addon-metadata-separate-mutation-command.md)) already wrote
through c3source's `writeProjectManifest`. The two forms were byte-identical,
but nothing enforced that: neither typecheck nor the test suite would catch a
one-sided change — a trailing newline, an indent change, a spread-rebuild
that reorders keys — to either writer. The failure mode is a silent
whole-file diff on a real user's project, or one writer dropping the other's
unmodeled fields.

This is the adoption half of ADR
[0006](0006-upstream-ownership-boundary-and-adoption-posture.md)'s posture:
the byte form of a C3 manifest is a platform fact c3source owns (its
`serializeC3Json` docstring cites real-editor-write evidence across many
files), not something chef keeps a second copy of.

## Decision

Route `runSync`'s write through c3source's `writeProjectManifest`, the same
call `applyAddonMetadataSync` already uses. `writeFileSync` becomes
`projectSync.ts`'s only dead import and is removed — nothing automated
catches that, since this repo's ESLint config disables `no-unused-vars`.

**Only half the invariant becomes structural, and that half is the point of
this record.** #154, as filed, proposed that the cross-reference comments at
both write sites "can be simplified or dropped, since the invariant becomes
structural rather than conventional." That claim does not survive planning:

- **Now structural — serialization.** One shared serializer means the two
  writers cannot drift in byte form. This is what the refactor actually
  buys.
- **Still purely conventional — parse-by-identity / mutate-in-place.**
  Nothing stops a future `runSync` change from rebuilding `project` via a
  spread, which would reorder keys and drop unmodeled fields exactly as
  before `writeProjectManifest` was adopted. `writeProjectManifest` writes
  whatever object it is handed; it enforces nothing about how that object
  was produced.

So the comments at both sites were narrowed rather than dropped: the
serialization sentence was removed, and the never-rebuild-via-spread warning
was retained at both `projectSync.ts`'s `runSync` write site and
`addonMetadataSync.ts`'s `applyAddonMetadataSync` docstring, cross-referencing
each other by name rather than by call-site text (per this repo's
name-based-citation convention — a `writeFileSync(projectPath, …)` citation
would have gone stale the moment this change deleted that expression).

The read path is deliberately untouched. `runSync` still reads via **strict**
`readProjectManifest`, not the tolerant variant — the three `runSync error
contract` tests pin that a malformed manifest still throws, and switching to
`readProjectManifestTolerant` would retire behavior those tests assert.

The MCP write path was checked, not assumed safe: all three mutating
`runSync(…, false, …)` call sites in `server.ts` already wrap the call in
`watcher.suppress(...)`, so `writeProjectManifest`'s direct synchronous write
composes cleanly under the existing suppression window. Upstream returns
`serializeProjectManifest`'s string separately from the write precisely so a
caller needing different write mechanics (atomic rename, watcher
suppression) can compose on top — that composition already lives at the call
site, one level up in `runSync`, and does not need reinventing as a
string-return-then-`writeFileSync` form at the write site itself.

## Compromise

**Rejected — drop both cross-reference comments, as #154 originally
proposed.** Declined because it overstates what changed: it would read as
"the invariant is now enforced," when only the serialization half is. The
comments were narrowed instead of dropped so a future reader isn't misled
into thinking the whole hazard the original comments warned about is gone.

**Not pursued — enforce parse-by-identity/mutate-in-place structurally too**
(e.g. a linter rule against spreading a parsed manifest, or a type that
makes the object non-reconstructible). Out of scope for this issue; the
convention-only state is recorded as a known, accepted gap rather than
silently left for a future reader to rediscover.

## Consequences

- Verified equivalence, not assumed: `serializeProjectManifest(m)` is
  `serializeC3Json(m)` = `JSON.stringify(value, undefined, "\t")`; `null` and
  `undefined` are equivalent `JSON.stringify` replacers. Confirmed against
  the real fixture — `test/fixtures/construct3-chef-sample/project.c3proj` is
  round-trip stable, and both the removed hand-rolled form and
  `writeProjectManifest` produce identical bytes (6199), with no trailing
  newline.
- The repo gained its first `dryRun=false` `runSync` test
  (`test/syncC3Proj.test.ts`, "runSync manifest write (dryRun=false)"). A
  behaviour-preserving refactor is exactly the shape where a new assertion
  can pass for the wrong reason, so the test was mutation-checked rather than
  trusted on inspection: appending `"\n"` to the write turns the
  no-trailing-newline assertion red (47 passing / 1 failing in that file),
  and reverting restores the full suite to green (1555 passing). This record
  is the standard's only home today — no repo-wide convention doc describes
  the mutation check, so cite this ADR rather than an assumed CLAUDE.md
  habit. The narrower point worth carrying forward: a revert-and-confirm-red
  pass proves only the rows that *were* red. A row green from the start is
  invisible to it, which is precisely where a vacuous assertion survives —
  so force the state such a row forbids and confirm it fails.
- `writeProjectManifest`/`serializeProjectManifest` are barrel-exported
  `@genvidtech/c3source` API `runSync` now depends on directly, alongside
  `readProjectManifest`, `detectImageDrift`, `detectManifestDrift`, and
  `detectStrayFiles` already imported there.
