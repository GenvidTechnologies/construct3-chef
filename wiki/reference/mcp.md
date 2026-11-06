---
type: reference
title: "MCP Server Reference"
description: >-
  The MCP server surface: how to start it, the tools it offers, the response shape, optimistic concurrency, project selection, user-defined op tools and the docs resources
tags: [reference, mcp]
status: stable
stale_after: 2027-05-06
generated: { by: process:maintain-wiki, at: 2026-11-06T22:06:00Z }
---

# MCP Server Reference

`construct3-chef server` starts a Model Context Protocol server over stdio. An MCP client (an AI coding agent) connects to it to read and change a Construct 3 project. The server wraps the same library as the CLI, so most tools give the result of the matching CLI subcommand (`get-state` and `list-projects` have no subcommand). See [cli.md](./cli.md) for the CLI.

## Starting the server

```bash
npx @genvidtech/construct3-chef server --project-dir /path/to/c3project
```

Configure it in your MCP client (example for Claude Desktop or similar):

```json
{
  "mcpServers": {
    "construct3-chef": {
      "command": "npx",
      "args": ["@genvidtech/construct3-chef", "server", "--project-dir", "/path/to/c3project"]
    }
  }
}
```

[cli.md](./cli.md#server) lists the flags and the launch-config precedence, including how to host more than one project.

## Tools

The server can host more than one C3 project root at once (see [Multi-project](#multi-project) below). Every tool listed here except `list-projects` accepts an optional `project` id parameter to target a non-default registered project; omit it to target the default project. `txId` values are the composite `<projectId>:<counter>` string described in [Optimistic concurrency](#optimistic-concurrency).

User-defined `op-<projectId>_<opName>` tools are registered per project and are not in these tables. See [User-defined op tools](#user-defined-op-tools).

**Read tools** (read-only, idempotent):

| Tool | Description |
| ---- | ----------- |
| `list-event-sheets` | List all event sheet JSON files in the project |
| `list-layouts` | List all layout JSON files in the project |
| `list-global-layers` | List each global layer with its source layout, overriding layouts, and instance count |
| `read-dsl` | Read the human-readable DSL for an event sheet |
| `read-dsl-index` | Read the JSON-path/SID index for recipe targeting (supports grep filter) |
| `read-event-sids` | Read SIDs directly from source JSON (useful after apply-recipe, before regenerate) |
| `read-scripts` | Read the extracted TypeScript for an event sheet |
| `read-layout` | Read the layout summary (layers, instances, templates) |
| `read-template-scope` | Read the cross-layout template scope reference |
| `read-sid-registry` | Read the global SID registry |
| `list-include-tree` | Show the transitive include tree for an event sheet |
| `search` | Regex search across extracted files (DSL, TypeScript, layout summaries, JSON) |
| `search-docs` | Search the C3 ACE reference (action/condition/expression ids, param names) for custom addons and the built-in reference cache |
| `resolve-anchor` | Look up a DSL coordinate by line number, SID, or name pattern |
| `navigation-graph` | Show the layout navigation graph as a from→to→line table, or as PlantUML with `format:"plantuml"` |
| `validate-recipe` | Validate a recipe JSON without applying it (returns txId) |
| `validate-project` | Dry-run project.c3proj sync check; returns structured `clean`; optional `section` |
| `read-addon` | Read a C3 addon's metadata + ACE summary (or a raw entry, or list all addons); works on extracted and archive-only addons |
| `validate-addons` | Returns structured `clean` (false on any finding in any family). Validate bundled `.c3addon` packages against `project.c3proj.usedAddons` (metadata, integrity, orphan/missing/duplicate) and each addon's `aces.json`/`plugin.js` properties against its `lang/*.json` locales; optional `addon` param scopes to one addon (by id or source-tree path). Read-only |
| `list-addons` | Unified addon inventory — one row per addon reconciling bundled `.c3addon` packages, `usedAddons` entries, and editor-only addons, with status and version |
| `diff-addon-aces` | Diff the ACE contract between two addon versions: added/removed ACEs plus changed param signatures |
| `scan-addon-usage` | Returns structured `clean` (with `from`, false when any site is affected). Find where a plugin, behavior, or effect addon is used: object/family presence, event-sheet ACE call sites, and expression references; `from` reports blast radius against a prior version |
| `preview-addon-metadata-sync` | Returns structured `clean`. Dry-run report of `version`/`author` drift between bundled `.c3addon` packages and `project.c3proj.usedAddons` — the read-only preview for `sync-addon-metadata`. Optional `addon` param scopes to one addon by id. Never writes |
| `list-ops` | List the target project's user-defined ops (parameterized recipe templates) with their parameters |
| `get-state` | Return server state for the target project: txId and extractedDirty flag |
| `list-projects` | List every project registered at launch (id, root, extractedDir, default). The only tool with no `project` parameter — it enumerates the registry itself |

**Mutate tools** (modify source files):

| Tool | Description |
| ---- | ----------- |
| `apply-recipe` | Apply a recipe JSON string, optionally regenerate extracted/ |
| `sync-project` | Sync project.c3proj to match disk; removals are withheld unless `prune: true` |
| `scaffold-layout` | Clone a layout with new UIDs/SIDs |
| `scaffold-sprite` | Clone a sprite objectType with new SIDs and copied images |
| `remove-layer` | Remove a layer from a layout; strict by default, with `cascade` / `removeInstances` overrides |
| `extract-template` | Extract an instance + its scene-graph children into a reusable master template, converting the original into a replica |
| `templatize-in-place` | Convert an existing instance into the master template on its current layout |
| `clone-replica-to-layouts` | Add a replica of an existing template to one or more target layouts in one call |
| `replace-instance-with-replica` | Remove an instance and place a replica of a named template in its spot (same layer, same world props) |
| `sync-addon-metadata` | Returns structured `clean`, evaluated after the apply. Sync `project.c3proj.usedAddons` `version`/`author` fields against bundled `.c3addon` packages; only `direction: "manifest-from-package"` writes. Optional `addon` param scopes to one addon by id |

**Non-idempotent read tool** (reads source only, but returns different output per call — do not treat as idempotent for retry or caching):

| Tool | Description |
| ---- | ----------- |
| `generate-sids` | Mint fresh unique C3 SIDs seeded from `sid-registry.txt`; minted SIDs are **not** persisted back to the registry |

**Regenerate tool**:

| Tool | Description |
| ---- | ----------- |
| `regenerate` | Run all 6 generators and update extracted/ |

## Responses

Every tool returns one text content block.

- A tool that tracks state ends the block with a footer line `txId: <projectId>:<counter>`.
- A tool that fails returns `isError: true`. The text starts with `Error:`, except for a `txId` rejection (see [Optimistic concurrency](#optimistic-concurrency)). A failed call on a tool that tracks state still carries the `txId` footer.
- An argument that fails the tool's input schema is a protocol error, not an `isError` result.
- Every tool declares the MCP annotations `readOnlyHint`, `destructiveHint` and `idempotentHint`. They match the four classes in the [Tools](#tools) tables.
- Findings are not errors. A tool that reports findings returns `structuredContent` of the form `{ clean, report }`. `clean` is true exactly when the matching CLI command would exit 0 for the same inputs. `report` equals the text block. A result with `isError: true` has no `structuredContent`. [cli.md](./cli.md) and [cli-addons.md](./cli-addons.md) give the `clean` rule of each tool.

## Optimistic concurrency

Each registered project keeps its own `txId` counter. The counter increases on every source-file change. It is sent and accepted as a composite `<projectId>:<counter>` string (for example `alpha:12`), not as a bare integer.

1. Read the current `txId` from `validate-recipe` or `get-state`.
2. Pass it to `apply-recipe` or `sync-project`.
3. If the project changed in between, or the token names a different project than the call's `project` parameter, the server rejects the call and returns the current `txId` in the footer. Validate again.

A rejection is an `isError` result without the `Error:` prefix. The text has one of these forms:

- `State changed (expected alpha:42, got alpha:43) — re-validate`. Some tools add ` before <action>`.
- `txId '<token>' is for project '<id>' but this call targets project '<id>'`.
- A message that says the token is malformed.

The counter resets when the server restarts.

What increases the counter:

- every source write that the server makes;
- every external edit to source files or to `project.c3proj`.

Editor-local files (`uistate/`, `ts-defs/`, `*.uistate.json`, `tsconfig.json`) do not increase it. Edits to op files do not increase it either.

A failed mutation increases the counter when it may have written source or the manifest. A call that is refused before it writes anything leaves the counter unchanged. A cancelled call always increases the counter and marks `extracted/` stale, because source was already written when the regeneration stopped.

## Stale `extracted/`

The server tracks whether `extracted/` is out of date compared with the source. It is out of date after the server writes source, after an external change to source, and when a source file is newer than the `extracted/` file that a read tool serves. A read tool that serves `extracted/` appends the line `[Warning: extracted files may be stale — run regenerate to refresh]` to its response when this holds. The tool does not block and does not regenerate on its own. Run `regenerate`, or `apply-recipe` with `regenerate: true`, to clear the state. `get-state` reports the `extractedDirty` flag.

## Multi-project

One server process can host several C3 project roots. See [cli.md](./cli.md#server) for the launch forms (repeated `--project-dir`, `<id>=` prefixes, `C3_PROJECT_DIRS`) and their precedence. A single `--project-dir` or `C3_PROJECT_DIR` registers exactly one project.

- Every tool call targets one project. The optional `project` parameter selects it. Every tool has this parameter except `list-projects`, which lists all registered projects (id, root, `extractedDir`, default).
- Without `project`, the call targets the default project: the first one registered, unless `--default-project` names another.
- An unknown project id is an error that lists the known ids.
- A `txId` from one project is rejected by every other project, even when the counters are equal.
- At startup, a missing `project.c3proj` or `extracted/` gives a warning, not a failure. A missing `extracted/` is generated automatically. Both happen for the default project only, so a non-default project's `extracted/` can be missing or stale until you run `regenerate` on it.
- Every project has its own file watcher, its own lock and its own op tools.

## User-defined op tools

For each op file in a project's `ops.dir` the server registers one tool, `op-<projectId>_<opName>`. The project id is part of the tool name, so an op tool has no `project` parameter and always acts on its own project. `list-ops` lists the loaded ops of a project. See [ops.md](./ops.md) for the op file format and the `ops` configuration.

- The server reloads op files when they change, unless `ops.watch` is `false`. With `ops.watch: false` the server reads the op files once at startup, and a change needs a restart.
- After a client connects, the server sends `notifications/tools/list_changed` when op tools are added, changed or removed.
- An op tool takes no `txId`. A call applies without an expected-token check, then increases the counter and regenerates.

## Docs resources

The server exposes the package documentation as MCP resources through the template `docs:///{+path}`.

- Every `.md` file that the installed package ships under `wiki/` is served at its path relative to `wiki/`, without the `.md` suffix. Examples: `docs:///reference/cli`, `docs:///index`.
- When the package has a README, it is `docs:///readme`.
- `resources/list` enumerates the resources. The server collects the list at startup. A page can also be read by its URI directly.

## Safety and limits

- The server uses stdio only. It opens no network port. `search-docs` reads only the local reference cache under `extractedDir` and the project's `addons/` folder.
- A name or path argument that would leave the project is refused. For event sheet and layout names on the read tools and for `read-addon` entry paths, a value that leaves its folder, by `..` or by an absolute path outside it, is refused. The `search` `path` parameter refuses a `..` segment. The scaffold tools check their paths in the same way.
- The server sends MCP `logging` notifications for file-watcher diagnostics.
- `list-event-sheets` and `list-layouts` have no pagination.
- `search` accepts a pattern of at most 500 characters. It returns at most 1000 matches and says so when it cuts the output.
- `diff-addon-aces` accepts a `.c3addon` file path outside the project. This is by design: the tool compares packages that are stored elsewhere, and it only reads.
