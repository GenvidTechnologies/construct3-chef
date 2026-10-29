import type { Logger } from "@genvidtech/mcp-utils";

export interface ApplyOptions {
  /**
   * Runs apply's in-memory compute pass and discards its writes: every step sees the earlier ones, and a
   * refusal is apply's own. Nothing reaches disk and `beforeSourceWrite` never fires.
   */
  dryRun?: boolean;
  preview?: boolean;
  regenerate?: boolean;
  log?: Logger;
  extractedDir?: string;
  /**
   * Called immediately BEFORE each source write that recipe apply performs. Today that means each write
   * entry in the replay loop. Never called in dry-run or preview, nor for a recipe refused before writing.
   * A call means a write MAY land; the caller owns what it records, so the record survives a throw.
   * The argument is the path about to be written, made absolute with `path.resolve` (the same base the
   * write itself resolves against), passed once per write entry, before it lands.
   */
  beforeSourceWrite?: (absPath: string) => void;
}
