# 0027. Cover a Windows-only defect with cross-platform stub coverage, not manual verification

- **Status:** Accepted
- **Date:** 2026-08-16
- **Issue:** [#191](https://github.com/GenvidTechnologies/construct3-chef/issues/191)

## Context

`@genvidtech/mcp-utils` 0.7.0 adds Layer 3 to `OptimisticWatcher` — a
per-path content-fingerprint ledger (`ObservedState`) that collapses
duplicate filesystem events for unchanged content. It fixes a
Windows/NTFS defect where a single `writeFileSync` delivers two
`fs.watch` events, so `txId` counted watcher events rather than
logical changes. The issue as filed proposed a manual Windows run as
"the only real confirmation" that the fix works, since the triggering
condition — NTFS delivering duplicate raw events — cannot be produced
on Linux CI.

That framing conflates two separable things: the **trigger** (NTFS
delivering two raw events per one write) is genuinely platform-specific
and unreproducible in this repo's CI, but the **behaviour** being
adopted (collapsing two same-content events into one bump) is not — it
is reachable by firing the watcher's existing injected stub factory
twice for the same path, which `test/mcp/sourceWatcher.test.ts` has
supported since it was written. A platform-specific trigger does not
imply platform-specific testability when there is a seam to inject at.

The existing 9 `sourceWatcher.test.ts` tests could not have caught a
regression here even accidentally: each fires its path exactly once,
and `build()` constructs a fresh watcher per test, so Layer 3 always
saw `prev === undefined` and bumped regardless of whether the
fingerprint ledger existed. A green suite after the bump would have
proved nothing about the newly adopted behaviour.

## Decision

Add two tests to `test/mcp/sourceWatcher.test.ts` against the injected
stub factory, firing one real temp file's path twice so fingerprints
compare real content rather than two `"absent"` reads: (1) unchanged
content between the two fires asserts `txId` bumps exactly once; (2)
genuinely changed content between the two fires asserts a second bump.
Drop the manual Windows verification the issue proposed; treat this
stub coverage as sufficient.

Non-vacuity was proven as an artifact, not asserted as a claim: test
(1) was committed red (`8475529`) against the then-installed mcp-utils
0.6.0 — no Layer 3, two events, `txId` asserted 1 but observed 2 — and
the following bump commit (`4ca15a2`) turns it green. Per this repo's
paired-assertion convention, only test (1) is real evidence; test (2)
passes in **both** the pre- and post-bump state by design, since it
guards against Layer 3 over-collapsing a genuine content change rather
than against Layer 3 being absent. It is deliberately kept
duplicate-free from test (1) so which assertion carries the evidence
stays unambiguous — a reader auditing this record should read *which
half* went red, never the row's overall pass/fail alone.

## Compromise

**Rejected — manual Windows verification as the merge gate** (the
issue's original proposal). Blocks on a human being present at
Windows hardware, produces no durable regression guard once that human
moves on, and would have left the newly adopted behaviour with zero
automated local coverage — the next `mcp-utils` bump, or a future
refactor of `sourceWatcher.ts`, could silently regress Layer 3's
effect with nothing to catch it.

**Rejected — rely on the existing suite passing unmodified.** Vacuous
by construction: every pre-existing test fires each path exactly once,
so Layer 3 never sees a repeated path and a green run proves nothing
about the behaviour being adopted, regardless of whether Layer 3
exists or works.

**Rejected — `observed: null`** to sidestep the whole question by
opting `OptimisticWatcher` out of Layer 3 entirely. Forfeits the fix
the bump exists to adopt.

## Consequences

- The accepted gap this decision leaves open: nothing locally confirms
  that native `fs.watch` on Windows/NTFS actually delivers duplicate
  raw events for one write, as opposed to the duplicates being
  collapsed earlier by chance before they ever reach
  `OptimisticWatcher`. Chef's coverage proves the *collapsing
  behaviour*; it does not and cannot prove the *duplicate delivery*
  trigger from cross-platform CI. This is recorded in
  `docs/leaf-dependency-ledger.md`'s `0.7.0` entry as the thing to
  check at the next `mcp-utils` bump, should the trigger mechanism
  itself ever come into question (e.g. an OS/filesystem change that
  alters `fs.watch` delivery semantics).
- Revert-confirm (`CLAUDE.md` § "Leaf dependencies") found no local
  guard overlapping Layer 3 — the one plausible candidate, chef's
  editor-local `filteringFactory` in `sourceWatcher.ts`, was confirmed
  still load-bearing by mutation (disabling it took the suite to 8
  passing / 3 failing, exactly the three editor-local dimension
  tests), not assumed safe by reasoning alone.
- The reusable rule this record exists to carry forward: a
  platform-specific *trigger* does not imply platform-specific
  *testability* — find the seam the trigger ultimately drives and
  inject at that seam instead of at the platform.
