import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSX_CLI_ENTRY = path.resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const CHEF_CLI_ENTRY = path.resolve(REPO_ROOT, "src/cli.ts");

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliOptions {
  /** Working directory for the spawned process. Defaults to the repo root. */
  cwd?: string;
}

/**
 * Spawns `src/cli.ts` as a real child process via tsx, for asserting
 * process-boundary behavior that a unit test can't reach: yargs'
 * `demandOption`/unknown-argument errors and real process exit codes (see
 * the sync-addon-metadata acceptance criteria T1/T27/T28 in issue #145).
 *
 * This repo's established precedent (see the comment above the CLI
 * exit-code decision tests in test/c3/addonAceUsageBehavior.test.ts) is to
 * unit-test CLI *decision logic* directly rather than spawn a subprocess.
 * That still holds for everything else — this helper is deliberately
 * scoped to the handful of cases that genuinely need a real process
 * boundary, not a general-purpose CLI test harness. Don't migrate existing
 * tests onto it.
 *
 * Resolves tsx's CLI entry point directly from node_modules (rather than
 * shelling out to `npx tsx`) to avoid npx's resolution overhead and
 * potential network lookups.
 */
export function runCli(args: string[], opts: RunCliOptions = {}): RunCliResult {
  const result = spawnSync(process.execPath, [TSX_CLI_ENTRY, CHEF_CLI_ENTRY, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}
