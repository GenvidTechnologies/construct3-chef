# Archive — historical session plans

Per-session implementation plans from construct3-chef's development inside the Genvid "burbank" monorepo. They are kept for provenance and design rationale; the living roadmap and the consolidated knowledge base are in [`../initiative.md`](../initiative.md).

These plans describe work as it was done at the time, against the monorepo layout (`bin/c3/`, `bin/mcp/`, `test/C3/`). See the [repository note in the initiative](../initiative.md) for how those paths map onto this repo (`src/c3/`, `src/mcp/`, `test/c3/`, plus the `genvid-mcp-utils` / `c3source` packages).

| Plan | Topic |
| ---- | ----- |
| [plan-new-server.md](plan-new-server.md) | Session 1 — MCP server skeleton + read tools |
| [plan-sid-generation.md](plan-sid-generation.md) | Collision-checked SID generation + `sid-registry.txt` |
| [plan-recipe-addressing.md](plan-recipe-addressing.md) | SID-based recipe addressing redesign |
| [plan-recipe-gaps.md](plan-recipe-gaps.md) | Recipe gap features (`patch-action-param`, `custom-ace-block`, `addInstVars`) |
| [plan.md](plan.md) | Session 16 — param type safety + include tree |
| [filesystem-independence-plan.md](filesystem-independence-plan.md) | Session 17 — full MCP coverage of `extracted/` |
| [plan-session-18.md](plan-session-18.md) | Session 18 — recipe reliability + `wrap-in-group` |
| [plan-session-19.md](plan-session-19.md) | Session 19 — mid-session SID discovery + staleness detection |
| [plan-packaging.md](plan-packaging.md) | Package extraction (construct3-chef, c3source, genvid-mcp-utils) |
