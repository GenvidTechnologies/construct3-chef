# Capture: agent auto-memory — local verification practice

**Captured:** 2026-08-16
**Origin:** `C:\Users\FabienNinoles\.claude\projects\C--repos-construct3-chef\memory\`
(Claude Code project-scoped auto-memory; machine-local, outside the repository,
not visible to a fresh clone or to other contributors)

**What this is:** a verbatim capture of five auto-memory entries covering how a
change is verified locally in construct3-chef. Selected because a grep over
`CLAUDE.md` and `docs/*.md` on the capture date found no record of the
validate-gate timing, the fresh-worktree bootstrap, or the mutating-smoke-on-
golden-fixture prohibition anywhere in the repository.

Captured exactly as found. Per `docs/wiki-schema.md`, this file is immutable: if
the memories change, re-capture as a new dated file rather than editing this one.

---

## `long-validate-commands-need-timeout.md`

```markdown
---
name: long-validate-commands-need-timeout
description: npm run lint / npm test each take ~1-2 min; give Bash a >=300s timeout
metadata:
  node_type: memory
  type: project
  originSessionId: e93df47d-2a09-4016-ae85-8dadb5cb5786
---

In construct3-chef, `npm run lint` (eslint + prettier `format:check` over `src/` **and** `test/`) and `npm test` (mocha+tsx, ~1250 tests) each take roughly 1–2 minutes. The default Bash-tool timeout is 120s, so a bare `npm run lint` or `npm test` can time out and force a wasted re-run.

**How to apply:** when running the validator gate (`npm run lint && npm run typecheck && npm test`, or any of its parts), pass an explicit Bash `timeout` of **≥ 300000 ms**. `typecheck` alone is fast; `lint` and `test` are the slow ones. Prefer running them as separate calls (each with the long timeout) over one chained command that's more likely to blow a shorter budget. Hit during #98 execution: a `npm run lint` timed out at 120s and had to be re-run at 300s. Relates to [[verification-bootstrap]].
```

## `verification-bootstrap.md`

```markdown
---
name: verification-bootstrap
description: "a fresh worktree has no node_modules; run `npm install` (alone) before any typecheck/test/lint — the old download-deps/Azure bootstrap is retired"
metadata:
  node_type: memory
  type: project
  originSessionId: 7ed4e867-33d8-437d-b3ac-7b1ba15f2080
---

A freshly created worktree starts with no `node_modules/`. Before running `npm run typecheck` / `npm test` / `npm run lint`, run **`npm install`** — that is now the only bootstrap step. (This repo uses **npm** with a committed `package-lock.json`; CI runs `npm ci`. It is NOT pnpm — an earlier version of this note said `pnpm install`, stale since the npm migration.)

The former private-tarball bootstrap (`scripts/download-deps.mjs` + `.packages-version` + `az login` / 1Password to fetch `c3source` and `genvid-mcp-utils` from Azure Blob into `.packages/*.tgz`) was **retired on 2026-05-30**: the two leaf packages went public on npm as `@genvid/c3source` (0.3.0) and `@genvid/mcp-utils` (0.2.0), so `npm install` resolves them from the registry like any other dependency. There is no longer a `download-deps` script, `.packages-version` file, or `.packages/` dir. See [[public-genvid-packages]].
```

## `no-mutating-smoke-on-golden-fixtures.md`

```markdown
---
name: no-mutating-smoke-on-golden-fixtures
description: Never smoke-test with mutating CLI/MCP commands against the golden-tested fixture; use validate-project or a temp copy
metadata:
  node_type: memory
  type: feedback
  originSessionId: 39e789c1-18b4-4a06-b81f-2ab6cdb5e999
---

When smoke-testing a code change, never run a **mutating** command (`sync-project`, `apply-recipe`, `clone-layout`, `generate`, workflows) against `test/fixtures/construct3-chef-sample/` — it's diffed byte-for-byte by the golden test (`test/c3/sampleProjectGolden.test.ts`) and is real C3-export data. Use the non-mutating `validate-project` (the dry-run variant of `sync-project`) for smoke tests, or copy the fixture to a temp dir and mutate the copy.

**Why:** on #52 I ran `sync-project` against the sample fixture as a smoke test. It happened to stay clean (the project was already in sync, so `runSync` wrote nothing) — but a mutating command on a golden fixture can silently rewrite committed `project.c3proj`/`extracted/` and break the golden diff (or worse, corrupt the fixture if it wasn't in sync).

**How to apply:** prefer `validate-project` to exercise read/report paths (it shares the same `reportImageDrift`/`runSync(dryRun)` code). If you must exercise the write path, `cpSync` the fixture to a tmp dir first. Always `git status -- test/fixtures/` after any fixture-adjacent command. Relatedly, avoid `cd`-ing into the fixture dir in Bash — the cwd persists and strands later `npx tsx src/cli.ts` runs; use absolute paths. See [[backlog-issues-track-shipped-work]].
```

## `fixture-regen-run-full-suite.md`

```markdown
---
name: fixture-regen-run-full-suite
description: "after a golden regen, run the FULL test suite — fixture-DSL-coupled asserts live outside the golden"
metadata:
  node_type: memory
  type: project
  originSessionId: 0fc0fbad-37f9-45c3-8b8b-d622cce9f055
---

After touching `test/fixtures/construct3-chef-sample/` at all — regenerating `extracted/` (the golden) **OR editing its source JSON** — run the **full** `npm test`, not just `sampleProjectGolden.test.ts`. Other tests assert against the fixture's generated DSL **and its raw content**, and break silently — the golden test passing is NOT sufficient. This is broader than golden-regen: any edit to the shared fixture can break a sibling test that reads it.

Two failure modes, both caught only by the full suite:
- **DSL line-number / content shift (#124):** adding two behavior `do:` lines above Event sheet 1's go-to-layout call shifted its DSL line 12→14; `sampleProjectGolden` went green after regen, but `navigationGraph.test.ts` (asserts the go-to-layout DSL `lineNumber`) stayed red — caught two tasks later. Known DSL-coupled tests: `navigationGraph.test.ts`, and the synthetic-input `scaffoldLayout.test.ts`/`navigationGraph` uistate-exclusion cases.
- **Real-fixture *content* assertions (#125):** F2 added `MyCompany_MyEffect` `effectTypes` to `Sprite2.json`/`TextFamily.json`; four `deep.equal` assertions in `projectObjects.test.ts` (P1, an EARLIER task, had hard-coded the pre-edit `effectTypes` values reading the real fixture) went red. The golden diff was **zero** (effectTypes feeds no generator), so *only* the content asserts broke — nothing DSL/line-number about it. When a prep step hard-codes assertions against real-fixture content, a later fixture-editing step must reconcile them.

**Why:** the golden diff, the DSL-line-number asserts, and the raw-content `deep.equal` asserts are all separate tests over the same fixture; a green golden hides a red sibling. A zero-diff golden is especially deceptive — it proves the read surface is stable while a content assertion elsewhere is broken. Cost a late catch during #124's F3→F4 and again on #125's F2 (4 P1 asserts).

**How to apply:** whenever a plan step touches `construct3-chef-sample` (regen OR source-JSON edit), gate on the full suite (or at least grep for tests referencing the changed fixture / field) — don't stop at the golden test. Relates to the golden-red-window gating pattern in [[c3addon-tooling-cluster]] and the real-vs-synthetic fixture divergence in [[addon-fixture-archive-gotcha]].
```

## `run-the-real-command-per-mode.md`

```markdown
---
name: run-the-real-command-per-mode
description: Green tests + a clean reviewer can both miss a user-visible defect in a flag combination no test happens to cover — run the real CLI once per mode
metadata:
  node_type: memory
  type: feedback
  originSessionId: 74b92660-5592-4075-a6c5-2419d7334c8e
  modified: 2026-08-06T16:11:33.168Z
---

On a dual-surface (CLI + MCP) command with mode flags, **actually run the real
command once in each mode** before calling it done. A full green suite is not
sufficient evidence that the output is correct.

Hit on #145 (`sync-addon-metadata`): the result type carried a single `dryRun`
boolean that was overloaded to mean two different things — "the caller asked for
a preview" and "this direction structurally never writes". The formatter emitted
`Nothing written (dry run).` off that flag alone, so running
`--direction package-from-manifest` *without* `--dry-run` told the operator it was
a dry run, implying a re-run without the flag would write. It never can: chef has
no `.c3addon` writer.

**Why nothing caught it:** every assertion on that trailing line happened to be
scoped to the *other* direction (`manifest-from-package`), so the suite was green,
1473 tests passed, and `gvt-dev:code-reviewer` reported no critical findings. The
defect lived in a direction × flag combination no test exercised. It surfaced in
about ten seconds of running the real binary.

**How to apply:** after wiring a CLI surface, run each mode/direction/flag
combination once and *read the output as a user would*. Watch specifically for a
single boolean that encodes two distinct meanings — that is the shape that
produces wrong wording while every test stays green. Related: [[fixture-regen-run-full-suite]]
(green golden isn't enough) and the vacuous-assertion trap in
[[c3addon-tooling-cluster]] — same family, different mechanism.
```
