---
type: decision-record
title: "0055. CLI handler errors are rendered by a guard applied at registration"
description: >-
  Every CLI subcommand handler is wrapped as it is registered, so a thrown error
  or rejected promise prints one `Error: <message>` line on stderr and exits 1,
  with no stack and no yargs help dump. Argument-validation errors keep yargs'
  usage output. Rejects wrapping each handler by hand and rejects a `.fail()`
  hook with a top-level catch
  ([#266](https://github.com/GenvidTechnologies/construct3-chef/issues/266))
tags: [decision, cli, errors]
status: stable
generated: { by: process:tech-writer, at: 2026-10-21T00:00:00Z }
---

# 0055. CLI handler errors are rendered by a guard applied at registration

- **Status:** Accepted
- **Date:** 2026-10-21
- **Issues:** [#266](https://github.com/GenvidTechnologies/construct3-chef/issues/266) (a failing CLI handler printed a raw stack or a yargs help dump). Related: [#259](https://github.com/GenvidTechnologies/construct3-chef/issues/259) (the scaffold handlers' local catches).
- **Supersedes in part:** ADR [0045](0045-scaffold-plan-write-split-and-cli-path-containment.md) decision 5, which scoped `Error: <message>` rendering to the scaffold handlers.
- **Resolves:** the forward reference in ADR [0046](0046-recipe-and-scaffold-paths-have-one-canonical-case-insensitive-identity.md) Consequences ("The CLI help text is untouched; it stays with #266").

## Context

A handler in `src/cli.ts` that threw, or whose promise rejected, reached yargs. Depending on the shape, the user saw a raw stack trace or the full help dump that yargs prints for a failure, which buries the actual message. Only the two scaffold handlers rendered their own errors, through local try/catch blocks added in #259.

Behaviour measured on yargs 17.7.2:

- A synchronous handler throw never reaches `.fail()`, under either `.parse()` or `.parseAsync()`.
- `.check()` and `coerce` failures do reach `.fail()` with `err` set (a plain `Error` or a `YError`), so `err === undefined` cannot separate argument validation from handler errors.

So a single `.fail()` hook cannot tell the two classes apart, and cannot see some handler errors at all.

## Decision

1. **Guard every handler at registration.** `src/cliErrors.ts` (off-barrel) provides `guardAllHandlers(y)`, which patches the yargs instance's `command` method so that every handler registered afterwards is wrapped by `guardHandler`. The root instance in `src/cli.ts` is `guardAllHandlers(yargs(hideBin(process.argv)))`, and the 21 `.command(` call sites are not edited. The wrapper catches synchronous throws and async rejections and passes them to `reportCliError`, so they never reach yargs.
2. **One rendering.** `formatCliError(err)` returns `"Error: "` followed by the message, verbatim (multi-line allowed), or `String(e)` for a non-`Error`. `reportCliError(err)` writes that line to stderr and sets `process.exitCode = 1`. The stack and `cause` are never printed: the stack is noise to a CLI user, and every error in `src/` that is thrown with a `cause` today (in `src/c3/recipeApplier.ts` and `src/c3/customAceIndex.ts`) already folds the cause's message into its own, and `regenerateAfterWrite`'s also carries the recovery hint, so nothing a user needs is lost. No verbose switch was asked for. A caller who needs them can reproduce through the library.
3. **Classification.**
   - *Handler errors* (thrown or rejected from a handler body, including `apply-op`'s `--param` and `--params-file` shape checks) render as the one `Error:` line, exit 1.
   - *Argument validation* (unknown argument, missing required, `choices`, `demandCommand`, `rename-symbol`'s `.check()`, `validate-addons`' `--skip-gate` `coerce`) keeps yargs' own usage output and message.
   - *Handler-printed rejections* keep their exact text: scaffold plan rejections, `apply-op`'s `Error: op "…" not found`, the addon not-found lines, `validate-project`'s bare `Could not read …` line (its reports still print), and `search-dsl`'s two-line `Invalid regex:` output.
   - *Findings exit codes* (`validate-project`, `validate-addons`, `scan-addon-usage`, `sync-addon-metadata`) are unchanged.
4. **The scaffold catches go.** `scaffold-layout` and `scaffold-sprite` lose their local try/catch; the guard renders the same output.
5. **`server` keeps `process.exit(1)`.** Its startup catch calls `reportCliError(err)` and then `process.exit(1)`, so it gains the `Error:` prefix. Setting `exitCode` alone is not enough there: `wireAllProjects()` creates the per-project source watchers (persistent `fs.watch` handles in `src/mcp/sourceWatcher.ts`'s `fsWatchFactory`, with no `persistent: false` and no `unref()`) before `server.connect(transport)`, so a failure after that point would leave the process running. No process-wide `uncaughtException` or `unhandledRejection` hooks are installed.
6. **A library message changes.** `renameSymbols` threw `"Error: replacement 'from' field must be non-empty"`; it now throws without the leading `Error: `, since the guard supplies the prefix. `recipeApplier` is barrel-exported, so library callers see the shorter message. This is a wording change, not a signature change.

## Rejected alternatives

- **Option A: explicit HOF at each call site (fallback).** 21 call-site edits, and new commands are covered only if someone remembers to wrap them; the only guard is a token-count proxy.
- **Option B: `.fail()` plus a top-level catch (rejected).** It re-implements yargs' default fail output (drifts silently on upgrade), depends on two internal routing facts, and errors thrown from `.fail` on the async path are silently swallowed.

Chosen: "Option C: guard every handler at registration (recommended)".

## Consequences

- Every subcommand, including ones added later, gets the same failure rendering without an edit at its call site. Test CE16 pins that a command registered after the patch is covered; tests CE1 to CE18 are in `test/cliErrors.test.ts`.
- **Option C patches a method on a third-party instance.** It relies on `command` being an overridable instance method whose fourth argument is the handler. A yargs upgrade that changes that signature breaks the guard, and CE16 is the row that notices.
- The `Error: ` prefix now also appears on `server` startup failures, and the empty-`from` message from `renameSymbols` no longer carries its own. Both are in the CHANGELOG.
- Stack and `cause` are unavailable from the CLI. Debugging a failure that the message does not explain means reproducing it through the library.
- Handler-printed rejections stay command-specific by design; the guard is for errors a handler did not already report.
