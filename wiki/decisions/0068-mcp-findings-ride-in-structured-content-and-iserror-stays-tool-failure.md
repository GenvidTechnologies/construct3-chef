---
type: decision-record
title: "0068. MCP findings ride in structuredContent, and isError stays tool failure"
description: >-
  Five MCP tools whose CLI exits 1 on findings now declare an outputSchema of `{ clean, report }`. `clean` is true exactly when the CLI would exit 0 for the same inputs, and `report` repeats the text block, txId footer included. `isError` keeps meaning tool failure and carries no structuredContent. This refines ADR 0025 section 4 and gives MCP `validate-addons` a pass/fail signal
  ([#349](https://github.com/GenvidTechnologies/construct3-chef/issues/349))
tags: [decision, mcp, architecture]
status: stable
generated: { by: process:tech-writer, at: 2026-11-05T00:00:00Z }
---

# 0068. MCP findings ride in structuredContent, and isError stays tool failure

- **Status:** Accepted
- **Date:** 2026-11-05
- **Issue:** [#349](https://github.com/GenvidTechnologies/construct3-chef/issues/349). MCP `validate-project` returned a success result for a project the CLI exits 1 on, so an agent could not read pass or fail without parsing text.
- **Relates to:** ADR [0025](0025-stray-gating-is-cli-only-and-survives-a-manifest-failure.md) (section 4 decided that exit-code gating is CLI-only and that `isError` is reserved for tool failure), ADR [0038](0038-validate-addons-deny-list-family-gating.md) (`validate-addons` family gating and the `--skip-gate` flag), ADR [0065](0065-sync-withholds-removals-unless-pruning-is-requested.md) (withheld removals make `validate-project` exit 1), ADR [0017](0017-sync-addon-metadata-separate-mutation-command.md) (the "exit 1 means outstanding human work remains" policy).

## Context

Several CLI commands exit 1 on findings. Their MCP twins returned a success result with the same text. ADR 0025 section 4 decided that this stays so: findings go in the text block, and `isError` is reserved for a failed tool call. The cost is that an MCP caller has no pass/fail value to read. ADR 0065 left this open for `validate-project` as #349, and ADR 0038 and ADR 0025 both name the same gap on `validate-addons`.

The MCP specification (`https://modelcontextprotocol.io/specification/2025-06-18/server/tools`) gives a tool an `outputSchema` and a result a `structuredContent` object that must match it. That is a channel for a finding value that does not use `isError`.

**Observed in the SDK (1.29.0, `node_modules/@modelcontextprotocol/sdk/dist/esm`)**

- `server/mcp.js`, `validateToolOutput`: returns at once when the tool has no `outputSchema`, and returns at once when `result.isError` is set. Otherwise it throws `Output validation error` when `structuredContent` is missing, and again when it does not match the schema. The `tools/call` handler catches that throw and returns an `isError` result carrying only the error message. So a schema or payload slip on a success path drops the whole report.
- `client/index.js`, `callTool`: when the tool declares an `outputSchema`, it throws if the result has no `structuredContent` and is not `isError`. It validates `structuredContent` whenever it is present, `isError` results included. The client builds its validators only after `listTools()` has run.
- mcp-utils 0.12.0: `mcpContent(text, footer)` and `mcpError(...)` have no structured parameter. `withMcpErrors` returns a handler's success result unchanged, so a result built with `structuredContent` passes through it intact.

**Observed in Claude Code, undocumented, may change.** Claude Code 2.1.318 (headless `claude -p`, MCP SDK 1.29.0) was probed on 2026-11-04 by calling an MCP tool from a headless session and reading what reached the model. When a result carries `structuredContent`, the model sees only `structuredContent`; the text block is dropped, whether or not the tool declares an `outputSchema`. A text-only control, a result with no `structuredContent`, showed the model the text block. This is the reason `report` repeats the whole text block: an agent in that client reads the same text a text-only client reads.

**Observed 2026-11-05, same Claude Code version, headless `claude -p` against this change's server on temporary copies of the sample fixture**

1. `validate-project` on a drifted project: the model received `{"clean":false,"report":...}` with the txId in the report, and the result was not marked as an error.
2. `validate-project` on an unparseable manifest: the model received the `isError` result's text (`Could not parse`, the `[strays]` section, the txId) and no `clean`.
3. `scan-addon-usage` with an unknown addon: the `isError` text reached the model.

Runs 2 and 3 confirm that the text of an `isError` result reaches the model. That is the display assumption behind decision F1 below. Also observed: for a deferred tool, Claude Code appends a note that restates the tool's input schema to an `isError` result. The tool's own text arrives unchanged above it.

## Decision

Findings go in `structuredContent: { clean, report }`. `isError` means tool failure. This refines ADR 0025 section 4, which decided that `isError` is reserved for tool failure and that findings stay in the text block. The `isError` half stands. The findings-only-in-text half is replaced for the five tools below. It is not a supersession.

**The rule.** A tool whose CLI exits 1 on findings declares this `outputSchema`.

- `clean` is true exactly when the CLI would exit 0 for the same inputs the MCP tool exposes.
- `report` equals `content[0].text`, txId footer included.
- An `isError` result carries no `structuredContent`. So `structuredContent` is present if and only if `isError` is absent.

### Chosen options

- **P-A, payload `{ clean: boolean, report: string }`.** One invariant to test. The payload carries no root path and no random SID, so a byte comparison across runs is stable. Fields added later (for example for [#368](https://github.com/GenvidTechnologies/construct3-chef/issues/368) or [#344](https://github.com/GenvidTechnologies/construct3-chef/issues/344)) are additive.
- **C1, `content[0]` stays the human report, unchanged.** This deviates from the specification, which says a tool that returns structured content "SHOULD also return the serialized JSON in a TextContent block". That SHOULD exists for clients that do not read `structuredContent`. The human report serves those clients better than escaped JSON, and `report` already carries the same text, so either channel gives the full report. C1 also keeps true the tests that split the text on newlines or match it with a regex, and the rule in `wiki/architecture/mcp-architecture.md` that a result has one text content block.
- **F1, an `isError` result carries no `structuredContent`, and `mcpError(...)` is unchanged.** The server skips output validation on `isError`, and the client does not throw for an `isError` result without it. The failure paths that cannot carry a payload stay uniform: the unknown-`project` error from the registry, a throw caught by `withMcpErrors`, and SDK input-validation errors. The manifest-failure path of `validate-project` and its diagnostics (ADR 0025 section 7) are untouched.
- **N-A, one field name, `clean`, on every tool.** The tool-specific meaning lives in each tool's `.describe()` text.
- **U1, `scan-addon-usage` adopts, and without `from` it is always `clean: true`.** An `outputSchema` is per tool, so every success result must carry the payload. `true` is exactly the CLI's exit 0. The `clean` field's description says: "Without from it is always true: usage is reported, not judged."
- **S-A, `sync-addon-metadata` adopts.** After an apply, `clean` answers the question of ADR 0017's policy, whether outstanding human work remains, without a second preview call. The tool bumps the txId before it builds the report, so `clean` is evaluated on the result after the apply, and the footer carries the post-write txId.
- **B-A, a shared off-barrel builder, `src/mcp/structuredReport.ts`.** `cleanReportSchema` and `cleanReportContent` declare the field names once. `cleanReportContent` takes the text block that `mcpContent` builds and sets `report` from it, so the two cannot drift. Only `server.ts` imports the module, and `src/index.ts` exports nothing from `src/mcp/`.
- **G0, `validate-addons` gains no `skipGate` input.** `clean` gates all four families (metadata, integrity, package-consistency, lang), which equals the CLI without `--skip-gate`. Adding an optional `skip-gate` input later is additive.

### Scope

| Tool | `clean` is false when | CLI invocation it equals |
|---|---|---|
| `validate-project` | `project.c3proj` has drift against disk in the checked sections, withheld removals included. | `validate-project [--section s]` without `--fail-on-strays` |
| `validate-addons` | Any finding is reported, in any of the four families. The tool calls `countFatal(result.findings, [])`. | `validate-addons [--addon a]` without `--skip-gate` |
| `scan-addon-usage` | Only with `from`, and only when `blastRadiusAffected(result)`: at least one call site, expression reference or effect application site is affected. | `scan-addon-usage a [--from f]` |
| `preview-addon-metadata-sync` | `addonSyncLeavesWork(result)`: a blocked row, or a would-change row in a mode that wrote nothing. A preview never writes. | `sync-addon-metadata --direction d [--addon a] --dry-run` |
| `sync-addon-metadata` | The same predicate on the apply result. Under `manifest-from-package`, a blocked row. Under `package-from-manifest`, which never writes, a blocked row or a would-change row. | `sync-addon-metadata --direction d [--addon a]` |

The CLI uses the same predicates for its exit code: `countFatal`, `blastRadiusAffected` (`src/c3/addonAceUsage.ts`) and `addonSyncLeavesWork` (`src/c3/addonMetadataSync.ts`). The last two are new, behaviour-preserving extractions that the CLI now calls, so the exit code and `clean` cannot diverge.

**`validate-project` and `section`.** The tool gains an optional `section` input, drawn from the same `ALL_SECTION_KEYS` that the CLI's `--section` uses, so the two cannot drift. `clean` and the sync report are scoped to that section. Strays and image drift never affect `clean`, and `section` does not narrow them: they stay project-wide, as in the CLI. `--fail-on-strays` keeps no MCP counterpart (ADR 0025 section 4).

**Error-path change in `scan-addon-usage`.** An unresolvable `addon` or `from` now returns `isError: true`, with the same text as before. Before this change it returned a success result, while the CLI exits 1. An `outputSchema` forces the change: a success result without the payload would be replaced by `Output validation error` and the report would be lost.

## Compromise

Rejected options, with the reason for each.

- **P-B, add `txId`, counts of added, removed and withheld entries, `sections` and a stray count to the payload.** No consumer asks for them. A stray count next to `clean` invites gating on strays, against ADR 0025 section 4. A separate `txId` duplicates the footer, and a second channel can drift from the first.
- **P-C, the full `changes[]` list.** It carries random dry-run SIDs, duplicates the report, and grows without bound.
- **C2, serialized JSON in `content`.** JSON-escaped newlines break the tests that split the text or match it with a regex, and a text-only reader gets worse output. It would follow the specification's SHOULD, and that is the one cost of C1.
- **F2, put `{ clean: false, report: <error text> }` on the manifest failure.** It reuses `clean: false` for "not checked", so a failure would read as drift. It covers only the manifest-failure path: the other failure paths (the registry error, `withMcpErrors`, SDK input validation) cannot carry a payload, so the uniform rule would be lost. The client would also validate it, so a schema slip would raise a client exception.
- **`isError` on findings.** ADR 0025 section 4 reserves `isError` for tool failure, a user decision that this change keeps. Two further reasons: an `isError` result skips the SDK's output validation, and it reads to a client as a failed call, not as findings.
- **N-B, a name per tool (`inSync`, `consistent` and similar).** It gives five vocabularies for one rule and no shared schema.
- **U2, an optional `clean` on `scan-addon-usage`, absent without `from`.** It is a weaker schema, and an agent cannot tell "not judged" from "forgot".
- **S-B, leave `sync-addon-metadata` out.** It leaves the one gap that ADR 0017's policy defines, and the CLI already exits 1 on blocked rows.
- **H1, build the payload inline in each handler.** Five copies of the `report` derivation are five chances for the payload to stop equalling the text block.
- **B-B, a local function in `server.ts`.** It works, but `server.ts` is large, and the precedent of `src/mcp/txToken.ts` and `src/mcp/selfWrites.ts` puts MCP plumbing in its own module.
- **A `regStructured(` registration wrapper.** The README inventory parser in `test/readmeCommandInventory.test.ts` matches the literal `regP(` form, so each registration stays `regP("name", { ... })` with an `outputSchema` key in the config.
- **G1, add a `skipGate` input to `validate-addons`.** It would reverse the parameter decision of ADR 0038 and flip a pinned test. It is left open for later. The cost of G0: on a project with a lang backlog (the sample project is one), an agent reads `clean: false` on every call and must read the per-family lines in `report`. That is the [#220](https://github.com/GenvidTechnologies/construct3-chef/issues/220) problem, reproduced on MCP.

**Upstream.** mcp-utils' `mcpContent` has no structured parameter, so the local builder wraps it. An intent request to mcp-utils asks for an optional structured argument. No local code works around an upstream defect, so there is nothing to retire. The `{ clean, report }` policy stays local either way.

## Testing rule

The in-process `__getHandler` seam bypasses SDK output validation and SDK input validation. A handler-level row therefore cannot see a schema slip, and it cannot see an invalid `section` being refused.

Each tool with an `outputSchema` needs a row through a live `Client` over `InMemoryTransport.createLinkedPair()`, with `listTools()` called first so the client builds its validators. That includes input enums such as `section`. The rows are in the `MCP structured findings through the live SDK (#349)` describe of `test/mcp/structuredFindingsLive.test.ts`.

The evidence for the rule: a mutation that added a required field to the `outputSchema` turned every live row red (`isError: true`) while every handler-level row stayed green.

## Consequences

- **An agent reads pass or fail from `clean`** on five tools, without parsing text. A client that shows only `structuredContent` (Claude Code 2.1.318, observed) still reads the full report in `report`.
- **A schema or payload slip is a hard failure.** On a success path it turns the call into an `isError` "Output validation error" result and drops the report. The live-client rows are the guard.
- **The text block and `report` are one string.** A change to the text changes both, and the txId footer is in both.
- **Known edges.**
  - A manifest section that is missing from `project.c3proj` stays `clean: true` for `validate-project`.
  - `validate-addons` with "Checked 0 bundled addon(s): nothing to validate" is `clean: true`. It matches the CLI, which exits 0 there ([#311](https://github.com/GenvidTechnologies/construct3-chef/issues/311)): no package was checked and nothing was found. The text says so, so an empty run does not read as a pass.
  - `scan-addon-usage` without `from` is always `clean: true`.
- **`validate-project` has a new input, `section`,** and `scan-addon-usage` has a new `isError` path. Both go in the CHANGELOG.
- **The 2.1.318 behaviour is undocumented.** If a later Claude Code shows the text block next to `structuredContent`, `report` becomes a duplicate and is harmless.
