import { expect } from "chai";
import type { BlockEvent } from "@genvid/c3source";
import { buildShallowSidMap, type SidMapEntry } from "../../src/c3/dslFormatter.js";
import { renderEventSidRows } from "../../src/mcp/server.js";

// Helper to build a minimal EventSheet-shaped object for tests
function makeSheet(name: string = "TestSheet") {
  return { name, sid: 999, events: [] };
}

// Helper to build a SidMapEntry directly (for cases where we control all fields)
function makeEntry(overrides: Partial<SidMapEntry> & { jsonPath: string }): SidMapEntry {
  return {
    sid: 100000000000001,
    description: "block",
    searchText: "",
    ...overrides,
  };
}

describe("renderEventSidRows", () => {
  it("grep matching only searchText — appends ↳ matched line", () => {
    // Block event with a GoToLayout action whose parameter value "BattleLayout" is
    // only in searchText, not in the visible description ("block").
    const blockEvent: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        {
          id: "go-to-layout",
          objectClass: "System",
          sid: 2,
          parameters: { layout: "BattleLayout" },
        },
      ],
      sid: 101,
    };
    const sheet = makeSheet("GoTest");
    const entries = buildShallowSidMap({ ...sheet, events: [blockEvent] });
    expect(entries).to.have.length(1);
    const entry = entries[0];
    expect(entry.description).to.equal("block");
    expect(entry.searchText).to.include("BattleLayout");

    const rendered = renderEventSidRows([entry], "BattleLayout");

    // The data row must be present
    expect(rendered).to.include("block");
    expect(rendered).to.include("§101");

    // The ↳ matched sub-line must be present and contain the matching searchText line
    expect(rendered).to.include("↳ matched:");
    expect(rendered).to.include("BattleLayout");

    // The ↳ line must appear AFTER the data row
    const dataRowIdx = rendered.indexOf("§101");
    const matchedIdx = rendered.indexOf("↳ matched:");
    expect(dataRowIdx).to.be.lessThan(matchedIdx);
  });

  it("grep matching description — NO ↳ matched line", () => {
    const entry = makeEntry({
      jsonPath: "events[0]",
      sid: 200000000000001,
      description: 'function "onBattleStart"',
      searchText: "System.on-start-of-layout",
    });

    // "onBattleStart" is in the description → should NOT add the ↳ line
    const rendered = renderEventSidRows([entry], "onBattleStart");

    expect(rendered).to.include("onBattleStart");
    expect(rendered).to.not.include("↳ matched:");
  });

  it("no grep — output contains no ↳ lines regardless of searchText content", () => {
    const blockEvent: BlockEvent = {
      eventType: "block",
      conditions: [],
      actions: [
        {
          id: "go-to-layout",
          objectClass: "System",
          sid: 3,
          parameters: { layout: "BattleLayout" },
        },
      ],
      sid: 102,
    };
    const sheet = makeSheet("NoGrepTest");
    const entries = buildShallowSidMap({ ...sheet, events: [blockEvent] });
    expect(entries).to.have.length(1);

    const rendered = renderEventSidRows(entries);

    // Data row present
    expect(rendered).to.include("§102");
    // No ↳ line
    expect(rendered).to.not.include("↳");
  });

  it("grep matches description AND searchText — description match wins, no ↳ line", () => {
    // Both description and searchText contain the same term
    const entry = makeEntry({
      jsonPath: "events[0]",
      sid: 300000000000001,
      description: "block [DISABLED]",
      searchText: "System.go-to-layout(layout=BattleLayout)\n[DISABLED] action",
    });

    // "[DISABLED]" appears in both description and searchText
    const rendered = renderEventSidRows([entry], "DISABLED");

    expect(rendered).to.include("block");
    // Since description matches, no ↳ line should be appended
    expect(rendered).to.not.include("↳ matched:");
  });

  it("grep case-insensitive — ↳ line appears when matching searchText case-insensitively", () => {
    const entry = makeEntry({
      jsonPath: "events[0]",
      sid: 400000000000001,
      description: "block",
      searchText: "System.GoToLayout(layout=BattleLayout)",
    });

    // "gotolayout" is lowercase, but the searchText has "GoToLayout"
    const rendered = renderEventSidRows([entry], "gotolayout");

    expect(rendered).to.include("↳ matched:");
    expect(rendered).to.include("GoToLayout");
  });

  it("multiple entries — ↳ line only appended to entries that matched via searchText", () => {
    const entryViaDesc = makeEntry({
      jsonPath: "events[0]",
      sid: 500000000000001,
      description: 'function "doSetup"',
      searchText: "System.wait(0.5)",
    });
    const entryViaSearch = makeEntry({
      jsonPath: "events[1]",
      sid: 500000000000002,
      description: "block",
      searchText: "System.go-to-layout(layout=BattleLayout)",
    });

    const rendered = renderEventSidRows([entryViaDesc, entryViaSearch], "doSetup|BattleLayout");
    const lines = rendered.split("\n");

    // First entry row (matched via description) must NOT be followed by ↳ line
    const firstDataRowIdx = lines.findIndex((l) => l.includes("§500000000000001"));
    expect(firstDataRowIdx).to.be.greaterThanOrEqual(0);
    if (firstDataRowIdx + 1 < lines.length) {
      expect(lines[firstDataRowIdx + 1]).to.not.include("↳ matched:");
    }

    // Second entry row (matched via searchText) MUST be followed by ↳ line
    const secondDataRowIdx = lines.findIndex((l) => l.includes("§500000000000002"));
    expect(secondDataRowIdx).to.be.greaterThanOrEqual(0);
    const nextLine = lines[secondDataRowIdx + 1];
    expect(nextLine).to.include("↳ matched:");
    expect(nextLine).to.include("BattleLayout");
  });

  it("first matching searchText line — picks the first line the regex hits", () => {
    const entry = makeEntry({
      jsonPath: "events[0]",
      sid: 600000000000001,
      description: "block",
      // Two lines in searchText; the regex should hit the first one
      searchText: "System.go-to-layout(layout=BattleLayout)\nSystem.wait(1)",
    });

    const rendered = renderEventSidRows([entry], "BattleLayout");
    expect(rendered).to.include("↳ matched: System.go-to-layout(layout=BattleLayout)");
    // The second line should not appear in the ↳
    expect(rendered).to.not.include("wait");
  });

  it("empty searchText — no ↳ line even when regex would match empty string", () => {
    const entry = makeEntry({
      jsonPath: "events[0]",
      sid: 700000000000001,
      description: "block",
      searchText: "",
    });

    // A catch-all regex that would match empty string; searchText is empty so
    // the find() over split("\n") would hit "", but the guard `e.searchText`
    // prevents entry into the ↳ branch entirely.
    const rendered = renderEventSidRows([entry], ".*");

    // The .*  matches description too, so no ↳ anyway — but let's confirm no ↳
    expect(rendered).to.not.include("↳ matched:");
  });
});
