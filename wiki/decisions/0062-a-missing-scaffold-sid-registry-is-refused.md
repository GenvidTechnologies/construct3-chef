---
type: decision-record
title: "0062. A missing scaffold SID registry is refused"
description: >-
  `scaffold-layout` throws a project-relative, shared-formatted error when
  `<extractedDir>/sid-registry.txt` is missing instead of seeding the clone's
  new SIDs from an empty set. An environment precondition fault is thrown and
  rendered as `Error:`; an input mistake stays a returned rejection
  ([#316](https://github.com/GenvidTechnologies/construct3-chef/issues/316))
tags: [decision, scaffold, sid-registry, errors]
status: stable
generated: { by: process:tech-writer, at: 2026-10-28T00:00:00Z }
---

# 0062. A missing scaffold SID registry is refused

- **Status:** Accepted
- **Date:** 2026-10-28
- **Issues:** [#316](https://github.com/GenvidTechnologies/construct3-chef/issues/316). Follow-ups: [#336](https://github.com/GenvidTechnologies/construct3-chef/issues/336), [#337](https://github.com/GenvidTechnologies/construct3-chef/issues/337).
- **Relates to:** ADR [0045](0045-scaffold-plan-write-split-and-cli-path-containment.md) (not amended; its rejection kinds are unchanged), ADR [0055](0055-cli-handler-errors-are-rendered-by-a-registration-guard.md), ADR [0004](0004-dual-surface-shared-library-and-formatters.md).

## Context

`planLayoutScaffold` (`src/c3/scaffoldPlan.ts`) seeded the used-SID set with `existsSync(sidRegistryPath) ? readRegistryFile(sidRegistryPath) : new Set<number>()`. A missing `<extractedDir>/sid-registry.txt` therefore minted the clone's new SIDs against an empty set, silently. A caller that passed the wrong directory went unnoticed, and SID uniqueness then rested on chance.

Every other registry consumer already refused a missing registry: `applyParsed` (the recipe and op tools, through `readRegistryFile`'s `SID registry not found at <abs path>` throw) and MCP `generate-sids`. `scaffold-layout` was the only silent one. Both callers passed the right directory, so this was a missing guard, not a live bug; #316 began as a test-only issue.

The user weighed the policy first: keep the silent fallback, warn and keep going, or refuse. Refusing was chosen. The remaining question was the mechanism.

## Decision

**Throw a project-relative, shared-formatted error from the plan.** When the registry file is missing, `planLayoutScaffold` throws `new Error(formatScaffoldRegistryMissing(relPosix(rootDir, sidRegistryPath)))`. The text is `SID registry not found: <project-relative path> — run 'construct3-chef generate --only sid-registry' (MCP: the 'regenerate' tool) first`. The check sits where the read was, after the input, conflict and `JSON.parse` checks, so input mistakes are reported first.

- **CLI.** `guardAllHandlers` (ADR 0055) renders the throw as one `Error:` line, exit 1.
- **MCP.** The error wrapper renders `Error: …` plus the txId line, with `isError`. The handler marks its write ledger only after the plan succeeds, so the refusal neither bumps the txId nor sets `extractedDirty` (ADR [0048](0048-a-failed-mcp-mutation-reports-what-it-may-have-written.md)).
- **Nothing is written** on either surface.

**The durable rule for later scaffold work: an environment precondition fault (a missing derived file) is thrown and rendered as `Error:`; an input mistake is a returned rejection, printed without a prefix.**

## Alternatives considered

- **Chosen: Option A, throw a project-relative, shared-formatted error from the plan.**
- **Rejected: Option B: a new `kind: "registry-missing"` rejection, returned** — the CLI prints it with no `Error:` prefix, which contradicts the user's decision; it amends ADR 0045's kind enumeration; and it classifies an environment precondition as an input rejection.
- **Rejected: Option C: drop the guard and let `readRegistryFile` throw** — the message carries an absolute path, breaking the render-the-resolved-project-relative-path rule (SI267-R9), and it tells MCP users to run a CLI command.

## Consequences

- **ADR 0045 is not amended.** The rejection kinds it enumerates (`invalid-path`, `invalid-name`, `source-not-found`, `conflict`) are unchanged, as are the two sprite kinds ADR [0056](0056-scaffold-sprite-resolves-a-bare-source-across-objecttypes-subfolders.md) added later (`source-case-mismatch`, `source-ambiguous`); this fault is deliberately outside that enumeration.
- **The message is rendered once,** by a shared formatter, so CLI and MCP agree on the path form (ADR 0004).
- **Behaviour change.** A CLI `scaffold-layout` before `generate` has ever run now fails until `generate` runs. A non-default MCP project needs `regenerate` first, because only the default project auto-generates `extracted/` at startup, and only when the directory is missing.
- **Out of scope, filed.** [#336](https://github.com/GenvidTechnologies/construct3-chef/issues/336): `scaffold-sprite` mints SIDs against objectTypes only, never the registry. [#337](https://github.com/GenvidTechnologies/construct3-chef/issues/337): MCP `scaffold-layout` does not call `checkDerivedFreshness` on the registry, so a stale one goes undetected.
