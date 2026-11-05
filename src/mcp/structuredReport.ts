import { z } from "zod";
import { mcpStructuredContent } from "@genvidtech/mcp-utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Off-barrel MCP plumbing for tools whose CLI exits 1 on findings (ADR 0068).
 *
 * The payload is built with mcp-utils' `mcpStructuredContent` (0.14.0): it
 * joins the text and footer as `mcpContent` does and passes that joined text
 * to the builder, so `report` and the text block cannot drift. The
 * `{ clean, report }` payload policy and the outputSchema stay local. An
 * `isError` result never carries `structuredContent`.
 */

const REPORT_DESCRIPTION =
  "The full text report, ending with the txId footer when the tool emits one: the same text as the content block.";

/** outputSchema for a tool whose CLI exits 1 on findings (ADR 0068). */
export function cleanReportSchema(cleanDescription: string) {
  return { clean: z.boolean().describe(cleanDescription), report: z.string().describe(REPORT_DESCRIPTION) };
}

/** Success result: the text block plus structuredContent whose report is that block's text, byte for byte. Never for an isError result. */
export function cleanReportContent(text: string, footer: string | undefined, clean: boolean): CallToolResult {
  return mcpStructuredContent(text, footer, (report) => ({ clean, report }));
}
