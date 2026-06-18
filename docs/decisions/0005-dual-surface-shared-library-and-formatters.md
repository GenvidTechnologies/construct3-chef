# 0005. Dual CLI + MCP surface over one shared pure library and shared formatters

- **Status:** Accepted (retroactively documented)
- **Date:** 2026-06-18

## Context

This decision predates ADR 0001 and is recorded retroactively.

The same capabilities are exposed two ways: a yargs CLI (`src/cli.ts`) and an MCP server (`src/mcp/server.ts`). With two separate surfaces, there is a persistent risk that their behavior and output format drift over time — especially for output formatting, where subtle differences accumulate silently.

## Decision

Both surfaces are **thin wrappers** over the pure library in `src/c3/`. All logic lives in the library; `cli.ts` and `server.ts` contain only the surface-specific plumbing (argument parsing, MCP handler registration, response shaping).

**Result rendering also lives in the library.** Each capability has a single shared formatter that both surfaces call, so outputs stay byte-identical rather than drifting. For example: `src/c3/aceLookup.ts`'s `formatLookupResult` is rendered once and consumed by both the `search-docs` CLI subcommand and the `search-docs` MCP tool. Similarly, `src/c3/opTemplate.ts`'s `formatOpsList` is consumed by both the CLI `list-ops` subcommand and the MCP `list-ops` tool via `OpsRegistry`.

When adding a capability: implement it in `src/c3/`, then surface it in both `cli.ts` and `server.ts`.

See [CLAUDE.md](../../CLAUDE.md) § "What this is" for the guiding statement.

## Compromise

**Separate per-surface implementations or per-surface formatting** was rejected. Maintaining two implementations of the same logic guarantees drift over time: parameter handling diverges, output formats diverge, and the MCP and CLI tools become inconsistent in ways that are invisible unless both surfaces are tested against the same expected output.

## Consequences

- Every new capability touches at least three locations in lockstep: the library module, `cli.ts`, and `server.ts`.
- The shared formatter is the primary anti-drift mechanism — it is the contract that both surfaces are tested against.
- The `src/index.ts` barrel re-exports every module wholesale; a symbol exported from a library module becomes public API the moment it ships in `dist/` (see CLAUDE.md § "Public-API surface").
- The Logger interface (`src/c3/types.ts`) is how library functions produce output without coupling to either surface: CLI entry points pass `console.log`; MCP handlers pass a line-accumulating closure.
