---
type: decision-record
title: "0045. Scaffold plan/write split and CLI path containment"
description: >-
  Follows ADR 0044. The scaffold tools' validation now lives in one read-only,
  off-barrel planning module (`scaffoldPlan.ts`) shared by the CLI and MCP,
  with per-surface write wrappers. The CLI's `scaffold-layout` resolves
  `--source` and `--out` against the project root and contains both to
  `layouts/`; `scaffold-sprite` applies MCP's plain-name check. Rejections and
  success lines render identically on both surfaces. Containment is lexical, so
  a Windows 8.3 short-form `--project-dir` can falsely reject a long-form
  absolute path
  ([#259](https://github.com/GenvidTechnologies/construct3-chef/issues/259),
  [#261](https://github.com/GenvidTechnologies/construct3-chef/issues/261))
tags: [decision, scaffold, safety, cli]
status: stable
generated: { by: process:tech-writer, at: 2026-10-10T00:00:00Z }
---

# 0045. Scaffold plan/write split and CLI path containment

- **Status:** Accepted
- **Date:** 2026-10-10
- **Issues:** [#259](https://github.com/GenvidTechnologies/construct3-chef/issues/259), [#261](https://github.com/GenvidTechnologies/construct3-chef/issues/261)
- **Follows:** ADR [0044](0044-scaffold-tools-refuse-existing-targets.md), which deferred a shared write orchestrator to #259. This record resolves that deferral in a narrower shape: the surfaces share a read-only plan step, not an orchestrator (see Rejected alternatives).

## Context

After ADR 0044, `scaffold-layout` and `scaffold-sprite` had two independent
implementations of the same validation, one in `src/cli.ts` and one in
`src/mcp/server.ts`, and they had drifted:

- The CLI resolved `--source` and `--out` against the current directory and
  checked neither. Acceptance row T8 of #259, measured on `5ffa389`, shows the
  worst case: an event-sheet passed as `--source` was written into
  `layouts/T8.json`, registered in `project.c3proj`, and then a generator threw
  a `TypeError`, leaving the project corrupted.
- The CLI's `scaffold-sprite` had no name check, so `--name ../X` wrote at the
  project root and `--source images/Sprite` read a subfolder file. MCP already
  rejected `/`, `\` and `..`.
- A missing output folder made the CLI fail partway; MCP created it.
- The CLI's `scaffold-sprite` scanned `images/` unconditionally, so a project
  without that folder failed after the objectType JSON was already written.
  MCP skipped the scan when `images/` was absent.
- Success and not-found messages used different path shapes on the two
  surfaces.
- `scaffold-layout --no-regenerate` was rejected by yargs strict mode (#261):
  the option had been declared under the literal name `no-regenerate`, so
  yargs' negation turned the flag into an unknown `regenerate` argument.

## Decision

1. **A read-only plan step plus write primitives, off-barrel.**
   [`src/c3/scaffoldPlan.ts`](../../src/c3/scaffoldPlan.ts) exports
   `planLayoutScaffold` and `planSpriteScaffold`, which validate in a fixed
   order and never write: containment, name check, source existence, the #254
   conflict guard from ADR 0044, then the clone. A plan is either a rejection
   (`invalid-path`, `invalid-name`, `source-not-found`, `conflict`, each with a
   rendered message) or an `ok` plan carrying the output path, the cloned JSON
   and the success line. `writeLayoutScaffold` and `writeSpriteScaffold` perform
   the writes for an `ok` plan. Four shared formatters render every message:
   `formatScaffoldPathRejection`, `formatScaffoldNameRejection`,
   `formatScaffoldSourceNotFound` and `formatScaffoldSuccess`.
   The module is deliberately not re-exported from `src/index.ts`, like
   `scaffoldGuard.ts`, so it adds no public API and has no semver impact;
   `spriteScaffold.ts` and `scaffoldGuard.ts` are unchanged.
2. **Each surface keeps its own write wrapper.** MCP keeps the tx check,
   `watcher.suppress`/`expect`, progress notifications and the txId line. The
   CLI keeps stdout/stderr and the exit code. `runSync` stays per-surface.
   Only validation and rendering are shared, which is what had drifted.
3. **CLI paths resolve against the project root and are contained to
   `layouts/`.** Both `--source` and `--out` of `scaffold-layout` go through
   `resolveWithin` after being anchored at the project root
   (`pathBase: "project-root"`). Containing `--source` as well as `--out` is
   required by the T8 evidence above, not just a symmetry. MCP keeps
   `pathBase: "layouts"`, since its arguments are relative to `layouts/`.
   Missing output folders are now created on the CLI, as MCP already did.
4. **Sprite names are checked on the CLI.** `scaffold-sprite` applies MCP's
   rule: no `/`, `\` or `..` in `source` or `name`. `--name ../X` no longer
   writes at the project root, and a subfolder `--source images/Sprite` is
   rejected. The image scan is part of the plan and is skipped when `images/`
   is absent, so both surfaces treat that folder as optional.
5. **Rendering.** Success and not-found paths are POSIX and relative to the
   project root on both surfaces. A rejection is one stderr line with exit
   code 1. Scaffold handler errors render `Error: <message>` with no stack and
   no help text. This is scoped to the scaffold handlers; a CLI-wide yargs
   `.fail()` is a separate follow-up, not part of this change.
   *(Superseded in part by ADR [0055](0055-cli-handler-errors-are-rendered-by-a-registration-guard.md): a registration guard now renders every CLI handler error, and the local scaffold catches are gone.)*
6. **#261 shipped in the same change.** The option is now declared as
   `regenerate` (boolean, default true), as on the other four regenerating
   commands, so `--no-regenerate` parses. It needs no decision of its own.

## Rejected alternatives

- **Leave the two implementations and patch the CLI.** The drift is what
  produced the bug class; a second copy would drift again.
- **A single shared write orchestrator.** The surfaces differ in exactly the
  parts that wrap the write (locking and tx tracking, versus exit codes), so a
  shared orchestrator would need callbacks for all of them. Sharing the pure
  plan step captures the duplication that matters.
- **Export the module from the barrel.** Every barrel export is permanent
  published API (see ADR 0044); this is an internal safety layer.
- **Contain only `--out`.** Rejected on the T8 evidence: an unchecked
  `--source` is enough to corrupt the project.

## Consequences

- **Behaviour changes on the CLI**, called out in the CHANGELOG: relative
  `--source`/`--out` now mean project-root-relative, not cwd-relative; paths
  outside `layouts/` and sprite names with separators are rejected.
- **Two accepted MCP deviations.** A non-normalized `source` in a not-found
  message, and a non-normalized `path` in the success line, are now rendered
  normalized instead of echoed raw.
- **Known limitation: containment is lexical.** `resolveWithin` does not touch
  the filesystem, so a `--project-dir` given in Windows 8.3 short form
  (`C:\Users\FABIEN~1\...`) against an absolute `--out` in long form, or the
  reverse, is falsely rejected. It fails safe: a rejection, never an escape. A
  follow-up could canonicalize both sides with `realpathSync.native`. For the
  same reason, a symlink or junction inside `layouts/` that points elsewhere is
  not detected; that one does not fail safe.
- **The sprite name check is a substring test.** Any `..` is rejected, so a
  legal but unusual name such as `a..b` is refused too. This is MCP's existing
  rule, adopted unchanged rather than loosened.
- A yargs-wide error renderer for the remaining CLI commands is a follow-up. *(Resolved by ADR [0055](0055-cli-handler-errors-are-rendered-by-a-registration-guard.md), [#266](https://github.com/GenvidTechnologies/construct3-chef/issues/266).)*

**Amended by ADR [0056](0056-scaffold-sprite-resolves-a-bare-source-across-objecttypes-subfolders.md):** the sprite rejection kinds gain `source-case-mismatch` and `source-ambiguous`, and a bare `--source` now resolves in any `objectTypes/` subfolder; a path is still rejected.
