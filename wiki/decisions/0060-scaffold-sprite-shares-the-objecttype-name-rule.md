---
type: decision-record
title: "0060. scaffold-sprite shares the objectType name rule"
description: >-
  `scaffold-sprite --source/--name` now use the same label-agnostic name rule as
  a recipe `objectTypes` CREATE (`objectTypeNameIssue`): empty, `/`, `\`, `:`,
  `.`/`..` and only-dots-and-spaces are refused, and `a..b` is accepted.
  `scaffold-layout` also refuses empty inputs, a non-`.json` output and a
  directory source before any write
  ([#267](https://github.com/GenvidTechnologies/construct3-chef/issues/267))
tags: [decision, scaffold, objecttypes]
status: stable
generated: { by: process:tech-writer, at: 2026-10-27T00:00:00Z }
---

# 0060. scaffold-sprite shares the objectType name rule

- **Status:** Accepted
- **Date:** 2026-10-27
- **Issues:** [#267](https://github.com/GenvidTechnologies/construct3-chef/issues/267) (scaffold input guards). Related: [#329](https://github.com/GenvidTechnologies/construct3-chef/issues/329).
- **Resolves:** ADR [0045](0045-scaffold-plan-write-split-and-cli-path-containment.md)'s "substring test" consequence.

## Context

Two rules guarded the same `objectTypes/<name>.json` file, and each was strict where the other was lax. A recipe `objectTypes` CREATE ([#329](https://github.com/GenvidTechnologies/construct3-chef/issues/329)) accepted `a..b` but refused `:` and the empty name. `scaffold-sprite` did the opposite: it refused any name containing `..` (a substring test, ADR 0045), but let an empty `--name` write `objectTypes/.json`, and let `a:b` write into an NTFS alternate data stream of `objectTypes/a`.

`scaffold-layout` had the same shape of gap: an empty `name` or event sheet, an output path that was not a `.json` file (`layouts/Foo/` and `layouts/Foo` wrote an extensionless file), and a `--source` that was a directory (failing with a raw `EISDIR`).

## Decision

**Share #329's rule.** One label-agnostic predicate, `objectTypeNameIssue` in `src/c3/recipeKeys.ts`, returns why a single name is unusable: empty, a `/` or `\`, `.` or `..`, a `:`, or only dots and spaces. `objectTypeEntryIssue` (recipe CREATE) and `scaffoldPlan.ts` (`scaffold-sprite`) both call it and render their own wording, so the rule is one definition and the messages differ only in label. A scaffold rejection reads `Invalid name '<raw>' — <reason>`.

`scaffold-layout` refuses, before any write and with one message on the CLI and MCP, an empty `name`, an empty event sheet, an output path that is not a `.json` file, and a `--source` that is a directory. The `.json` test reuses c3source's `isSectionItemName`, plus a check for an empty file stem (`isSectionItemName(".json")` is true). The rejection renders the resolved project-relative path, so both surfaces print the same text for the same target.

## Alternatives considered

- **Share #329's rule** (CHOSEN).
- **Keep substring check + add**: keep today's `/`, `\`, `..` substring test and add only empty and `:`. Rejected because recipe CREATE and scaffold-sprite would keep different rules for the same file, which is the drift this decision removes.

## Consequences

- **Behaviour change: `a..b` is now accepted by `scaffold-sprite`.** It was refused by the substring test. A name that is exactly `..`, or only dots and spaces, is still refused.
- **Inputs that were accepted are now refused:** an empty sprite name, a sprite name containing `:`, an empty layout name or event sheet, and a layout output that is not a `.json` file. Each exits 1 with nothing written.
- **The layout `.json` check is case-sensitive,** because `isSectionItemName` is, by upstream design: `Foo.JSON` is refused too. Aligning it would be an upstream request, not a local predicate.

**Amended by ADR [0064](0064-windows-reserved-device-names-are-refused-in-every-write-target-segment.md):** the shared objectType name rule refuses reserved device names, and `scaffold-layout`'s output path gains the shared segment rule.
