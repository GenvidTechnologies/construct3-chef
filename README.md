# construct3-chef

A toolkit for automating Construct 3 project mutations: event sheet recipes, generators, layout scaffolding, sprite scaffolding, and an MCP server for AI-assisted editing.

## What it does

Construct 3 stores project data as JSON files on disk (event sheets, layouts, object types). construct3-chef provides:

- **Recipes** — JSON-driven mutation scripts that insert/remove/patch events, actions, conditions, and layout instances without opening the C3 editor
- **Generators** — extract human-readable DSL, TypeScript, and layout summaries from C3 JSON, committed alongside source for diffing and code review
- **Scaffolding** — clone layouts or sprite objectTypes with remapped UIDs and SIDs
- **MCP server** — exposes all of the above as Model Context Protocol tools for AI coding agents

## Installation

```bash
npm install @genvid/construct3-chef
```

Requires Node.js 22+. The installed CLI binary is named `construct3-chef`.

## Quick Start

All commands accept a global `--project-dir` option (defaults to `cwd`). Point it at the root of your C3 project — the directory containing `project.c3proj`.

```bash
# Generate extracted/ files from C3 JSON (run after editing event sheets)
npx @genvid/construct3-chef generate --project-dir /path/to/c3project

# Apply a recipe
npx @genvid/construct3-chef apply-recipe my-recipe.json --project-dir /path/to/c3project

# Validate project.c3proj matches disk
npx @genvid/construct3-chef validate-project --project-dir /path/to/c3project

# Start the MCP server
npx @genvid/construct3-chef server --project-dir /path/to/c3project
```

If you install globally or add to `package.json` scripts, you can omit `npx`.

## CLI Overview

13 subcommands — all accept `--project-dir <path>` (defaults to `cwd`).

| Subcommand | Purpose |
| ---------- | ------- |
| `server` | Start the MCP server over stdio |
| `generate [--only <type>]` | Generate all extracted/ files, or one type: `scripts`, `dsl`, `layouts`, `templates`, `sid-registry` |
| `apply-recipe <file>` | Apply an event sheet mutation recipe |
| `rename-symbol <from> <to>` | Rename a symbol across all event sheet scripts |
| `validate-project` | Dry-run: check that `project.c3proj` matches files on disk |
| `sync-project` | Write `project.c3proj` to match files on disk |
| `scaffold-layout` | Clone a layout with remapped UIDs/SIDs |
| `scaffold-sprite` | Clone a sprite objectType with remapped SIDs and copied images |
| `list-templates` | List all template instances across layouts |
| `navigation-graph` | Print GoToLayout calls (or write a PlantUML diagram) |
| `search-dsl <pattern>` | Regex search across extracted DSL files |

See [docs/cli.md](docs/cli.md) for full flag documentation.

## Recipes

Recipes are JSON files that describe mutations to event sheets and layouts. They are the primary way to modify C3 projects programmatically.

```bash
# Validate without writing
npx @genvid/construct3-chef apply-recipe my-recipe.json --dry-run

# Show script diffs
npx @genvid/construct3-chef apply-recipe my-recipe.json --preview

# Apply and regenerate extracted/
npx @genvid/construct3-chef apply-recipe my-recipe.json
```

See [docs/recipe-reference.md](docs/recipe-reference.md) for the full recipe format, all 15 event sheet operations, all 12 layout operations, and the builder shorthand syntax.

## Generators

The `generate` subcommand produces `extracted/` files that make C3 JSON human-readable:

| Type | Output | Description |
| ---- | ------ | ----------- |
| `scripts` | `extracted/**/*.ts` | TypeScript extracted from event sheet script actions |
| `dsl` | `extracted/**/*.dsl.txt` | Human-readable event sheet DSL |
| `dsl` | `extracted/**/*.dsl.idx.txt` | JSON-path and SID index for recipe targeting |
| `layouts` | `extracted/**/*.layout.txt` | Layer/instance summary for each layout |
| `templates` | `extracted/template-scope.txt` | Cross-layout template instance map |
| `sid-registry` | `extracted/sid-registry.txt` | Sorted list of all SIDs in the project |

It is recommended to commit `extracted/` alongside C3 source files for diffability and code review. Run `generate` after editing event sheets or layouts.

See [docs/generators.md](docs/generators.md) for internals, output format, and cross-reference syntax.

## MCP Server

`construct3-chef server` starts a Model Context Protocol server over stdio. AI coding agents can connect to it to read and mutate a C3 project interactively.

### Starting the server

```bash
npx @genvid/construct3-chef server --project-dir /path/to/c3project
```

Configure it in your MCP client (example for Claude Desktop or similar):

```json
{
  "mcpServers": {
    "construct3-chef": {
      "command": "npx",
      "args": ["@genvid/construct3-chef", "server", "--project-dir", "/path/to/c3project"]
    }
  }
}
```

### Available MCP tools

**Read tools** (read-only, idempotent):

| Tool | Description |
| ---- | ----------- |
| `list-event-sheets` | List all event sheet JSON files in the project |
| `list-layouts` | List all layout JSON files in the project |
| `read-dsl` | Read the human-readable DSL for an event sheet |
| `read-dsl-index` | Read the JSON-path/SID index for recipe targeting (supports grep filter) |
| `read-event-sids` | Read SIDs directly from source JSON (useful after apply-recipe, before regenerate) |
| `read-scripts` | Read the extracted TypeScript for an event sheet |
| `read-layout` | Read the layout summary (layers, instances, templates) |
| `read-template-scope` | Read the cross-layout template scope reference |
| `read-sid-registry` | Read the global SID registry |
| `list-include-tree` | Show the transitive include tree for an event sheet |
| `search` | Regex search across extracted files (DSL, TypeScript, layout summaries, JSON) |
| `resolve-anchor` | Look up a DSL coordinate by line number, SID, or name pattern |
| `validate-recipe` | Validate a recipe JSON without applying it (returns txId) |
| `validate-project` | Dry-run project.c3proj sync check |
| `read-addon` | Read a C3 addon's extracted files |
| `get-state` | Return server state: txId and extractedDirty flag |

**Mutate tools** (modify source files):

| Tool | Description |
| ---- | ----------- |
| `apply-recipe` | Apply a recipe JSON string, optionally regenerate extracted/ |
| `sync-project` | Sync project.c3proj to match disk |
| `scaffold-layout` | Clone a layout with new UIDs/SIDs |
| `scaffold-sprite` | Clone a sprite objectType with new SIDs and copied images |

**Regenerate tool**:

| Tool | Description |
| ---- | ----------- |
| `regenerate` | Run all 5 generators and update extracted/ |

### Optimistic concurrency

The server maintains a `txId` counter that increments on every source-file mutation. Read the current `txId` from `validate-recipe` or `get-state`, then pass it to `apply-recipe` or `sync-project`. If the project changed between validate and apply, the server rejects the operation and returns the current `txId` so you can re-validate.

## Project structure expected

construct3-chef expects the standard C3 "project folder" layout:

```
project.c3proj
eventSheets/
layouts/
objectTypes/
scripts/
  ts-defs/
    instanceTypes.d.ts
    objects.d.ts
files/
images/
addons/
```

The `extracted/` directory is written by `generate` and read by the MCP server. It does not need to exist before the first `generate` run — the server auto-generates it on startup if missing.

## Documentation

- [docs/recipe-reference.md](docs/recipe-reference.md) — Complete recipe reference: format, SID addressing, all 15 event sheet operations, all 12 layout operations, builder shorthands, gotchas
- [docs/generators.md](docs/generators.md) — Generator internals, output format, cross-referencing C3 errors, localVars matching
- [docs/cli.md](docs/cli.md) — Full CLI flag documentation for all subcommands
