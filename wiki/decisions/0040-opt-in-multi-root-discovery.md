---
type: decision-record
title: "0040. Opt-in multi-root auto-discovery (`--discover-projects`)"
description: >-
  Adopts `@genvidtech/mcp-utils`'s `resolveRootFolders` to let an MCP server
  launch auto-register every ambiguous-discovery candidate as its own
  project, gated behind a new `--discover-projects` flag so every existing
  launch stays byte-identical by default. A discovery launch finding 2+ roots
  requires `--default-project` and fails the launch (before any project is
  registered) rather than picking one silently. Ships the work ADR 0034
  decline 7 deferred, now that both of its stated blockers have cleared
  ([#216](https://github.com/GenvidTechnologies/construct3-chef/issues/216))
tags: [decision, architecture, mcp]
status: stable
generated: { by: process:tech-writer, at: 2026-09-17T00:00:00Z }
---

# 0040. Opt-in multi-root auto-discovery (`--discover-projects`)

- **Status:** Accepted
- **Date:** 2026-09-17
- **Issue:** [#216](https://github.com/GenvidTechnologies/construct3-chef/issues/216)

## Context

ADR [0034](0034-mcp-server-multi-project-support.md) decline 7 deferred
registering every ambiguous-discovery candidate automatically, citing two
blockers: discovery produced bare paths with no id-derivation step, and the
candidate list existed only inside an error result rather than a real
structure to iterate. Both have since cleared, independently of each other.
`@genvidtech/mcp-utils` shipped `resolveRootFolders`: its result on 2+ marker
matches is a **success** (`ResolvedRoots`, `paths.length >= 1`) carrying every
candidate, rather than the singular `resolveRootFolder`'s `mcpError` on the
same input — `resolveRootFolder` is now a thin wrapper over it. And
`deriveProjectId(root, usedIds)` already existed in
`src/mcp/projectRegistry.ts`, built for the explicit multi-spec launch path in
the same PR (#212) that wrote decline 7 — so that blocker was already stale
the day the record shipped. Issue #216 was filed once both were confirmed
cleared, and this record ships the deferred work.

## Decision

### 1. Auto-discovery is opt-in, behind `--discover-projects`

Today, a parent directory containing 2+ `project.c3proj` markers is an
ambiguity `mcpError` that chef logs as falling back to cwd. Adopting the
plural result as the default would silently convert that into *N registered
projects* for anyone already launching from such a directory — a
launch-behaviour change with no signal they opted into anything. The new
`--discover-projects` flag (default `false`) keeps every existing launch
byte-identical.

Opt-in here is structural, not asserted. `buildProjectRegistry` takes the
discovery branch only when `specs.length === 0 && discoverProjects === true`
— an explicit `--project-dir`/`C3_PROJECT_DIRS` spec always wins with
unchanged precedence — and every other outcome of the discovery probe (0
discovered, 1 discovered, or a real `readdir` I/O fault) falls through to the
untouched `resolveLaunchRoots([], log)`. That function's own 0/1-spec branch
is unedited by this change, so those paths are identical to the flag being
off by construction rather than by re-derivation of the prior behaviour.
`test/mcp/rootResolution.test.ts`'s existing suite passes untouched, with no
assertion edited, and a dedicated opt-in test confirms that 2 markers present
with the flag omitted still produces today's ambiguous-discovery/cwd-fallback
path.

### 2. A discovery launch finding 2+ roots requires `--default-project`

`ProjectRegistry.add()` makes the first *registered* context the default;
"a registry with no default" is not an expressible state without rippling
that assumption into every handler that resolves one. An auto-discovered
launch also has no meaningful "first" of its own to offer — discovery order
is not a user-meaningful ranking. Rather than pick one silently,
`buildProjectRegistry` requires an explicit `--default-project` whenever
discovery finds 2+ candidates, and fails the whole launch — naming the
discovered ids and the flag needed to disambiguate — when it is missing. The
check runs before any `ProjectContext` is constructed, so a refused launch
never partially registers.

### Two of the issue's open questions were factual, not decisions

- *Where does auto-discovery sit in the precedence chain?* Only in the
  0-explicit-spec path — `resolveLaunchSpecs` already routes 2+ explicit
  specs past `resolveRootFolder`/`resolveRootFolders` entirely, so there was
  nothing to decide.
- *Does the cwd-fallback warning still make sense on the plural path?* It
  fires on `source === "cwd"`, which is orthogonal to plurality, so its
  semantics are unchanged by this feature.

Recording either of these as a "decision" would misrepresent them as a choice
this ADR made, when the existing code already determined the answer.

## Rejected alternatives

- **Default to the alphabetically-first discovered id.** Deterministic, but
  silently picks a project for the operator; failing loudly is more honest
  about a genuine ambiguity than resolving it invisibly.
- **Default to cwd when it is among the discovered roots.** Plausible and
  more ergonomic, but introduces a rule whose behaviour depends on where the
  server happened to be launched from, rather than on an explicit choice.
- **Make discovery the default, with a loud startup warning.** A warning
  nobody reads is still a silent behaviour change for every existing
  multi-marker launch.

## Consequences

- `buildProjectRegistry` gains an injectable `readdir` test seam, forwarded
  only to the discovery probe, so the probe's I/O-error branch is testable
  without a fragile real permission-denied directory. It is deliberate
  internal surface, not incidental: `src/mcp/` is not on the `src/index.ts`
  barrel, so nothing added here is published library API.
- Coverage is synthetic temp-dir throughout
  (`test/mcp/discoverProjects.test.ts`) — the canonical fixture has no
  multi-marker layout, so a fixture-based test of this feature would pass
  vacuously and would not notice it missing.
- The three breaking changes ADR 0034 shipped (schema `project` param,
  composite txId, `op-*` renaming) are unaffected: this decision adds a
  fourth launch-time input alongside the existing precedence chain and
  touches none of them.

## Related

- Amends ADR [0034](0034-mcp-server-multi-project-support.md) decline 7 —
  see the superseding note appended there.
