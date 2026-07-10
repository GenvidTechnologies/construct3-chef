# 0009. Addon aces.json/properties ↔ lang consistency check

- **Status:** Accepted
- **Date:** 2026-07-10
- **Issue:** [#98](https://github.com/GenvidTechnologies/construct3-chef/issues/98)

## Context

Issue #98 asks for a check that cross-validates an addon's `aces.json` (and plugin `properties`) against its `lang/*.json` files, so the "ACE/param/property language string missing" class of errors — which Construct only surfaces at addon-load time as an opaque editor error — fails locally in construct3-chef's CLI + MCP. It's part of the #100 c3addon-tooling umbrella and builds on the `addonReader` primitive from ADR 0008. The issue as filed proposed a new, singular `validate-addon` command.

## Decision

**Fold into the existing `validate-addons` command/tool rather than shipping the separate `validate-addon` command #98 named.** The near-identical singular/plural names would confuse — the issue itself flagged this. One `validate-addons` now reports both the existing package ↔ `project.c3proj`-manifest findings and the new addon-internal aces/properties ↔ lang findings, unified through the shared `AddonFinding` model + `formatAddonValidation` formatter. An optional `--addon <id|path>` argument (CLI) / `addon` input param (MCP) scopes a run to one addon and enables raw-source-tree validation.

**Lang-presence gate.** Folding means the new lang passes run against every discovered addon, including the existing `test/fixtures/addon-validate/` fixtures that ship no `lang/` directory. The lang check is gated on lang-file presence: an addon with no `lang/*.json` is skipped by the lang passes (not flagged), mirroring how the integrity check deliberately doesn't require `c3runtime`. This keeps the check additive and non-breaking, and lets the existing lang-less fixtures serve as a free regression pin. Defect coverage lives in a new isolated `test/fixtures/addon-validate-lang/` fixture root so the existing 8-package count assertions never move.

**Best-effort JavaScript parsing for the `properties` cross-check, with explicit fragility bounds.** Unlike ACEs (declared in JSON `aces.json`), plugin `properties` are declared in the editor-side `plugin.js` as JavaScript (`this._info.SetProperties([ new SDK.PluginProperty("<type>", "<id>", …) ])`) — there is no static JSON source. We parse property ids via a bounded, string-literal-aware balanced-parenthesis scan (no new JS-parser dependency, consistent with ADR 0008's dependency-conservative posture), extracting only plain string-literal ids (computed/template-literal ids are skipped, not guessed). The contract is "unparseable → skip, never false-positive": parse failures cause the check to under-report (a silent gap, safe) rather than over-report (false CI failures). The fragility is isolated to one small, replaceable `addonPropertyExtractor` module.

## Compromise

**Command surface — two options weighed:**

- **New `validate-addon` command (issue-as-filed, rejected)** — near-duplicate name of the existing `validate-addons`; two commands that both "validate an addon" but differ only by singular/plural is a confusing surface.
- **Fold into `validate-addons` (chosen)** — one entry point, scoped by an optional `--addon` argument for the single-addon/raw-source-tree case. More branching inside one formatter/finding model, in exchange for a single addon-validation command.

**Lang-check applicability — two options weighed:**

- **Require `lang/` on every discovered addon (rejected)** — would newly flag every lang-less fixture in `test/fixtures/addon-validate/`, breaking existing package-count assertions and conflating "no localization" with "broken localization."
- **Gate on lang-file presence (chosen)** — skip, don't flag, when `lang/` is absent; matches the integrity check's existing `c3runtime`-optional precedent.

**Properties source — two options weighed:**

- **Add a JS parser dependency for exact `plugin.js` parsing (rejected)** — heavier dependency footprint for one narrow extraction need, inconsistent with the ADR 0008 posture of minimal, purpose-fit dependencies.
- **Bounded string-literal-aware scan, skip-on-failure (chosen)** — no new dependency; accepts under-reporting on minified/unconventional `plugin.js` as the safe failure mode over false positives.

## Consequences

- `validate-addons` is the single addon-validation entry point; the whole aces/param/property-string class of load-time errors now fails locally instead of only at C3 editor load.
- `AddonFinding` gains new `lang-missing-ace` / `lang-missing-param` / `lang-missing-property` kinds, reported per locale across all `lang/*.json` files. Off the `src/index.ts` barrel — no new public API (see CLAUDE.md § "Public-API surface = the `src/index.ts` barrel").
- The `properties` check is inherently best-effort against minified or unconventional editor `plugin.js`; multi-object-class-per-addon plugin-key resolution falls back to a single-plugin heuristic (resolve `<pluginKey>` from `addon.json` `id`, fallback to the sole key under `text.plugins`/`text.effects`) — watch for addons this heuristic under-resolves as a possible future follow-up.
- Existing lang-less fixtures in `test/fixtures/addon-validate/` continue to pin the pre-#98 package-count behavior unchanged; new defect coverage lives in `test/fixtures/addon-validate-lang/`.
