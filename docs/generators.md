# Generators Reference

Reference for the five C3 generators that produce `extracted/` files from C3 JSON. Useful for contributors extending the generators. For day-to-day usage, see the CLI reference.

The `extracted/` directory should be committed alongside C3 source files. If you change event sheets, layouts, or scripts, run `generate` and commit the updated files.

**Prefer extracted files over raw JSON** when verifying event sheet state, exploring logic, or reviewing changes. Read the extracted `.dsl.txt` and `.ts` files instead of grepping raw event sheet JSON. When writing plans or documents that reference event sheet locations, use DSL cross-references (e.g., `GoalsEvents_Event48_Act1`) and DSL line numbers — they are stable across edits while JSON line numbers shift.

---

## Running the Generators

```bash
npx construct3-chef generate                        # Run all 5 generators
npx construct3-chef generate --only scripts         # Extract TypeScript from eventSheet JSON
npx construct3-chef generate --only dsl             # Generate human-readable DSL
npx construct3-chef generate --only layouts         # Generate layout summaries
npx construct3-chef generate --only templates       # Generate template scope reference
npx construct3-chef generate --only sid-registry    # Generate SID registry
```

All accept `--project-dir <path>` (defaults to `cwd`).

---

## Output Structure

Extracted files mirror the event sheet directory structure:

```
extracted/
├── template-scope.txt                  <- cross-layout template map
├── sid-registry.txt                    <- sorted global SID list
├── Goals/
│   ├── GoalsEvents.dsl.txt             <- human-readable DSL
│   ├── GoalsEvents.dsl.idx.txt         <- JSON-path / SID index
│   ├── GoalsEvents.ts                  <- aggregated extracted TypeScript
│   ├── GoalsEvents_e3_a1.ts            <- individual script block
│   └── ...
├── Login/
│   ├── LoginLayout.layout.txt          <- layout layer/instance summary
│   └── ...
└── ...
```

Event sheet file names encode the C3 event/action coordinates: `{SheetName}_e{eventIndex}_a{actionIndex}.ts`. Each extracted `.ts` file contains a named function with:

- Real imports (fully typed, not `any`)
- A typed `localVars` parameter when scope variables are present
- The original script body, with a header comment showing the C3 location and human-readable event path

The generator also produces a `tsconfig.json` under `extracted/` that includes all C3 type definitions, so editors can resolve types without per-file `/// <reference>` directives.

---

## C3 Event Numbering

C3 identifies script blocks by a 1-indexed positional coordinate: `EventSheet, event N, action N, line N`. Events are numbered by **depth-first traversal** of the events tree:

| Event type | Increments counter? |
| ---------- | ------------------- |
| `block` | Yes |
| `function-block` | Yes |
| `custom-ace-block` | Yes |
| `group` | Yes (even though groups have no actions) |
| `variable` | No |
| `comment` | No |
| `include` | No |

Actions within a block are numbered 1-indexed within that block's `actions` array.

---

## Cross-Referencing C3 Errors

When C3 reports an error like `GoalEvents, event 5, action 1, line 12`:

1. Find the extracted file matching those coordinates: `GoalEvents_e5_a1.ts`
2. Go to line 12 in that file (line numbers match the original script array)
3. Fix the issue in the extracted file, then port the fix back to the event sheet JSON

DSL cross-references in `.dsl.txt` files (e.g., `// -> SheetName_Event3_Act1`) link multi-line script actions to the corresponding extracted `.ts` file.

---

## DSL Index Format (`.dsl.idx.txt`)

The index file maps every event tree node to its JSON path and SID. This is the primary source for recipe targeting.

```
# GoalsEvents — DSL Index
# JSON Path                   | SID              | Description
events[0]                     §100234567890123   on-start
events[0].children[0]         §100234567890456   block: [Is playing]
events[0].children[0]         action[0]          Act1: script
events[1]                     §100234567890789   function: LoadGoals
  events[1]                   action[0]          Act1: script
```

- SIDs appear with a `§` prefix
- To use a SID in a recipe: strip the `§` and write `"in": "sid:100234567890123"`
- `action[N]` rows (0-based) show action indices for `patch-script` and `patch-action-param`

Use the `resolve-anchor` MCP tool to look up a specific SID, line number, or name pattern without reading the full index.

---

## localVars Matching

Each script block may have access to local variables from:

- `eventType: "variable"` declarations in scope (current block + all ancestor groups)
- `functionParameters` from the enclosing `function-block` or `custom-ace-block`

The extractor collects these into a "scope vars" set and generates an inline object type for each function's `localVars` parameter (e.g., `{ myVar: string; count: number }`). Types are derived directly from the event sheet source.

In extracted `.ts` files, `localVars` always uses inline object types derived from the event sheet source. This avoids unstable SID references.

---

## Generator Output Stability

Generators that output to `extracted/` must produce deterministic output across platforms:

1. **Sort directory listings**: `readdirSync` returns different orders on Windows vs Linux/macOS. Always sort before iterating.

2. **Normalize line endings in C3 data**: C3 JSON files may contain `\r\n` in expressions and comments. Normalize to `\n` before processing.

3. **Sort output lists**: Any list in formatted output (functions, files, dependencies) should be sorted.

4. **Use `.gitattributes` for line endings**: Add `extracted/** text eol=lf` to ensure git stores generated files with LF endings regardless of platform.

CI validates that `extracted/` matches regenerated output. If validation fails, run `generate` and commit.

---

## Formatter/CLI Architecture

The generators follow a strict separation between formatting logic and CLI I/O:

```
src/c3/*Formatter.ts    <- pure functions (unit-testable, no filesystem access)
src/generate*.ts        <- CLI wrapper (yargs, file I/O, directory management)
test/C3/*.test.ts       <- unit tests for formatters only
```

Each generator has a `generate` subcommand (writes files) and a `summary` subcommand (prints stats without writing). Formatters receive parsed data and return strings — they never read files or interact with the filesystem.

| Formatter | Output |
| --------- | ------ |
| `dslFormatter.ts` | `.dsl.txt` and `.dsl.idx.txt` |
| `layoutFormatter.ts` | `.layout.txt` |

New generators should follow this formatter/CLI separation pattern to keep formatting logic testable without filesystem mocking.

---

## Selective Cleanup

When multiple generators share a single output directory (`extracted/`), each generator must only clean files it owns. This prevents one generator from deleting another's output:

```typescript
cleanOwnedFiles(outDir, ".dsl.txt");     // DSL generator
cleanOwnedFiles(outDir, ".layout.txt");  // Layout generator
cleanOwnedFiles(outDir, ".ts");          // Script extractor
```

This avoids the naive `rmSync(outDir, { recursive: true })` approach. The shared directory structure allows related outputs to sit side-by-side.
