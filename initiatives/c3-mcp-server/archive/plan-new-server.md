# Plan: C3 MCP Server — Session 1: Server Skeleton + Read Tools

> _Archived session plan from construct3-chef's monorepo development. Historical record; paths map to this repo per the [initiative repository note](../initiative.md) (`bin/`→`src/`). See [archive index](README.md)._

## Branch

`BUR-0000-c3-mcp-server` (from `origin/development`)

## Dependencies

None — read tools only wrap existing extracted files that are already on `development`.

## Summary

Set up the MCP server skeleton with `@modelcontextprotocol/sdk` and implement all read/list/search tools. This gives Claude Code structured, queryable access to C3 project data (DSL, layouts, scripts, domain index) via MCP tools instead of raw file reads.

## Friction Point Audit

1. **No missing seams** — read tools just glob directories and read files from `extracted/`. No refactoring needed.
2. **No preparatory refactors** — all generator/formatter functions exist and produce files on disk. MCP tools read those files.
3. **P/F split is clean**: P-step = server skeleton + `.mcp.json`; F-steps = individual tool registrations.
4. **No accelerating tools needed** — the tools themselves are 5-15 lines each.
5. **No async joins** — all reads are simple `fs.readFileSync` from `extracted/`.

## Todo List

1. Install `@modelcontextprotocol/sdk`, create server entry point (`bin/mcp/server.ts`) with stdio transport, and commit
2. Implement listing tools (`list-event-sheets`, `list-layouts`) and commit
3. Implement read tools (`read-dsl`, `read-dsl-index`, `read-scripts`, `read-layout`) and commit
4. Implement reference tools (`read-template-scope`, `read-domain-index`) and commit
5. Implement search tool (`search-dsl`) and commit
6. Configure `.mcp.json`, update initiative document, and commit
7. Run code review + validation

## Tool Specifications

### Listing Tools

| Tool | Input | Behavior |
|------|-------|----------|
| `list-event-sheets` | none | Glob `eventSheets/**/*.json`, return relative paths |
| `list-layouts` | none | Glob `layouts/**/*.json`, return relative paths |

### Read Tools

| Tool | Input | Behavior |
|------|-------|----------|
| `read-dsl` | `sheet` (relative path, e.g. `Goals/GoalsEvents`) | Read `extracted/<sheet>.dsl.txt` |
| `read-dsl-index` | `sheet` | Read `extracted/<sheet>.dsl.idx.txt` |
| `read-scripts` | `sheet` | Read `extracted/<sheet>.ts` |
| `read-layout` | `layout` (relative path, e.g. `Layouts/HeroesMenuLayout`) | Read `extracted/<layout>.layout.txt` |

Input convention: relative path **without extension** (matches how DSL/layout files are organized in `extracted/`). Tools append the appropriate extension.

### Reference Tools

| Tool | Input | Behavior |
|------|-------|----------|
| `read-template-scope` | none | Read `extracted/template-scope.txt` |
| `read-domain-index` | `domain?` (optional) | No domain → master index (`extracted/domain-index/index.txt`); with domain → `extracted/domain-index/<domain>.txt` |

### Search Tool

| Tool | Input | Behavior |
|------|-------|----------|
| `search-dsl` | `pattern` (regex), `glob?` (file filter) | Search `*.dsl.txt` files in `extracted/`, return matches with file path + line context |

## Key Files

- **Create**: `bin/mcp/server.ts` — MCP server entry point with all tool registrations
- **Modify**: `package.json` — add `@modelcontextprotocol/sdk` dependency
- **Create**: `.mcp.json` — Claude Code MCP server configuration
- **Modify**: `initiatives/c3-mcp-server/initiative.md` — update status

## `.mcp.json` Configuration

```json
{
  "mcpServers": {
    "c3": {
      "command": "npx",
      "args": ["tsx", "bin/mcp/server.ts"]
    }
  }
}
```

## SDK API Reference (v1.27.1)

```typescript
// Imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Server setup
const server = new McpServer({ name: "c3", version: "1.0.0" });

// Tool registration
server.registerTool("tool-name", {
  title: "Human Title",
  description: "What the tool does",
  inputSchema: { param: z.string().describe("Description") },
}, async ({ param }) => ({
  content: [{ type: "text", text: "result" }],
}));

// Resource registration
server.registerResource("name", "c3://uri", {
  title: "Title",
  description: "Description",
}, async (uri) => ({
  contents: [{ uri: uri.href, text: "content" }],
}));

// Error: return isError: true
// Stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Note**: v1.x may use `.tool()` instead of `.registerTool()` depending on exact minor version. Verify after install.

## Architecture Notes

- **Single file for session 1** — all tools in `server.ts`. Refactor into modules (readTools, mutationTools, projectTools) when mutation tools arrive in session 2.
- **Read from disk** — tools read pre-generated files from `extracted/`. In-memory generation is a future optimization.
- **Project root** — resolved via `process.cwd()` (MCP server runs from repo root via `.mcp.json`).
- **Error handling** — tools return `{ content: [...], isError: true }` with descriptive text when files don't exist (e.g., "No DSL file found for 'FooBar'. Use list-event-sheets to see available sheets.").
- **zod for schemas** — MCP SDK requires zod as peer dependency. Install both.

## Risks / Considerations

- **MCP SDK peer deps**: zod is required as a peer dependency. Need to install it if not already present.
- **Large responses**: Some domain index files or DSL files may be large. For session 1, return full content. Pagination/truncation can be added later if needed.
- **tsx + stdio**: The server runs via `npx tsx` which should work with stdio transport. Need to verify no extraneous stdout output from tsx that would corrupt the MCP protocol.
- **Package-lock churn**: Installing a new dependency will update `package-lock.json`. This is expected.

## Verification

After session 1, Claude Code should be able to:
1. List all event sheets and layouts via MCP tools
2. Read any DSL, script, layout summary, or domain index via MCP tools
3. Search DSL files for patterns via MCP tools
4. See all tools listed in Claude Code's `/mcp` status
