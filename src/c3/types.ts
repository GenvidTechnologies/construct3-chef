import type { Logger } from "@genvidtech/mcp-utils";

export interface ApplyOptions {
  dryRun?: boolean;
  preview?: boolean;
  regenerate?: boolean;
  log?: Logger;
  extractedDir?: string;
}
