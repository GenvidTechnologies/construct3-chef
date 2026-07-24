# Documentation Index

<!--
Genvid plugin skills consult this index to find this project's docs.
Each entry is a one-line description. See CLAUDE.md for the high-level
map (§ "Where to read more").
-->

## This tool's usage

- `recipe-reference.md` — all event-sheet + layout + workflow recipe ops, SID addressing, builder shorthands, and the numbered recipe gotchas/bugs (read before touching the recipe interpreter/validator)
- `generators.md` — the 6 generators, `extracted/` output format, cross-referencing, localVars matching
- `cli.md` — full CLI flag documentation for every subcommand except the addon-tooling cluster
- `cli-addons.md` — CLI flag documentation for the addon-tooling commands (`read-addon`, `validate-addons`, `list-addons`, `diff-addon-aces`, `scan-addon-usage`), split out of `cli.md` as that cluster grows
- `ops.md` — user-defined ops: op file format, param types, substitution rules, MCP (`list-ops` / `op-<name>` / hot reload) and CLI (`list-ops` / `apply-op`) surfaces, and the `ops.dir` / `ops.watch` config keys

## Process & contracts

- `issue-triage.md` — backlog-grooming conventions consumed by `/gvt-dev:triage-issues` (types, `priority/*` + `area:*` labels, required fields, split/duplicate/dependency policy, `gh` mutation recipes); pairs with the `bugTracker` block in `.gvt-agent.json`

## Architecture & design rationale

- `mcp-architecture.md` — MCP server design (stdio transport, file-based model, txId/extractedDirty/watcher concurrency, Logger/ReadWriteLock decisions, security posture, SDK research, prior-art comparison)
- `prior-art-construct3-mcp.md` — imported reference/design record from the originating monorepo

## Decision Records

_Numbered chronologically by when the decision landed (earliest first); 0001–0005 trace to the 2026-04-03 initial release, ordered by dependency._

- `decisions/0001-two-surface-data-model.md` — source JSON as write surface + committed `extracted/` as read surface; rejected direct-edit and on-demand-only alternatives
- `decisions/0002-sid-based-node-addressing.md` — SID-based recipe targeting over positional/JSON-path addressing; the `indexInParent` staleness rationale (gotcha #34)
- `decisions/0003-recipe-pipeline-pure-interpreter-vs-io-applier.md` — `recipeInterpreter.ts` (pure, no I/O) split from `recipeApplier.ts` (orchestrator with I/O); two pre-write validation chokepoints (`assertEditorValid`, `validateInsertedCustomActions`)
- `decisions/0004-dual-surface-shared-library-and-formatters.md` — CLI + MCP as thin wrappers over `src/c3/`; shared formatters keep outputs byte-identical across both surfaces
- `decisions/0005-mcp-server-optimistic-concurrency-model.md` — `txId` optimistic concurrency + `extractedDirty` staleness flag + `ReadWriteLock`; rejected locks-only and no-watcher alternatives
- `decisions/0006-upstream-ownership-boundary-and-adoption-posture.md` — traversal/discovery/domain-facts to `c3source`, MCP/config plumbing to `mcp-utils`, rendering local; young-package adoption posture and the forced-partial-fit anti-pattern
- `decisions/0007-mcp-server-root-resolution-and-c3project-adoption.md` — MCP root resolution via mcp-utils `resolveRootFolder` (env/discovery/cwd precedence) and hybrid C3Project handle adoption; rejected alternatives and deliberate non-adoptions ([#94](https://github.com/genvid-holdings/construct3-chef/issues/94))
- `decisions/0008-addon-reader-hybrid-sourcing.md` — shared addon reader prefers extracted dir, falls back to reading the `.c3addon` zip archive directly; parser-only sharing with `aceRegistry`, off-barrel placement, `fflate` for sync zip reads ([#106](https://github.com/GenvidTechnologies/construct3-chef/issues/106), part of the #100 c3addon-tooling umbrella)
- `decisions/0009-addon-lang-consistency-check.md` — aces.json/properties ↔ lang/*.json cross-validation folded into `validate-addons` (not a separate `validate-addon` command); lang check gated on `lang/` presence; best-effort string-literal scan for JS-declared plugin `properties` ([#98](https://github.com/GenvidTechnologies/construct3-chef/issues/98), part of the #100 c3addon-tooling umbrella)
- `decisions/0010-scan-addon-usage-plugins-only-v1.md` — `scan-addon-usage` scans plugin ACE call sites in event sheets only; behavior/effect/expression usage split into follow-ups (#123/#124/#125); `readProjectObjects`/`ObjectDefn` shared seam; blast-radius match-set widening for dangling calls to removed ACEs ([#110](https://github.com/GenvidTechnologies/construct3-chef/issues/110), part of the #100 c3addon-tooling umbrella)
- `decisions/0011-scan-addon-usage-behavior-support.md` — `scan-addon-usage` extended to behavior addons via a `UsageMatcher` seam; `behaviorTypes[]`-keyed presence; the family-member call-site attribution rule; built-in behaviors (Timer, Persist) unscannable by id; the prerequisite BOM-stripping fix in `addonReader.ts` ([#124](https://github.com/GenvidTechnologies/construct3-chef/issues/124), part of the #100 c3addon-tooling umbrella)
- `decisions/0012-scan-addon-usage-effect-support.md` — `scan-addon-usage` extended to effect addons via a dedicated `scanEffectUsage` path (not a `UsageMatcher` extension, course-correcting ADR 0011's prediction); the four-site presence model (object type/family/layer/layout); presence-only, `--from` blast = every application site ([#125](https://github.com/GenvidTechnologies/construct3-chef/issues/125), part of the #100 c3addon-tooling umbrella)
- `decisions/0013-canonical-sample-fixture-consumption.md` — chef seeded the new canonical `GenvidTechnologies/construct3-sample` fixture repo from its own in-tree fixture (prototype/superset consumer); the submodule/prep-script consumption mechanism is recorded canonically in that repo's own ADR 0001, not duplicated here; chef's own migration onto the submodule stays open ([#130](https://github.com/GenvidTechnologies/construct3-chef/issues/130))
- `decisions/0014-adopt-c3source-addon-domain-layer.md` — partial adoption of c3source 1.8.0's `.c3addon` domain layer: adopted `stripBom`/`aceIdentity`/`C3ADDON_EXTENSION` + a new `readAddonAcesModel` (`DiscoveredAddon → AcesModel`) seam for #123; the bulk of the local `addon*` layer stays local on per-module shape-fit grounds (hybrid reader, `AceEntry` order/tolerance, tolerant metadata/manifest/objectType parses vs strict upstream) ([#136](https://github.com/GenvidTechnologies/construct3-chef/issues/136), part of the #100 c3addon-tooling umbrella)
- `decisions/0015-scan-addon-usage-expression-support.md` — `scan-addon-usage` extended to event-sheet expression usage (`Object.expr`/`Object.Behavior.expr` in parameter strings) via a parallel `expressionSites` collection + a `UsageMatcher.matchExpression` seam extension (fits, unlike effects in ADR 0012) + a distinct `expressionSiteCount`; resolves through c3source `extractExpressionReferences`/`findExpression` over the `readAddonAcesModel` seam, with blast-mode model widening for dangling removed-expression references — closes the last child of the #100 umbrella ([#123](https://github.com/GenvidTechnologies/construct3-chef/issues/123))

## C3 platform reference (the *why* behind the gotchas)

C3 platform reference (event-sheet & layout JSON structure, the scripting API,
the TS async/concurrency model) now lives in the **genvid-c3** Claude Code
plugin at `${CLAUDE_PLUGIN_ROOT}/docs/c3/*`. construct3-chef owns the *tooling*
docs above; the plugin owns the *platform* knowledge.
