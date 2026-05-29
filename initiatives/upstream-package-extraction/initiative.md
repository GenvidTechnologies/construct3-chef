# Initiative: Upstream Package Extraction

> **Status: open backlog.** Move duplicated, generic logic *up* into the two private dependencies so `construct3-chef` consumes it instead of re-deriving it. Outcome of a 2026-05-28 codebase audit that found the same C3-tree-walk reimplemented ~20 times and ~85 `as Record<string, unknown>` casts in `src/`, almost all caused by a missing upstream primitive or type field.

The work splits cleanly into two upstream repos. Each document below is **self-contained and addressed to the agent working in that repo** — it requires no `construct3-chef` access, and cites downstream call sites only as justification.

- [**c3source-work-request.md**](c3source-work-request.md) — C3-domain: optional type fields (`disabled`/`isOrBlock`/layout size/`overriden`), in-memory `visitEvents`/`visitLayers`/`visitInstances` visitors, SID/function discovery primitives, and (medium priority) scene-graph & layer-default schema.
- [**genvid-mcp-utils-work-request.md**](genvid-mcp-utils-work-request.md) — generic MCP/FS plumbing: `walkFiles`, `escapeRegExp`/`toPosixPath`, `resolveWithin` path guard, `mcpError`/`withMcpErrors`, `bufferingLogger`, paginated-content helper + annotation presets, and (larger) the `OptimisticWatcher` txId/watcher state machine.

## Downstream follow-up

Each upstream item is independently shippable. Once one lands and is published, `construct3-chef` bumps the corresponding pin in `.packages-version`, switches to the new export, and deletes its local copy. The purely-local cleanups that don't require an upstream change (e.g. the `patch-script` path/node merge, the `runMutation` MCP orchestrator, CLI↔server scaffold dedup, removing the deprecated `autoAdjust` machinery) are tracked separately from this initiative.
