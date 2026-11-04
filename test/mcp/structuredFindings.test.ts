import { expect } from "chai";
import { cleanReportContent } from "../../src/mcp/structuredReport.js";

describe("structuredReport", () => {
  it("I349-H1: cleanReportContent's report equals the text block, footer included", () => {
    expect({
      withFooter: cleanReportContent("a", "txId: x", false),
      noFooterReport: cleanReportContent("a", undefined, true).structuredContent,
    }).to.deep.equal({
      withFooter: {
        content: [{ type: "text", text: "a\ntxId: x" }],
        structuredContent: { clean: false, report: "a\ntxId: x" },
      },
      noFooterReport: { clean: true, report: "a" },
    });
  });
});
