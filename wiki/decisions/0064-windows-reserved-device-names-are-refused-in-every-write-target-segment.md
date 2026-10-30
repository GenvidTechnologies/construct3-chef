---
type: decision-record
title: "0064. Windows reserved device names are refused in every write-target segment"
description: >-
  Amends ADRs 0046 and 0060. A path segment that is a Windows reserved device
  name (`NUL`, `Con.txt`, `COM¹`, `CONIN$`) is refused in every recipe
  `files`/`layouts` key and cross-layout field, the objectType CREATE name and
  folder, `scaffold-sprite --name/--source` and `scaffold-layout --out`/`path`,
  on every host. The predicate and its wording live in the off-barrel
  `src/c3/pathSegments.ts`. An `extractedDir` naming a device falls back to
  `extracted` with a `[chefConfig]` warning
  ([#330](https://github.com/GenvidTechnologies/construct3-chef/issues/330))
tags: [decision, recipes, scaffold, safety]
status: stable
generated: { by: process:tech-writer, at: 2026-10-30T00:00:00Z }
---

# 0064. Windows reserved device names are refused in every write-target segment

- **Status:** Accepted
- **Date:** 2026-10-30
- **Issues:** [#330](https://github.com/GenvidTechnologies/construct3-chef/issues/330). Related: [#267](https://github.com/GenvidTechnologies/construct3-chef/issues/267) (scaffold input guards), [#274](https://github.com/GenvidTechnologies/construct3-chef/issues/274) (the shared objectType name rule).
- **Amends:** ADR [0046](0046-recipe-and-scaffold-paths-have-one-canonical-case-insensitive-identity.md) (`keyIssue`'s refusals) and ADR [0060](0060-scaffold-sprite-shares-the-objecttype-name-rule.md) (the shared objectType name rule, and `scaffold-layout`'s output path).
- **Relates to:** ADR [0045](0045-scaffold-plan-write-split-and-cli-path-containment.md) (the scaffold plan/write split and path containment) and ADR [0035](0035-mcp-chef-config-is-launch-fixed-per-context.md) (config is fixed at launch).

## Context

A recipe key, an objectType name, a scaffold name or an output path becomes a file or folder name. ADRs 0046 and 0060 already refuse the segments that mean something other than a file name (`:`, `..`, only dots and spaces, separators). None refused a segment that Windows treats as a device, so `NUL`, `con.txt` or `COM1` passed validation on every surface and reached a write.

The documented set is Microsoft's "Naming Files, Paths, and Namespaces" ([page](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file), ms.date 2024-08-28, git commit 63e70903):

> Do not use the following reserved names for the name of a file: CON, PRN, AUX, NUL, COM1, COM2, COM3, COM4, COM5, COM6, COM7, COM8, COM9, COM¹, COM², COM³, LPT1, LPT2, LPT3, LPT4, LPT5, LPT6, LPT7, LPT8, LPT9, LPT¹, LPT², and LPT³. Also avoid these names followed immediately by an extension; for example, NUL.txt and NUL.tar.gz are both equivalent to NUL.

`COM0` and `LPT0` are not on that list, so they are accepted. The same page has a separate rule, not to end a name with a space or a period; that is what the existing dots-and-spaces check and the trailing-space trim below relate to.

`CONIN$` and `CONOUT$` are not on the naming page. They are refused as the console names `CreateFile` accepts. The `CreateFileW` page ([page](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), ms.date 2022-08-16) was read for this record; its "Consoles" section says "The CreateFile function can create a handle to console input (CONIN$)", and, when the process holds an inherited or duplicated handle, "the active screen buffer (CONOUT$)", with "Use the CONIN$ value to specify console input. Use the CONOUT$ value to specify console output." The page documents them as `CreateFile` names; it does not say they are reserved file names, so refusing them is this project's choice, not Microsoft's naming rule.

Host evidence, posted on [#330](https://github.com/GenvidTechnologies/construct3-chef/issues/330) and used for severity only: on Windows 10.0.26200 with Node v24.11.1, Node wrote real files for every reserved name tried; Win32 `GetFullPathName` mapped only `NUL`, `NUL.` and `NUL ` to the device; and `fs.rmSync` silently failed to remove `COM¹` files. So the harm varies by name and by API, which is a reason to refuse the whole documented set rather than the names this host happens to misbehave on.

## Decision

**One segment predicate, in a new off-barrel `src/c3/pathSegments.ts`, used at every write target.**

- **Policy: the documented set, on every host.** A segment is refused whether or not the current host would mishandle it, because a project is checked into git and opened on Windows by someone else. The host measurement above is severity evidence, not the rule.
- **The matching rule.** The base is everything before the **first** dot, with trailing spaces trimmed, matched case-insensitively against the documented set plus `CONIN$` and `CONOUT$`. So `NUL.json`, `NUL.tar.gz`, `NUL.`, `NUL ` and `NUL .json` all name `NUL`; a leading space, a leading dot, a longer stem (`NULL`, `COM10`) or an unlisted digit (`COM0`) does not. The segment is reported as the caller wrote it (`con.txt`) alongside the device it resolves to (`CON`).
- **A regex, not `toUpperCase()`.** Matching uses a regex with the `i` flag. A `toUpperCase()` lookup would map the dotless i (U+0131) to ASCII `I`, so the non-reserved `con` + U+0131 + `n$` would be refused as `CONIN$`. The superscript digits are spelled with `String.fromCharCode` in the source, never as glyphs or escapes.
- **Kind-major order.** `segmentsIssue` scans every segment for `:` first, then every segment for dots-and-spaces, then every segment for a reserved name. A segment that is both malformed and reserved therefore keeps its older, more specific message, and every pre-existing refusal is unchanged.
- **Two wording mappers over one kind union.** `SegmentIssue` is `colon`, `dots-and-spaces` or `reserved`; `segmentIssueText` renders it for a path ("a segment ..."), `nameSegmentIssueText` for a single name. Each caller picks its own label, as ADR 0060 chose for the objectType name. The exact refusal text, with `<seg>` the segment as written and `<DEV>` the device:
  - path (recipe keys, folders, scaffold output paths): `must not contain a segment that is a Windows reserved device name: '<seg>' (<DEV>)`
  - single name (objectType name, scaffold-sprite `--name`/`--source`): `must not be a Windows reserved device name: '<seg>' (<DEV>)`

**Where the rule applies.**

- **Every recipe `files` and `layouts` key, and every cross-layout field value,** through `keyIssue`. This includes a key that only edits an existing file, a decision made at planning so that one rule covers every key. As a result `seedLayoutSids` no longer reads a reserved key before validation, because `layoutSeedPaths` reaches `keyIssue` first.
- **The objectType CREATE `name` and `folder`.**
- **`scaffold-sprite` `--name` and `--source`,** through the shared name rule.
- **`scaffold-layout` `--out` and the MCP `path`.** The resolved output path, taken relative to `layouts/`, now goes through the full shared segment rule, so it also newly refuses `:` and a dots-and-spaces segment. The check runs after the input-shape checks and before the source is read, and the refusal renders the resolved project-relative path, never the caller's raw argument (the [#267](https://github.com/GenvidTechnologies/construct3-chef/issues/267) rule).
- **`extractedDir`: option E1.** `loadChefConfig` replaces an `extractedDir` with a reserved segment (split on `/` and `\`) with `extracted`, keeps `navigation` and `ops`, and warns:

  `[chefConfig] extractedDir "<value>" contains a Windows reserved device name: '<seg>' (<DEV>); falling back to "extracted"`

  The CLI loads config per command, so it warns on every command. MCP loads it once per project at launch because chef config is fixed at launch (ADR [0035](0035-mcp-chef-config-is-launch-fixed-per-context.md)), so it warns once per project. It never throws, which keeps `loadChefConfig`'s documented contract. Only the reserved check applies to `extractedDir`, not the full segment rule.

**A deliberate asymmetry.** `scaffold-layout --source` is **not** checked: it only reads an existing layout and writes nothing under that name. Recipe keys are refused even when they only edit an existing file, because one rule for every key was chosen at planning over a create-only rule, and because refusing in `keyIssue` also stops `seedLayoutSids` from opening a reserved path before validation runs.

## Alternatives considered

- **Chosen: Option A: a new off-barrel `src/c3/pathSegments.ts` (new), kind union plus two wording mappers (recommended).**
- **Rejected: Option B: everything in `recipeKeys.ts`, extended in place (alternative).** The diff is smaller, but `chefConfig.ts` would then import a module whose header scopes it to recipe-key identity helpers, so a config concern would depend on the recipe layer. It would also leave a rule that scaffold, recipe and config all consume hidden inside a recipe-named module.
- **Rejected: Option C: a string-returning predicate, no kinds (rejected).** It would throw away the kind union that ADR 0060 chose so each caller renders its own label, and make the per-surface wordings harder to keep byte-identical.
- **Rejected: upstream to c3source or mcp-utils (rejected).** This is a host filename-portability fact, neither C3 on-disk schema nor MCP plumbing, and waiting on a release for a short predicate is not worth it.

For `extractedDir`:

- **Chosen: E1: fall back to `extracted` and warn.** It matches the documented posture that config falls back to defaults rather than erroring, and it is visible, which the silent containment fallback is not.
- **Rejected: E2: throw at load.** Every CLI command would fail and MCP launch would reject for that project. That makes a reserved name stricter than path escape, the more dangerous fault, and it breaks the never-throws contract.
- **Rejected: E3: refuse at generator write time.** The check would be scattered over every generator call, and because config is fixed at launch it would fail every `regenerate` repeatedly.

## Consequences

- **Behaviour change.** Reserved keys, names, folders and output paths are refused on every surface and every host. `scaffold-layout` also newly refuses `:` and dots-and-spaces segments in its output path.
- **A Linux project with an existing reserved-named sheet or layout can no longer edit it by recipe,** because keys that only edit are refused too.
- **`createObjectType` still performs no name check.** It is barrel-exported, so a library caller who skips `validateRecipe` bypasses the rule. This predates the change.
- **The C3 editor's behaviour with such names is unchecked.** The rule follows the documented Windows set, not an observation of the editor.
- **`CONIN$`/`CONOUT$` are a local choice,** grounded in `CreateFile`'s documented console names, not in the naming page's list.
- **`extractedDir` is the one place that warns instead of refusing,** so a misconfigured project keeps working against `extracted/`. The containment fallback for a path escape is untouched and still silent.
- **ADRs 0046 and 0060 are amended, not rewritten.** Each carries a one-line pointer here.
