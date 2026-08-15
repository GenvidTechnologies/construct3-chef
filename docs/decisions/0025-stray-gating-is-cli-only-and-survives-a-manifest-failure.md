# 0025. Stray-file gating is CLI-only, and `[strays]`/`[images]` survive a manifest failure

- **Status:** Accepted
- **Date:** 2026-08-15
- **Issue:** [#183](https://github.com/GenvidTechnologies/construct3-chef/issues/183), [#184](https://github.com/GenvidTechnologies/construct3-chef/issues/184)

## Context

Both issues are deferred follow-ups named directly in ADR
[0023](0023-stray-files-are-a-detection-only-report.md)'s Consequences: #183
(`--fail-on-strays`, an opt-in CI gate for `validate-project`) and #184
(report strays — and `[images]` — on a project whose `project.c3proj` will
not read or parse). They ship together on one branch,
`stray-gating-and-manifest-failure-report`, for the reason decision 9 below
gives: the decisions are coupled, not merely adjacent.

Two of ADR 0023's decisions are load-bearing here and are **not**
relitigated. Decision 3 ("Severity — informational, never failing") is
precisely what makes `--fail-on-strays` an opt-in flag rather than a change
to `reportStrayFiles`' existing behaviour — the report itself still affects
nothing by default. Decision 10 ("Manifest-independence — preserved by
construction, not exploited") named the exact capability #184 now spends:
`detectStrayFiles(rootDir)` and `detectImageDrift(rootDir)` both need no
`project.c3proj`, a property ADR 0023 paid for (one duplicate directory
walk) without using it. This record is where it gets used.

## Decision

Nine forks, in the order they constrain each other.

### 1. Stray-set access — widen `reportStrayFiles`'s return from `void` to `StrayFile[]`

The gate needs the detected set, not just its rendering. `reportStrayFiles`'
signature widens from `(rootDir, log) => void` to `(rootDir, log) =>
StrayFile[]`, returning the full detected set alongside the log side effect
it already had.

Rejected:

- **A third `detectStrayFiles` walk**, called separately by the new gating
  code. This adds a *second* barrel-exported symbol to avoid changing one —
  strictly more public API for the same capability — on top of a third
  directory walk.
- **Scraping the rendered `[strays]` log lines.** This couples control flow
  to a string format that existing tests pin byte-for-byte; a rendering
  change would silently break the gate.

The decisive evidence for widening over either alternative: **`git tag
--contains bdbf43c` is empty.** `reportStrayFiles` shipped in #185
(`bdbf43c`) and has never been in a published release — 23 commits are
unreleased since `v1.0.0`. No external consumer of the old `void` signature
can exist, so the usual "don't break a shipped symbol" objection to widening
a barrel-exported return type is moot here, not merely small. This is the
same class of decision ADR 0023's Consequences made for the symbol's *name*
— taken once, while the surface is still unpublished.

The widened return carries the **full** detected set, while the rendering
inside `reportStrayFiles` stays capped at `STRAY_REPORT_LIMIT` (ADR 0023
decision 8) — a gate has to fire on strays past the cap, even though the log
only shows the first 20.

### 2. Convert `validate-project`'s terminal `process.exit(1)` to `process.exitCode = 1`

In scope for #183 rather than a separate refactor: #184's manifest-failure
catch needs the CLI's `validate-project` handler to keep running past a
drift-related exit so both independent failure conditions (drift, strays)
can each set the exit code without one truncating the other — the two-
independent-statements shape decision 3 below describes depends on this
conversion.

Behaviour-preserving at this specific site: the handler is synchronous,
nothing follows the statement in the handler body, the yargs chain ends in a
plain synchronous `.parse()` with no `.fail()` handler, and no other
`process.exitCode` write in the file can run afterward in the same
invocation — `cli.ts` sets it at 14 other sites, but each lives in a
different command handler and only one command runs per CLI invocation.

**This record is the first written rationale for the `process.exitCode`
pattern already used at those 14 sites** (`validate-addons`,
`scan-addon-usage`, and others) — grepping `docs/` turns up no prior record
of why. Stated plainly: `process.exitCode` *composes* — two independent
failure conditions can each set it without one preempting the other, and
everything after the first detection still runs — whereas `process.exit`
*truncates execution*, which is exactly the property decision 3 needs to not
hold.

The measured evidence is recorded honestly, not oversold: a probe of both
forms through a real pipe with 1.43 MB of stdout showed **both** forms flush
their bytes intact on Windows (1,428,909 vs 1,428,935 bytes; the final line
was present in both). So the difference this conversion buys is
compositional, not a fix for byte truncation. Node's documented
`process.exit` truncation hazard is real but platform-dependent
(`process.stdout` writes are asynchronous for pipes on macOS) and was **not**
observed here — recorded as a latent hazard this conversion also retires as
a side effect, not as a finding this probe demonstrated.

### 3. Composition with manifest drift — either-sets-1, not distinct exit codes

`--fail-on-strays` composes with drift failure as two independent
statements, both `process.exitCode = 1`. A distinct code (say, 2 for strays)
was rejected: no site anywhere in this repo uses anything but 1 for a
failing exit, and CI consumers universally test `!= 0`, so a second code
would be invented API with no consumer. "Drift wins" was considered and
dismissed as not a real fork — once decision 2 lands, both statements are
observationally identical regardless of order.

On the #184 failure path, the flag is a **no-op in outcome**: the manifest
already failed to read/parse, which unconditionally sets `process.exitCode =
1` regardless of `--fail-on-strays`. This is stated here rather than tested,
because a test asserting "exit code is 1 either way" would be unfalsifiable
— indistinguishable from a test that asserts nothing.

### 4. No MCP counterpart for `--fail-on-strays`

Stated as a principle rather than left as an accident: **exit-code gating is
a CLI-only concern. The MCP server reports findings in the text block and
reserves `isError` for genuine tool failure.**

Reasons: (i) the mechanism would be a boolean input flipping an otherwise
*successful* response into `isError: true`, for which there is no
precedent — `server.ts` declares 15 `z.boolean()` tool params and none does
this; (ii) `isError` means *the tool call itself failed* — an agent-facing
signal that can trigger client retry/abort heuristics — whereas a stray set
is a **finding** the calling agent already has in the text block; (iii)
`--fail-on-strays` exists to gate CI, and CI invokes the CLI, not the MCP
server.

**Naming the pre-existing undocumented instance of this same asymmetry:**
MCP `validate-addons` (`src/mcp/server.ts:1151`) returns plain
`mcpContent(formatAddonValidation(result), txIdLine())` with no error
signal, for a finding set the CLI's `validate-addons` exits 1 on
unconditionally (any finding fails it — it has no severity concept). That
was already the repo's practice; this record is the first place it's
written down, with its reason.

### 5. `sync-project` is never gated

Not merely "it has no exit-code logic today." The decisive argument: **a
stray has no manifest position (ADR 0023's central fact), so `sync-project`
can never clear one.** A CI gate attached to a command that cannot satisfy
it by running is a bad gate — it would fail every run forever, or be
silently ignored. `validate-project` is the check command; a gate belongs
there and nowhere else.

### 6. #184 ships as a catch at the call site (Option A), not a new command or a documented gap

Two alternatives were considered and both declined.

**Option B — a new `list-strays`/`doctor` command** was the only route that
trips `test/readmeCommandInventory.test.ts`: it would require a new
`## CLI Overview` README row and bumping the stated `21 subcommands` count,
plus a name, a `docs/cli.md` section, a `docs/TOC.md` consideration, and its
own MCP decision — while duplicating `validate-project`'s job and pointing a
user hunting a broken project at a *different* command than the one that's
broken, which is the exact discoverability failure #184 exists to fix.

**Option A (chosen) — catch the manifest read/parse failure at
`validate-project`'s call site**, in both the CLI handler and the MCP
handler, and still report `[images]`/`[strays]` from there. Option A's main
stated objection largely dissolves on inspection: the three `runSync error
contract` rows in `test/syncC3Proj.test.ts` assert on `runSync` **directly**,
so a call-site catch around `validate-project`'s use of it leaves all three
intact verbatim. What genuinely changes is `validate-project`'s CLI-*surface*
error behaviour — deliberate, and covered by new tests (decision 8).

**Option C — document the gap as deliberate** stays on the record as the
fallback that would have been taken had review objected to changing the
error path. It was not chosen.

### 7. MCP gains the report on the failure path — `validate-project` only, response stays `isError: true`

The MCP `validate-project` tool catches the same manifest failure and still
runs `reportImageDrift`/`reportStrayFiles`, folding their output into the
error response's `extraLines`. The response **stays `isError: true`** — the
tool genuinely did fail (it could not do the drift check it exists to do),
and the manifest-independent diagnostics ride along as context, not as a
success payload.

Rejected: returning `mcpContent` (a success shape) on this failure path.
That would convert a real failure into a success response — the exact
inverse of decision 4's principle that `isError` means the tool call failed.

The unpaginated-block concern is bounded, using ADR 0023 decision 8's cap
unchanged: worst case 22 added lines (1 `[images]` line, plus up to 21 for
`[strays]` — 20 capped rows and a summary tail). ADR 0023 chose that cap for
precisely this reason (neither MCP tool paginates), and the reasoning
transfers to the failure path without modification.

MCP `sync-project` is untouched by this decision. It is a `MUTATE` tool; its
`runSync` call sits inside `watcher.suppress(...)`, so a thrown manifest
error inside that window means `watcher.bump()` never runs; and a mutating
command that partially reports on a failure it didn't attempt to recover
from is more confusing than one that simply refuses.

### 8. The clean one-line error message is a deliverable, not an incidental consequence

Today, a missing or unparseable `project.c3proj` escapes `validate-project`'s
synchronous yargs handler completely uncaught: the user sees a raw Node
stack trace on stderr and **nothing at all on stdout** — no drift lines, no
`[images]`, no `[strays]` — with exit code 1 supplied by Node's default
uncaught-exception handling, not by any catch in this repo.

After: `console.error(err.message)` on stderr, the `[images]`/`[strays]`
reports on stdout, exit 1. The message is `err.message` used **verbatim** —
never re-worded — so `src/c3/projectSync.ts`'s `runSync` remains the single
source of the `Could not read ${projectPath}` / `Could not parse
${projectPath} as JSON` wording (the two messages a coded filesystem error
vs. a JSON/shape error already produce there). This is called out as a
deliverable, not a side effect, because nothing else stops a future refactor
from reinstating the stack trace by accident.

### 9. One ADR, not two

The decisions are coupled, not merely co-scheduled: decision 1's widened
return is what decision 6's #184 catch consumes to render `[strays]` on the
failure path; decision 2's `process.exitCode` conversion is what decision
6's catch depends on to avoid a duplicate terminal exit; decision 4's
CLI-only principle governs both #183's gate and #184's MCP failure-path
choice (decision 7). Two records would cross-reference each other on nearly
every decision and split one rationale into two files that can't be read
independently.

## Also on the record

- **ADR 0023's decline of a `SyncResult`-widening route (its decision 1) is
  NOT reopened by decision 1 above.** That decline was specifically about
  avoiding "a permanent widening of the barrel-exported `SyncResult`" that
  every `runSync` caller (eight call sites) would carry. `reportStrayFiles`'
  widened return is a **different symbol**, with a six-site, all-discarding
  footprint (the four `[images]` surfaces plus two internal call sites) — not
  a type flowing out through `runSync`. Stated explicitly so a reader can't
  mistake decision 1 for a reversal of that earlier call.
- **A finding neither #183 nor #184 mentions:** `reportImageDrift` is
  manifest-independent too, verified structurally rather than assumed — it
  calls `detectImageDrift(rootDir)` directly, never reads
  `project.c3proj`, and already has its own internal try/catch that emits an
  `[images] error: …` line on failure rather than throwing. So the #184
  catch carries `[images]` alongside `[strays]` on the manifest-failure path
  at no extra implementation cost; both reporters were already independent
  of the thing that just failed.

## Compromise

Named rather than counted, per this repo's convention:

- **A third `detectStrayFiles` walk** (decision 1) — declined for adding a
  second barrel-exported symbol to avoid widening one, plus a third
  directory walk, in service of the same capability.
- **Scraping the rendered `[strays]` log** (decision 1) — declined because
  it couples the gate's control flow to a string format existing tests pin
  byte-for-byte.
- **A distinct exit code for strays** (decision 3) — declined for having no
  precedent anywhere in this repo and no CI consumer that would read it as
  anything but non-zero.
- **An MCP `--fail-on-strays` counterpart** (decision 4) — declined on the
  stated CLI-only-gating principle; `isError` is reserved for genuine tool
  failure, not for surfacing an opt-in finding threshold.
- **Gating `sync-project`** (decision 5) — declined because a stray has no
  manifest position, so `sync-project` can never satisfy a gate attached to
  it.
- **A new `list-strays`/`doctor` command** (decision 6, Option B) — declined
  for tripping the README command-inventory test and pointing users at a
  second command instead of fixing the one that's broken.
- **Documenting the manifest-failure gap as deliberate** (decision 6, Option
  C) — stays on record as the fallback that was not needed; Option A's
  objection dissolved once the `runSync error contract` tests were confirmed
  to assert on `runSync` directly.
- **Returning a success (`mcpContent`) response on the MCP failure path**
  (decision 7) — declined as the direct inverse of decision 4's `isError`
  principle: a real failure must not be shaped as a success just because it
  carries useful diagnostics.

## Consequences

- `reportStrayFiles`' widened return is additive for the two realistic
  consumer shapes in this repo — call-and-discard, and assignment to a
  `(root: string) => void`-typed callback slot (widening a return type is
  compatible with a narrower expected type) — and breaking only for two
  patterns with no in-tree instance and no possible external instance (`const
  v: void = reportStrayFiles(...)`; a `typeof reportStrayFiles`-annotated
  reimplementation). `STRAY_REPORT_LIMIT` stays module-private, as ADR 0023
  already decided.
- The `process.exitCode`-composes-vs-`process.exit`-truncates rationale is
  now written down once, for the 14 pre-existing sites as well as the new
  one — a future reviewer doesn't have to re-derive it from the code alone.
- The CLI/MCP dual-surface rule now has one documented, principled
  deviation (`validate-addons`'s MCP tool never fails on findings the CLI
  fails on) plus a named reason no future MCP tool should add a second
  instance without revisiting this record first.
- This closes both follow-ups ADR 0023's Consequences left open — #183 and
  #184 — completing the pair that ADR left explicitly unfinished.
