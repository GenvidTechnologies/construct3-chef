import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRootFolder, resolveRootFolders, isMcpError } from "@genvidtech/mcp-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ProjectRegistry, deriveProjectId, splitSpec } from "./projectRegistry.js";
import { createProjectContext, type ProjectContext } from "./projectContext.js";
import type { ChefConfig } from "../c3/chefConfig.js";

/**
 * Launch-time root resolution for the MCP server (#95): turns the
 * `--project-dir [<id>=]<path>` / `C3_PROJECT_DIRS` launch surface into the
 * ordered `{id, root}` pairs `startServer` registers. Split out of
 * `server.ts` so the precedence logic is unit-testable without booting the
 * MCP transport (`startServer` itself can't be called from a test — its
 * `StdioServerTransport.connect()` blocks the test process; see
 * `test/mcp/rootResolution.test.ts`'s own note on this).
 */

export type LaunchLogger = (message: string) => void;

/** Extract the error message text from a CallToolResult returned by
 *  `resolveRootFolder`. A separate copy from server.ts's own `mcpErrorText` —
 *  this module is deliberately import-light (no server.ts dependency) so it
 *  stays testable in isolation. */
function mcpErrorText(r: CallToolResult): string {
  const block = r.content[0];
  return block && block.type === "text" ? (block as { type: "text"; text: string }).text : String(r);
}

/**
 * Resolve the ordered list of `--project-dir` specs this launch should use,
 * per the precedence chain: repeated `--project-dir` CLI flags >
 * `C3_PROJECT_DIRS` (`path.delimiter`-separated list of the same
 * `[<id>=]<path>` spec form). An empty result is a deliberate signal, not an
 * omission — it tells {@link resolveLaunchRoots} to fall through to the
 * untouched `C3_PROJECT_DIR` / discovery / cwd path via `resolveRootFolder`,
 * exactly as `startServer` resolved a root before #95.
 */
export function resolveLaunchSpecs(
  cliProjectDirs: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (cliProjectDirs && cliProjectDirs.length > 0) return [...cliProjectDirs];
  const envList = env.C3_PROJECT_DIRS;
  if (!envList) return [];
  return envList
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ResolvedRoot {
  id: string;
  root: string;
}

/** Same shape as upstream `resolveRootFolders`'s injectable `readdir` param
 *  (not itself exported by `@genvidtech/mcp-utils`, hence the local copy).
 *  **Test seam only** — production callers must omit it. */
type ReaddirSync = (dir: string, opts: { withFileTypes: true }) => fs.Dirent[];

/**
 * Resolve `specs` (the output of {@link resolveLaunchSpecs}) into one
 * `{id, root}` pair per project to register, logging the same startup lines
 * `startServer` always printed via `log` (defaults to `console.error`).
 *
 * - **0 or 1 spec** routes through the SAME `resolveRootFolder` call
 *   `startServer` made pre-#95 (`explicit`/`envVar: "C3_PROJECT_DIR"`/
 *   discovery/cwd), preserving today's single-root behaviour byte-for-byte —
 *   including the cwd-fallback stderr warning — because that's the only path
 *   an operator using the pre-#95 launch surface (a bare `--project-dir` or
 *   nothing at all) can reach. A single explicit spec still resolves via
 *   `explicit` (which always wins — see `rootResolution.test.ts`'s R2), so
 *   this is not merely "close to" the old behaviour, it IS the old call.
 * - **2+ specs** means every root is explicit, so there is nothing left to
 *   discover: each spec is resolved directly (id derivation/dedup exactly as
 *   {@link deriveProjectId} defines it — including its stderr dedup warning),
 *   with no `resolveRootFolder` call at all.
 */
export function resolveLaunchRoots(specs: readonly string[], log: LaunchLogger = console.error): ResolvedRoot[] {
  if (specs.length >= 2) {
    const usedIds = new Set<string>();
    return specs.map((spec) => {
      const id = deriveProjectId(spec, usedIds);
      usedIds.add(id);
      const root = path.resolve(splitSpec(spec).root);
      log(`[construct3-chef] Root: ${root} (source: --project-dir, id: ${id})`);
      return { id, root };
    });
  }

  const explicitSpec = specs[0];
  const explicitPath = explicitSpec !== undefined ? splitSpec(explicitSpec).root : undefined;
  const resolved = resolveRootFolder({
    explicit: explicitPath,
    envVar: "C3_PROJECT_DIR",
    marker: "project.c3proj",
    searchDepth: 1,
  });
  let root: string;
  if (isMcpError(resolved)) {
    log(`[construct3-chef] Root resolution: ${mcpErrorText(resolved)} — falling back to cwd`);
    root = process.cwd();
  } else {
    root = resolved.path;
    if (resolved.source === "cwd") {
      log(
        `[construct3-chef] Warning: no project.c3proj found via --project-dir, $C3_PROJECT_DIR, or discovery — using cwd ${root}`,
      );
    }
  }
  log(`[construct3-chef] Root: ${root} (source: ${isMcpError(resolved) ? "cwd-fallback" : resolved.source})`);
  const id = explicitSpec !== undefined ? deriveProjectId(explicitSpec) : deriveProjectId(root);
  return [{ id, root }];
}

/**
 * Opt-in (`--discover-projects`, #216) counterpart to {@link resolveLaunchRoots}'s
 * 0-spec branch: only ever called with `specs.length === 0` (no explicit
 * `--project-dir`/`C3_PROJECT_DIRS`/`C3_PROJECT_DIR`), where the un-flagged
 * behaviour resolves via the SINGULAR `resolveRootFolder` and treats 2+
 * discovered candidates as an `mcpError` ("falling back to cwd").
 *
 * This function first PEEKS at the discovery result via the PLURAL
 * `resolveRootFolders` — a pure probe, no logging — to decide which of two
 * paths to take:
 * - **0 or 1 candidate** (or a probe error, e.g. a real I/O fault): delegates
 *   to the untouched {@link resolveLaunchRoots}`([], log)`, so behaviour is
 *   byte-for-byte identical to the flag being off (R6) — including the
 *   cwd-fallback stderr warning.
 * - **2+ candidates**: every candidate is registered. Each gets an id via
 *   {@link deriveProjectId}, deduped across an accumulating `usedIds` set
 *   exactly as {@link resolveLaunchRoots}'s 2+-explicit-spec branch already
 *   does. Whether this is actually launchable (a `--default-project` must
 *   disambiguate) is {@link buildProjectRegistry}'s call, not this function's
 *   — it only resolves roots, it never fails a launch.
 */
function resolveDiscoveredRoots(log: LaunchLogger, env?: NodeJS.ProcessEnv, readdir?: ReaddirSync): ResolvedRoot[] {
  const probe = readdir
    ? resolveRootFolders({ envVar: "C3_PROJECT_DIR", marker: "project.c3proj", searchDepth: 1 }, env, readdir)
    : resolveRootFolders({ envVar: "C3_PROJECT_DIR", marker: "project.c3proj", searchDepth: 1 }, env);
  // R7 (#216): resolveRootFolders returns ResolvedRoots | CallToolResult — a
  // real I/O fault (not ambiguity; ambiguity is this function's SUCCESS case)
  // takes this branch and falls through to the untouched 0/1-spec delegate
  // below, exactly like resolveLaunchRoots' own isMcpError handling.
  if (!isMcpError(probe) && probe.paths.length >= 2) {
    const usedIds = new Set<string>();
    return probe.paths.map((root) => {
      const id = deriveProjectId(root, usedIds);
      usedIds.add(id);
      log(`[construct3-chef] Root: ${root} (source: discovery, id: ${id})`);
      return { id, root };
    });
  }
  return resolveLaunchRoots([], log);
}

/** Constructs a {@link ProjectContext} for one registered project. Matches
 *  {@link createProjectContext}'s signature — injectable so tests can build a
 *  registry without opening a real `C3Project`/loading real chef config for
 *  every root (see `launchConfig.test.ts`'s two-root/default-project cases,
 *  which use a lightweight duck-typed fake in the same spirit as
 *  `projectRegistry.test.ts`'s T-B4 `fakeCtx`). */
export type ProjectContextFactory = (
  id: string,
  root: string,
  overrides?: Partial<ChefConfig>,
) => Promise<ProjectContext>;

/**
 * Build the launch-fixed {@link ProjectRegistry} for one server run: resolve
 * the launch surface (`projectDirs` from the CLI, `C3_PROJECT_DIRS`/
 * `C3_PROJECT_DIR` from the environment) via {@link resolveLaunchSpecs} +
 * {@link resolveLaunchRoots}, construct one {@link ProjectContext} per
 * resolved root via `factory` (defaults to the real
 * {@link createProjectContext}), and apply an optional `--default-project`
 * override — which defaults to the FIRST spec, matching
 * {@link ProjectRegistry.add}'s "first-registered wins" default.
 *
 * `opts.discoverProjects` (#216, `--discover-projects`) is opt-in
 * multi-root auto-discovery: it only takes effect when NO explicit spec was
 * given (an explicit `--project-dir`/`C3_PROJECT_DIRS` always wins, same
 * precedence as today), routing through {@link resolveDiscoveredRoots}
 * instead of {@link resolveLaunchRoots}. When that discovers 2+ roots, a
 * `--default-project` is REQUIRED to pick which one tool calls target by
 * default — `ProjectRegistry.add()` sets the default to the first
 * *registered* context, so "a registry with no default" isn't expressible,
 * and an auto-discovered launch order isn't a meaningful "first" to pick one
 * for the caller. Rather than register anything under that ambiguity, the
 * whole launch fails with an actionable error naming the discovered ids —
 * checked BEFORE any {@link ProjectContext} is constructed, so a failed
 * launch never partially registers.
 */
export async function buildProjectRegistry(
  projectDirs: readonly string[] | undefined,
  overrides?: Partial<ChefConfig>,
  defaultProject?: string,
  opts?: {
    log?: LaunchLogger;
    env?: NodeJS.ProcessEnv;
    factory?: ProjectContextFactory;
    discoverProjects?: boolean;
    /** Injectable directory reader, forwarded to the discovery probe only.
     *  **Test seam only** — see `resolveDiscoveredRoots`'s `readdir` param. */
    readdir?: ReaddirSync;
  },
): Promise<ProjectRegistry> {
  const specs = resolveLaunchSpecs(projectDirs, opts?.env);
  const log = opts?.log ?? console.error;
  const discovering = specs.length === 0 && opts?.discoverProjects === true;
  const roots = discovering ? resolveDiscoveredRoots(log, opts?.env, opts?.readdir) : resolveLaunchRoots(specs, log);

  if (discovering && roots.length >= 2 && defaultProject === undefined) {
    const ids = roots.map((r) => r.id).join(", ");
    throw new Error(
      `--discover-projects found ${roots.length} candidate projects (${ids}) and no --default-project was ` +
        `given to pick which one tool calls target by default. Pass --default-project <id> to disambiguate.`,
    );
  }

  const factory = opts?.factory ?? createProjectContext;

  const registry = new ProjectRegistry();
  for (const { id, root } of roots) {
    registry.add(await factory(id, root, overrides));
  }
  if (defaultProject !== undefined) {
    registry.defaultId = defaultProject;
  }
  return registry;
}
