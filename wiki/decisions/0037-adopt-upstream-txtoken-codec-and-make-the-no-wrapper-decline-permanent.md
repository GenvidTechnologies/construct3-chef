---
type: decision-record
title: "0037. Adopt upstream's txToken codec; the no-wrapper decline becomes permanent"
description: >-
  Amends ADR 0036: mcp-utils#25 shipped in `@genvidtech/mcp-utils@0.10.0` as a
  discriminated `{ok:true,...} | {ok:false,reason}` result, closing 0036's
  first decline. `src/mcp/txToken.ts` now imports upstream's
  `formatTxToken`/`parseTxToken` rather than owning the codec; chef keeps only
  `compareTxToken` (comparison policy) and a new `renderParseFailure` (client-
  facing rendering), parameterized on the whole token rather than its split
  halves so re-deriving upstream's split point never re-enters chef. Four
  input classes are now rejected that weren't before; only one
  (`"alpha:05"`) is a disposition change, the other three are reworded
  rejections. Closes #221 (silent counter truncation). 0036's second decline
  (a non-throwing local `format` wrapper) is upgraded from deferred to
  permanent — both throw vectors (id, counter) are structurally/contractually
  unreachable in production
  ([#217](https://github.com/GenvidTechnologies/construct3-chef/issues/217))
tags: [decision, architecture, mcp, upstream-adoption]
status: stable
generated: { by: process:tech-writer, at: 2026-09-15T00:00:00Z }
---

# 0037. Adopt upstream's txToken codec; the no-wrapper decline becomes permanent

- **Status:** Accepted
- **Date:** 2026-09-15
- **Issue:** [#217](https://github.com/GenvidTechnologies/construct3-chef/issues/217) (the other half — this record closes it)

## Context

ADR [0036](0036-project-id-guard-uses-the-upstream-wire-format-rule.md)
shipped the project-id guard half of #217 and recorded two declines. The
first — adopting upstream's txToken codec — was gated on
[mcp-utils#25](https://github.com/GenvidTechnologies/mcp-utils/issues/25),
filed because upstream's `parseTxToken` collapsed every parse failure to a
bare `null`, discarding the reason chef's own three-template parser
preserved. mcp-utils#25 is now **closed**: `@genvidtech/mcp-utils@0.10.0`
ships `parseTxToken` returning a discriminated result —
`{ ok: true, projectId, n } | { ok: false, reason }` — with a
`TxTokenParseFailure` union of five members: `not-a-string`, `no-separator`,
`invalid-project-id`, `invalid-counter-shape`, `counter-out-of-range`.

This record amends 0036. It does not re-decide the project-id guard 0036
already shipped (`676f6e6`).

## Decision

**`src/mcp/txToken.ts` no longer owns the codec.** It re-exports upstream's
`formatTxToken` and imports upstream's `parseTxToken` directly; the module
keeps only `compareTxToken` (the comparison policy every mutate tool's
optimistic-concurrency check performs) and a new `renderParseFailure`
(chef's client-facing wording over upstream's `reason`).

### The renderer rule

Upstream's failure result carries only `reason` — never the token's split
halves. Chef's retired local parser split the token itself, so a wrapper
that wanted to keep interpolating "the id half" or "the counter half" into
its message would have to re-split the token locally, which means
re-deriving upstream's split point (first `:`, not chef's retired last `:`)
inside chef — reopening the exact drift channel this adoption exists to
close: the accept set would again live in two places, and the two would
disagree the next time upstream changed it with no version signal.

So `renderParseFailure(token: string, reason: TxTokenParseFailure): string`
takes the **whole token** and the **reason alone**. Nothing is lost by this:
every rendered message already interpolates the whole token, which contains
both halves verbatim (`'alpha:05'` names both the id and the counter without
chef ever indexing into the string).

### The reason -> message mapping

Upstream's five `TxTokenParseFailure` members render through chef's own
wording (`renderParseFailure` in `src/mcp/txToken.ts`). `not-a-string` and
`no-separator` share one message — `not-a-string` is unreachable from the
MCP boundary today (every txId-accepting schema is `z.string().optional()`),
but it is a union member and the switch is exhaustive, so it is handled
rather than assumed away.

**Two messages are reworded because the retired ones were factually wrong**,
not merely restyled:

- The old `missing project id before ':'` was wrong for an input like
  `"al pha:5"` — the id is *present*, it is *invalid* (contains whitespace).
  Upstream's `invalid-project-id` reason, and chef's rendering of it, name
  the actual defect.
- The old `is not a non-negative integer` was wrong for `"alpha:05"` — `05`
  *is* a non-negative integer; what it is not is a **canonical** one
  (leading zeros aren't a canonical digit-string representation). Upstream's
  `invalid-counter-shape` reason names that precisely.

### The accept-set narrowing

Four input classes chef's retired parser accepted are now rejected. Named,
not counted, per `CLAUDE.md`'s standing rule on prose counts:

| Input | chef's retired parser | upstream `parseTxToken` (adopted) |
|---|---|---|
| `"alpha:5:6"` | split at the **last** `:` -> `{alpha:5, n:6}` | split at the **first** `:` -> rejects (invalid counter shape, `"5:6"`) |
| `"alpha:05"` | accepted, `n = 5` | rejected — leading zeros aren't canonical |
| `"al pha:5"` | accepted, `{id: "al pha", n: 5}` — the parser never validated the id half | rejected (`invalid-project-id`) |
| `"alpha:9007199254740993"` | accepted, silently truncated to `9007199254740992` | rejected (`counter-out-of-range`) |

**Keep the two levels apart when reading that table: it describes the
*parser*, and the parser is not the boundary.** All four rows were accepted
by the retired `parseTxToken`; three of them were then rejected downstream
by `compareTxToken`, which is what a caller actually sees. Only
`"alpha:05"` survived both.

So at the MCP boundary, **only the second row is a disposition change.**
Measured against `ctx.id = "alpha"`, `ctx.watcher.txId = 5`:
`compareTxToken(ctx, "alpha:05")` returned `null` — it **passed**. The other
three were already rejections *at the boundary*, though for reasons that
have now changed: `"alpha:5:6"` and `"al pha:5"` failed the id comparison
(having parsed to ids of `alpha:5` and `al pha` respectively), and the
overflowing counter failed the counter comparison after truncation. What
changed for those three is the wording and the reason, not whether the call
was allowed through.

That distinction is load-bearing for anyone assessing this change's blast
radius: reading the parser column as if it were the boundary would suggest
three behavioural breaks where there is one.

### The wording change is an improvement on the already-rejecting paths, not a regression

`"al pha:5"` previously produced:

> ``txId 'al pha:5' is for project 'al pha' but this call targets project
> 'alpha'``

— naming a project, `al pha`, that **cannot exist**: `ProjectRegistry.add`
has guarded every id with `isValidProjectId` since ADR 0036 (`676f6e6`), so
no registry can ever hold a project called `al pha`. The old message sent a
caller hunting for a project that no registry can hold. The new
`invalid-project-id` rendering names the real defect (whitespace in the id
half) instead.

### Closes #221 (silent counter truncation)

`parseTxToken("alpha:9007199254740993")` on the retired local parser
returned `{ id: "alpha", counter: 9007199254740992 }` — silently truncated
at `Number.MAX_SAFE_INTEGER`. The detail that made this hard to notice: the
*rejection* the truncated value went on to produce elsewhere echoed the
**original, untruncated** token back in its own error text (e.g.
`expected alpha:9007199254740997, got alpha:5`) — so even a caller reading
the error message never saw the truncated value, only the string it was
truncated from. 0036's finding that this truncation could never produce a
**false accept** (truncation only bites above 2^53, real counters stay
small, so a truncated value can never coincide with a live counter) still
holds and carries forward unchanged; adopting upstream's
`counter-out-of-range` check closes the gap for free rather than
demonstrating it was ever exploitable.

## No-wrapper decline, made permanent

0036 deferred a non-throwing local `format` wrapper "for now," reasoning
that upstream's `formatTxToken` throws `TypeError` on an invalid id, and
that the codec swap this record performs would make that throw reachable
again at the emission sites (`txIdLine`, `get-state`).

That framing named only the id vector. There are **two**, independent:

- **id** — unreachable *structurally*. `ProjectRegistry`'s context map has
  exactly one write path, `add`, and `add` throws unless
  `isValidProjectId(ctx.id)` holds. Every `ProjectContext` reaching an
  emission site arrives through `ProjectRegistry.resolve()`, so its `id` was
  already validated at `add` time — there is no code path that constructs a
  context with an invalid id and hands it to a handler.
- **counter** — unreachable *in production*, resting on an upstream
  contract rather than a chef-local guarantee. `OptimisticWatcher`
  initializes `_txId` to `0` and has exactly one increment site (`bump()`),
  so `ctx.watcher.txId` is always a non-negative safe integer. This is
  **upstream's** invariant, not chef's — see the next-bump check in
  `wiki/process/leaf-dependency-ledger.md`'s new `### 0.10.0` entry, which
  records it as something to re-check rather than something proven here. If
  `OptimisticWatcher.txId` ever became externally seedable or settable, the
  emission path could throw again.

**Why no wrapper ships.** A non-throwing wrapper here would be untestable
defensive code: exercising it requires constructing a `ProjectContext` whose
id the registry structurally forbids constructing. The obvious test for it
is a tautology — `if (add accepts) expect(format not to throw)` is true by
construction once both call the same `isValidProjectId`, which is exactly
the mistake 0036's own R4 correction (see [#217](
https://github.com/GenvidTechnologies/construct3-chef/issues/217)) had to
fix once already.

What ships instead: a comment at both emission sites in `src/mcp/server.ts`
(`txIdLine` and `get-state`'s inline literal) naming both invariants and
the files that hold them, plus a per-input disposition table test
(`test/mcp/txToken.test.ts`, "R10: `formatTxToken` throws exactly where
`ProjectRegistry.add` would already have rejected") that asserts **both**
columns — `add`'s admit/reject and `formatTxToken`'s throw/no-throw —
unconditionally for every row, rather than a conditional that only checks
the row it happens to fall into. Mutation-proved: reverting `add`'s guard to
the pre-#223 `ctx.id.includes(":")` predicate takes three rows red
(`"al pha"`, `"al\tpha"`, `""`).

## Consequences

- **`src/mcp/txToken.ts`'s import line in `server.ts` is unchanged.**
  `server.ts` still imports `compareTxToken`/`formatTxToken` from
  `./txToken.js`; only what that module re-exports vs. defines locally
  moved. No call site elsewhere in the repo needed to change.
- **Breaking narrowing, small blast radius.** A caller that was minting
  `"alpha:05"`-shaped tokens by hand (leading zeros) now gets a rejection
  instead of a silent accept. No code path in this repo formats a token with
  leading zeros — `formatTxToken` always emits the canonical form — so this
  narrows only a hand-constructed or third-party-minted token, not anything
  chef itself produces.
- **#217 is fully closed.** Both halves — the id guard (0036) and the codec
  adoption (this record) — have shipped.
- **`wiki/process/leaf-dependency-ledger.md`'s 0.9.0 entry's "Next-bump
  check"** ("check whether mcp-utils#25 landed") is answered by the new
  `### 0.10.0` entry in that ledger.

## Related

- ADR [0036](0036-project-id-guard-uses-the-upstream-wire-format-rule.md) —
  the project-id guard half of #217; this record amends it, resolving its
  first decline and upgrading its second to permanent.
- ADR [0034](0034-mcp-server-multi-project-support.md) — introduced the
  composite `<projectId>:<counter>` txId format and `txToken.ts`; its txId
  bullet now carries a pointer to this record for the codec-ownership
  clause.
- ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) — the
  upstream-ownership boundary and "request the right shape, wait" precedent
  both 0036's first decline and this record's resolution of it follow.
- ADR [0005](0005-mcp-server-optimistic-concurrency-model.md) (**this
  repo's** ADR 0005 — the optimistic-concurrency check the token serves).
  ⚠️ Not to be confused with `@genvidtech/mcp-utils`' **identically-numbered**
  `wiki/decisions/0005-tx-token-wire-format.md`, a different record in a
  different repository, which is the one upstream's `txToken` module
  docstring cites. The shared number is precisely what makes this citation
  treacherous: matching on "ADR 0005" confirms nothing, so always name the
  repository. An earlier record on #217 paraphrased upstream's citation as
  chef's own, and a dead-link repair then pointed it at chef's real 0005 —
  making the link resolve while making the claim more wrong.
- [`wiki/process/leaf-dependency-ledger.md`](../process/leaf-dependency-ledger.md)
  — the new `### 0.10.0` entry, which records the bump as real (not
  adoption-only) and carries this record's `OptimisticWatcher.txId`
  next-bump check.
