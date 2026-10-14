import type { OptimisticWatcher } from "@genvidtech/mcp-utils";

/**
 * Per-call tracking of the paths a tool call writes itself, so the source
 * watcher does not report them back as external changes.
 *
 * mcp-utils' `suppress()` drops watcher events only while its body runs, and
 * chef's writes are synchronous, so their `fs.watch` events arrive after it has
 * returned. Registering each path with `expect()` before the write lets the
 * watcher's second layer consume that late event.
 *
 * `refresh()` re-registers every path at the end of the call: the
 * `ExpectedChanges` TTL (5 s) starts at `expect()`, and generators may run
 * longer than that between the write and the end of the call.
 *
 * Accepted cost: a registration that is never consumed can mask the first
 * genuine external edit to that path for up to the TTL.
 *
 * See https://github.com/GenvidTechnologies/construct3-chef/issues/277.
 */
export interface SelfWriteTracker {
  /** Register `absPath` as about to be written. Call BEFORE the write, so a write that throws partway is covered. */
  before(absPath: string): void;
  /** Re-register every path seen so far, restarting the TTL. */
  refresh(): void;
}

/**
 * Build a tracker over `w`. Both methods are closures, so `before` can be
 * passed detached (e.g. as `{ beforeWrite: sw.before }`).
 */
export function trackSelfWrites(w: Pick<OptimisticWatcher, "expect">): SelfWriteTracker {
  const paths = new Set<string>();
  return {
    before(p) {
      paths.add(p);
      w.expect(p);
    },
    refresh() {
      for (const p of paths) w.expect(p);
    },
  };
}

/**
 * Run `fn` inside `w.suppress()` with a fresh tracker, and refresh the tracked
 * paths when `fn` finishes, whether it returns or throws. The refresh runs
 * inside the suppress window.
 */
export async function suppressSelfWrites<T>(
  w: Pick<OptimisticWatcher, "expect" | "suppress">,
  fn: (sw: SelfWriteTracker) => Promise<T>,
): Promise<T> {
  const sw = trackSelfWrites(w);
  return w.suppress(async () => {
    try {
      return await fn(sw);
    } finally {
      sw.refresh();
    }
  });
}
