# Architecture & research

Why the MCP server is shaped the way it is, plus the preserved prior-art
comparison it was designed against.

See the [wiki index](../index.md) for the other sections.

* [Addon tooling](addon-tooling.md) -
  Design history of the `.c3addon` tool cluster (`read-addon`,
  `validate-addons`, `list-addons`, `diff-addon-aces`, `scan-addon-usage`,
  `sync-addon-metadata`): which off-barrel `src/c3/addon*.ts` module backs
  each tool, how usage scanning grew from plugins to behaviors, effects and
  expressions, the UTF-8 BOM strip, the `validate-addons` false-positive
  fixes, and `--skip-gate`
* [MCP Server Architecture](mcp-architecture.md) -
  MCP server design (stdio transport, file-based model,
  txId/extractedDirty/watcher concurrency, Logger/ReadWriteLock decisions,
  security posture, SDK research, prior-art comparison)
* [construct3-mcp: Architecture Deep Dive](prior-art-construct3-mcp.md) -
  Imported reference/design record from the originating monorepo
