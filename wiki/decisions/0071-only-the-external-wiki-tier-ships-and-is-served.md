---
type: decision-record
title: "0071. Only the external wiki tier ships in the package and is served as docs:/// resources"
description: >-
  The npm package ships only `wiki/index.md` and `wiki/reference/` (plus `README.md` and `CHANGELOG.md`), and the
  MCP server serves only `docs:///index`, `docs:///reference/*` and `docs:///readme`. Decision records, process docs, architecture notes, the log, the schema and `raw/` stay in the
  repository. The mechanism is a narrower `package.json` `files` list; `exposeDocs` keeps `docsDir: "wiki"`, so every
  external URI is unchanged
  ([#387](https://github.com/GenvidTechnologies/construct3-chef/issues/387))
tags: [decision, architecture, documentation]
status: stable
generated: { by: process:tech-writer, at: 2026-11-06T00:00:00Z }
---

# 0071. Only the external wiki tier ships in the package and is served as docs:/// resources

- **Status:** Accepted
- **Date:** 2026-11-06
- **Issues:** [#387](https://github.com/GenvidTechnologies/construct3-chef/issues/387). Parent: [#339](https://github.com/GenvidTechnologies/construct3-chef/issues/339).
- **Supersedes in part:** ADR [0028](0028-documentation-consolidated-into-the-wiki-tier.md) (the wiki ships whole) and ADR [0033](0033-mcp-docs-resource-serves-wiki-directly.md) (every `*.md` under `wiki/` is served).

## Context

ADR 0028 moved all documentation into `wiki/`, and ADR 0033 pointed the MCP docs resource straight at it. The package then shipped the whole wiki and `raw/`, and the server served every page. The shipped set held 85 internal paths: 70 decision records and the decisions index, 5 process pages, 4 architecture pages, 3 root pages (`log`, `wiki-schema`, `local-verification-practice`) and 2 under `raw/`. These are maintainer documents. Many of them link to files that are not in the package, so a consumer reading them over `docs:///` met dead links ([#339](https://github.com/GenvidTechnologies/construct3-chef/issues/339)).

## Decision

The wiki has two tiers. A page's tier is its directory, except at the bundle root, where only `index.md` is external.

- **External:** `wiki/reference/` and the bundle-root `wiki/index.md`, plus the package's `README.md` and `CHANGELOG.md`.
- **Internal:** every other page, including the other root pages (`log.md`, `wiki-schema.md`, `local-verification-practice.md`), and all of `raw/`. They stay in the repository.

All external files ship in the package. The MCP server serves `docs:///index`, `docs:///reference/*` and `docs:///readme` (the package `README.md`). It does not serve `CHANGELOG.md`.

An external page states user-visible behaviour itself and links only to external pages or to absolute `https:` URLs. The rule is written in `wiki/wiki-schema.md` ("External and internal pages") and enforced by `test/packagedDocs.test.ts` against the real tarball.

The mechanism is a narrower `files` list in `package.json`: `dist`, `wiki/index.md`, `wiki/reference`, `CHANGELOG.md`, `LICENSE`, `README.md`. `src/mcp/server.ts` keeps `exposeDocs(server, __pkgDir, { docsDir: "wiki", recursive: true })`. `exposeDocs` walks the filesystem, so an installed package serves exactly what it ships. The root index links to internal pages by absolute GitHub URL.

## Compromise

Options considered:

- **Narrow `files` only (chosen).** It needs no upstream change, and every external URI stays the same.
- **Upstream exposeDocs filter (rejected).** `@genvidtech/mcp-utils` `exposeDocs` has no filter option. This route waits on an mcp-utils release, or needs a local bridge plus a tripwire test.
- **Move internal pages out of wiki/ (rejected).** It moves the OKF bundle root that `maintain-wiki`, the `.gvt-agent.json` `paths` overrides and `CLAUDE.md` all assume.
- **`docsDir` narrowing to `wiki/reference` (rejected).** It renames every external URI, for example `docs:///reference/cli` becomes `docs:///cli`. The `gvt-construct3` plugin reads `docs:///index`, `docs:///reference/cli`, `docs:///reference/recipe-reference` and `docs:///reference/ops`, so this would break it.

## Consequences

- The `docs:///` resources for decisions, process, architecture, `log`, `wiki-schema` and `local-verification-practice` are removed from the package. This is consumer-visible. After the release, an issue on `gvt-construct3` asks for the pin bump.
- A source checkout still serves every `.md` under `wiki/`, because the server reads the disk. Only maintainers see this.
- The root index links to internal pages by absolute URL. `scripts/wiki-lint.mjs` counts those as index links. The `maintain-wiki lint` verb in gvt-dev may not, so it can report those pages as orphans.
- External pages must restate the behaviour they once left to an ADR. That work was done in #384 to #386.
- A new page placed outside `wiki/reference/` is internal. A link from an external page to an internal one must be an absolute URL, or `test/packagedDocs.test.ts` fails.
- Release: removing served resources is consumer-visible. Per the #339 decision this ships as a minor bump, following the 1.2.0 `docs:///` rename precedent (CHANGELOG `[1.2.0]`).
- The root index text is written for both readers. A package reader is told the internal sections are on GitHub.
- `npm run wiki:lint` now checks the absolute `blob/main/wiki/` links in the indexes for dead targets, and a test runs it on the repo (`PD387-R6:` in `test/packagedDocs.test.ts`). The gvt-dev `maintain-wiki lint` may still treat those links as external.
- The frontmatter `status` of ADR 0028 and ADR 0033 stays `stable`, because each is superseded only in part (the ADR 0066 precedent). Their Status lines say so.
