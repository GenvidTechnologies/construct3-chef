// Off-barrel (not re-exported from index.ts): CLI-only error rendering for yargs handlers (#266).

type Handler = (argv: any) => unknown;
type Report = (err: unknown) => void;

/** One line (message verbatim, multi-line allowed): never the stack, never `cause`. */
export function formatCliError(err: unknown): string {
  return "Error: " + (err instanceof Error ? err.message : String(err));
}

export function reportCliError(err: unknown): void {
  console.error(formatCliError(err));
  process.exitCode = 1;
}

/** Handler errors never reach yargs, so its own validation/usage path is untouched. */
export function guardHandler(h: Handler, report: Report = reportCliError): (argv: any) => Promise<void> {
  return async (argv) => {
    try {
      await h(argv);
    } catch (err) {
      report(err);
    }
  };
}

/**
 * Wraps the handler of every `.command(...)` registered after this call, so a new command is covered by default.
 * Covers the positional `(name, description, builder, handler)` form and a single command-module object; a
 * `(name, description, { builder, handler })` definition and `commandDir` are not wrapped.
 */
export function guardAllHandlers<Y extends { command: (...args: any[]) => any }>(
  y: Y,
  report: Report = reportCliError,
): Y {
  const original = y.command.bind(y) as (...args: any[]) => any;
  y.command = ((...args: any[]) => {
    if (typeof args[3] === "function") {
      args[3] = guardHandler(args[3], report);
    } else if (args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0])) {
      const mod = args[0];
      if (typeof mod.handler === "function") args[0] = { ...mod, handler: guardHandler(mod.handler, report) };
    }
    // Spread: yargs' argsert reads arguments.length, so the arity must be preserved.
    return original(...args);
  }) as Y["command"];
  return y;
}
