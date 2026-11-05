---
type: decision-record
title: "0067. Scaffold and objectType names follow C3's name rules"
description: >-
  C3 identifies a layout by its JSON `name`, and object types and families share one object-class name namespace. `scaffold-layout` now refuses a `name` that differs from the output file name and a JSON-name clash with an existing layout. `scaffold-sprite` and recipe objectTypes CREATE refuse a name that matches a family, a C3-reserved word, or a name C3 would rewrite. The rules are a local bridge, `src/c3/c3NameRules.ts`, until c3source exports them
  ([#260](https://github.com/GenvidTechnologies/construct3-chef/issues/260))
tags: [decision, scaffold, recipe, c3-domain]
status: stable
generated: { by: process:tech-writer, at: 2026-11-04T00:00:00Z }
---

# 0067. Scaffold and objectType names follow C3's name rules

- **Status:** Accepted. The local bridge is retired onto c3source 4.0.0 (see Amendment, 2026-11-05).
- **Date:** 2026-11-04
- **Issues:** [#260](https://github.com/GenvidTechnologies/construct3-chef/issues/260). Upstream request: [c3source#123](https://github.com/GenvidTechnologies/c3source/issues/123). Follow-ups: [#365](https://github.com/GenvidTechnologies/construct3-chef/issues/365), [#366](https://github.com/GenvidTechnologies/construct3-chef/issues/366), [#367](https://github.com/GenvidTechnologies/construct3-chef/issues/367), [#368](https://github.com/GenvidTechnologies/construct3-chef/issues/368), [#369](https://github.com/GenvidTechnologies/construct3-chef/issues/369), [claude-code-plugin-gvt-construct3#181](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-construct3/issues/181).
- **Relates to:** ADR [0006](0006-upstream-ownership-boundary-and-adoption-posture.md) (upstream ownership, the "user chooses not to wait" bridge), ADR [0044](0044-scaffold-tools-refuse-existing-targets.md) (scaffold refusals), ADR [0046](0046-recipe-and-scaffold-paths-have-one-canonical-case-insensitive-identity.md) (case-insensitive identity), ADR [0059](0059-recipe-objecttypes-create-uses-the-objecttype-identity.md) (recipe CREATE identity, the shared helper), ADR [0060](0060-scaffold-sprite-shares-the-objecttype-name-rule.md) (the shared objectType name rule), ADR [0064](0064-windows-reserved-device-names-are-refused-in-every-write-target-segment.md) (device names).

## Context

ADR 0044 made `scaffold-layout` and `scaffold-sprite` refuse an existing target, and ADR 0046 made the name match ignore letter case. Two gaps were left, and one question blocked them: which name does C3 treat as a layout's identity, and do object types and families share a namespace?

Both questions are settled from the C3 editor bundle, release r495-2. The files `projectResources.js` (sha256 `e0180c2a41e4f8103e2a6b5a5ab6e8be7eb3d1e97e331b2b18de2969d60b7b43`) and `main.js` (sha256 `18c7a7cee194779da60deba01052a74ae57b8c038eadd0041932ced68794d10c`) were read and never run. Both hashes match the captures committed in c3source (`raw/issue-95-empty-stem-evidence-2026-10-27.md`). Offsets below are positions in those files.

**Observed in the bundle**

- **Layout identity is the JSON `name`.** The layout loader `fon` (`projectResources.js` @544601) reads `folder + manifestName + ".json"`, and `BO(json)` then sets the name from `json.name` through the setter `k` (@534039). Nothing compares the two. The needle `unexpected layout name` has no hits, whereas the objectType and family loaders do check their names against the manifest.
- **Layout names are unique, letter case ignored.** The setter `k` and the folder add `eL` (@549754) throw `layout name '…' already used`. The lookup `HU` (@819035) and `main.js` `hM` compare with `normalize().toLowerCase()`.
- **Object types and families share one namespace, letter case ignored.** Both classes extend `self.HF`. Its constructor (@55966) throws `object class name '…' already used` through `lU` (@825411). The registration `dE` (@807690) uses the same lowercased map.
- **Object-class name rules.** The normalizer `nit` (@57585) applies NFC (`s.normalize()`), uppercases the character after a space, drops whitespace (`hRi`, `main.js` @213447) and the punctuation set `rt` (`main.js` @223683, plus a literal set), strips a leading `_`, and empties an all-digit name. The reserved check `jUt` (@57971) refuses device names, `self`, `true`, `false` and `system`, and names matched by the System plugin's ACE lookup `tfs`. The check is skipped when `cl()` is true, and `System` itself is exempt.
- **Layout-name rule `rRi`** (`main.js` @84014, constants @83721): not empty; fewer than 200 code points after NFC; none of `\ / : * ? " < > | ~`; first and last character neither `.` nor `hRi` whitespace; not a device name. The layout setter `k` first passes the name through `aRi` (`main.js`), which applies NFC, removes every forbidden character, trims leading and trailing `.` and `hRi` whitespace, and cuts the name to 200 code points; only then does it check `rRi`. So a forbidden character or an edge dot or space is silently removed when the editor loads the layout, while a name of 200 or more code points or a device name throws. Chef refuses all of these: a name the editor would rewrite gets a second identity, as with the object-class normalizer.
- **c3source 3.1.0 exports no name validator.** No export matches `objectClassName|layoutName|itemNameIssue|isValid[A-Za-z]*Name|NameIssue|reservedObject`, letter case ignored.

**Inferred, not run**

- A layout whose unique JSON `name` differs from its file name is renamed on save to `folder + name + ".json"`, which is c3source's audited save rule.
- `cl()` is the "project is loading" flag. The reserved check then applies to create and rename in the editor, not to project load.
- `tfs` covers the System plugin's expression names. That list was not enumerated.

**Not traced:** `tfs` ([#365](https://github.com/GenvidTechnologies/construct3-chef/issues/365)); releases r379 and r402 ([#369](https://github.com/GenvidTechnologies/construct3-chef/issues/369)); the manifest the editor writes after a rename on save; the editor UI on a duplicate-name throw.

Inside chef, a layout whose JSON `name` differs from its file name splits across two identities. Sync registers the file name. The read surface (`# <name>` headers, `template-scope.txt`, the navigation graph) keys on the JSON `name`.

## Decision

### Layout identity (R1)

Option A, refuse a mismatch (recommended). `planLayoutScaffold` returns an `invalid-name` rejection when `name` differs from the output file stem. The comparison is exact, letter case included, because C3 saves the layout to `folder + name + ".json"`. It runs after the conflict check and before the registry check. The message names the resolved project-relative path, never the caller's raw argument.

Rejected alternatives:

- Option B, make `name` optional and default it to the file name (alternative). It can be added later without breaking anything, so it is not recommended now.
- Option C, take the output file name from `name` (rejected). It is a breaking change to a public input.
- Option D, ignore `name` and always use the file name (rejected). It is a silent behaviour change.

### Layout JSON names (R2)

`findLayoutScaffoldConflicts` also reads each existing layout's JSON `name` and refuses a new layout whose name equals it, letter case ignored (reason `layout-json-name`). Both identities of an existing layout take part. An unreadable layout, or one whose `name` is not a string, takes part through its file name only and never throws, so a malformed layout elsewhere does not block a scaffold.

### One object-class identity (R3, R4)

Option F1, one combined object-class identity (recommended). `decideObjectClassCreate` in `src/c3/objectTypeIdentity.ts` decides over a listing of `objectTypes/` and `families/`. It skips only when there is exactly one match, of the same kind, at the entry's own target path. Otherwise it refuses with every path. `decideObjectTypeCreate` calls it with kind `objectType`, and the family create of [#304](https://github.com/GenvidTechnologies/construct3-chef/issues/304) reuses it with kind `family`.

- `findSpriteScaffoldConflicts` takes the families directory as a required parameter and adds the reason `family-name`. `scaffold-sprite` on the CLI and MCP passes it.
- Recipe CREATE builds the same listing from the project's families, so dry-run, `--preview`, `validate-recipe` and apply refuse identically. A missing `families/` is an empty listing.
- `--source` and `addInstVars` resolution stay objectTypes-only.

Rejected: Option F2, a separate families check (rejected). It needs a second reason and a second call at every site, and #304 would have to re-derive the combination.

### C3 name rules (Q7)

`src/c3/c3NameRules.ts` (off-barrel) transcribes the rules, with bundle offsets in comments.

- **Layout `name` follows `rRi`.** `scaffold-layout` refuses a `name` that breaks it, ahead of the conflict checks.
- **New objectType names follow the object-class rules.** Option N2 (recommended): refuse the reserved words `self`, `true`, `false` and `system` (letter case ignored, `System` included), and refuse a name that `nit` would rewrite, with the form C3 would load. The rules apply to new names only: scaffold-sprite `--name` and recipe CREATE `name`. They never apply to `--source`, which is only read.

Rejected: Option N1 (alternative), reserved words only. The bypass stays open: `Text Family` passes a family check, then loads as `TextFamily` and collides, and `My-Sprite` collides with `MySprite` the same way.

### Upstream posture

Name validity is a C3 domain fact whose home is c3source. Option U2 (recommended), the "user chooses not to wait" pattern of ADR 0006: the local bridge `src/c3/c3NameRules.ts`, the intent request [c3source#123](https://github.com/GenvidTechnologies/c3source/issues/123) filed in the same change, and the tripwire test `I260-T1`, which goes red when c3source exports a matching name validator.

Rejected: Option U1, wait. It contradicts the decision that the name rules are in scope.

### Release

The change ships as `fix:` with a CHANGELOG "Fixed" entry that names each newly refused input, following the newly-refused-input precedent ([#254](https://github.com/GenvidTechnologies/construct3-chef/issues/254), [#274](https://github.com/GenvidTechnologies/construct3-chef/issues/274), [#330](https://github.com/GenvidTechnologies/construct3-chef/issues/330)).

## Consequences

- **Inputs that were accepted are now refused.** `a..b`, `Foo..Bar` and `My.Widget v2` as objectType names. This reverses ADR 0060's "`a..b` is accepted" and the accept inputs of #274's OT274-R1, and amends SI267-R3. `--out Level2.json --name "Level 2"` is refused, because the name and the file stem differ. A layout whose JSON `name` clashes with another layout's is refused. A new objectType named like a family is refused.
- **Reserved-word parity, not load protection.** The reserved check gives parity with the editor's create and rename path. It is inferred that a chef-written `self` would still load, so the refusal does not guard against a load failure.
- **The transcribed rules are validated only against the 17 editor-made names in the sample project** (12 objectTypes, 2 families, 3 layouts). They refused none of them. On real user projects they are unvalidated.
- **Two deliberate differences from the editor.** The device-name check reuses chef's `reservedDeviceName` (ADR 0064), which is stricter than the editor's set: it also refuses `CONIN$` and `CONOUT$` and a device name with an extension. And the layout JSON-name comparison lowercases without NFC, the known ADR 0046 gap, while the editor's lookup applies `normalize()` first.
- **The kind check in `decideObjectClassCreate` is redundant with the path check for real listings.** Test `I260-H2` pins the kind check with a synthetic listing.
- **Untouched surfaces.** `cloneLayout` and the barrel are unchanged. Recipe `files` CREATE event-sheet names ([#366](https://github.com/GenvidTechnologies/construct3-chef/issues/366)), `--out` folder segments against C3's folder-name rule ([#367](https://github.com/GenvidTechnologies/construct3-chef/issues/367)), and a `validate-project` report of existing names C3 treats differently ([#368](https://github.com/GenvidTechnologies/construct3-chef/issues/368)) are separate issues. A namespace statement for the platform docs is requested in [claude-code-plugin-gvt-construct3#181](https://github.com/GenvidTechnologies/claude-code-plugin-gvt-construct3/issues/181).
- **Retirement.** When c3source#123 ships, adopt its validators and delete `src/c3/c3NameRules.ts`, its call sites in `src/c3/scaffoldPlan.ts` and `src/c3/recipeKeys.ts`, and `I260-T1`. The tests for the refusals must stay green afterwards. *(Done: see the Amendment.)*

## Amendment (2026-11-05): the bridge is retired onto c3source 4.0.0

c3source 4.0.0 shipped the name rules that [c3source#123](https://github.com/GenvidTechnologies/c3source/issues/123) requested, as `itemNameIssue`. The adoption is tracked in [#374](https://github.com/GenvidTechnologies/construct3-chef/issues/374). The decisions above stand. This amendment records what changed in how they are carried out.

- **The bridge is gone.** `src/c3/c3NameRules.ts` is deleted, and so is the tripwire `I260-T1`. The rules now come from `itemNameIssue`. Its tests are `DB4-N1` to `DB4-N7`.
- **Wording stays local.** `src/c3/itemNameRefusals.ts` maps every `itemNameIssue` kind to chef's refusal text. `rewritten` is included, so "refuse a name C3 would store differently" stands. When the stored name differs from the input, the text carries the load-form clause: "C3 would load it as '<n>'".
- **System expression names are now refused for new objectType names.** The source is `C3_SYSTEM_EXPRESSION_NAMES` in c3source 4.0.0, audited against editor r495-2 and regenerated by c3source's `scripts/system-expression-names.mjs`. This closes the `tfs` item that the Context lists as not traced ([#365](https://github.com/GenvidTechnologies/construct3-chef/issues/365)). A recipe that re-declares an existing type named like a System expression is refused too, as a re-declared `My Sprite` already was.
- **D1: the layout name check uses upstream's device set.** The "two deliberate differences" consequence above no longer holds for the device check: chef's stricter `reservedDeviceName` is no longer part of the name rule. `NUL.txt`, `COM¹` and `CONIN$` are refused by the `--out` path-segment check (ADR 0064) instead. The disposition is the same, and the refusal kind and text differ. The letter-case gap in the layout JSON-name comparison (ADR 0046) is not changed.
- **Mutation evidence** (HEAD ef728a1). Making the system-expression result `undefined` turns `DB4-N6`, `DB4-S1`, `DB4-RC1` and `DB4-B1` red. Making the `rewritten` result `undefined` turns `DB4-N5`, `I260-S1` and `I260-RC3` red, plus six other rows that also pin a rewritten-name refusal.
