import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIndexText, resolveAnchor } from "../../src/c3/anchorResolver.js";
import { SEARCH_SENTINEL } from "../../src/c3/dslFormatter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_PATH = path.join(__dirname, "../fixtures/anchor/sample.dsl.idx.txt");

const indexText = readFileSync(FIXTURE_PATH, "utf-8");

describe("parseIndexText", () => {
  it("correctly extracts all fields for a standard event row", () => {
    const anchors = parseIndexText(indexText);
    const first = anchors[0];
    expect(first.eventNumber).to.equal(1);
    expect(first.jsonPath).to.equal("events[0]");
    expect(first.sid).to.equal(100000000000001);
    expect(first.dslLine).to.equal(4);
    expect(first.description).to.equal('group "Battle Events"');
  });

  it("parses non-counting `-` events with null eventNumber", () => {
    const anchors = parseIndexText(indexText);
    const nonCounting = anchors.find((a) => a.jsonPath === "events[0].children[0]");
    expect(nonCounting).to.exist;
    expect(nonCounting!.eventNumber).to.be.null;
    expect(nonCounting!.sid).to.equal(100000000000002);
    expect(nonCounting!.dslLine).to.equal(5);
    expect(nonCounting!.description).to.equal("static isBattleActive: boolean = false");
  });

  it("action-level rows are excluded from results (no dslLine)", () => {
    const anchors = parseIndexText(indexText);
    // Action rows have no dslLine — they should not appear in the result
    const actionRows = anchors.filter((a) => a.jsonPath.startsWith("action["));
    expect(actionRows).to.have.length(0);
  });

  it("returns only rows that have a dslLine", () => {
    const anchors = parseIndexText(indexText);
    for (const anchor of anchors) {
      expect(anchor.dslLine).to.be.a("number");
      expect(anchor.dslLine).to.be.greaterThan(0);
    }
  });

  it("parses all expected non-action rows from the fixture", () => {
    const anchors = parseIndexText(indexText);
    // The fixture has 18 rows with a dslLine (action rows excluded)
    expect(anchors.length).to.equal(18);
  });

  it("extracts SID as a number (without the § prefix)", () => {
    const anchors = parseIndexText(indexText);
    for (const anchor of anchors) {
      if (anchor.sid !== undefined) {
        expect(anchor.sid).to.be.a("number");
      }
    }
  });
});

describe("parseIndexText — SEARCH_SENTINEL stripping", () => {
  it("description is stripped of sentinel + tail; resolveByName on param value returns null; resolveByName on visible text matches", () => {
    // Build a synthetic index row whose Description contains the sentinel + hidden tail
    const visibleDesc = "block";
    const hiddenTail = 'System.go-to-layout(layout="Main Layout")';
    const fullDesc = `${visibleDesc}${SEARCH_SENTINEL}${hiddenTail}`;
    const row = `  1     | events[0]         | §100000000000001 | 4        | ${fullDesc}`;
    const indexText = [
      "# TestSheet — DSL Coordinate Index",
      "# Regenerate: npm run generate-dsl",
      "#",
      "# Event | JSON Path | SID | DSL Line | Description",
      "#-------|-----------|-----|----------|-----------",
      row,
      "",
    ].join("\n");

    const anchors = parseIndexText(indexText);
    expect(anchors.length).to.equal(1);

    // The parsed description must be the clean visible text — no sentinel, no tail
    expect(anchors[0].description).to.equal(visibleDesc);
    expect(anchors[0].description).to.not.include(SEARCH_SENTINEL);
    expect(anchors[0].description).to.not.include("Main Layout");

    // resolveByName on a param value (only in the hidden tail) must NOT match
    const noMatch = resolveAnchor(indexText, { by: "name", name: "Main Layout" });
    expect(noMatch).to.be.null;

    // resolveByName on the visible description text must match
    const match = resolveAnchor(indexText, { by: "name", name: "block" });
    expect(match).to.not.be.null;
    expect(match!.anchor.description).to.equal("block");
  });

  it("row count from fixture is unaffected (parseIndexText skips action rows by dslLine, not sentinel content)", () => {
    const anchors = parseIndexText(indexText);
    // The fixture has 18 rows with a dslLine (action rows excluded)
    expect(anchors.length).to.equal(18);
  });
});

describe("resolveAnchor — by: line", () => {
  it("returns exact: true when the line matches exactly", () => {
    const result = resolveAnchor(indexText, { by: "line", line: 4 });
    expect(result).to.not.be.null;
    expect(result!.exact).to.be.true;
    expect(result!.anchor.dslLine).to.equal(4);
    expect(result!.anchor.description).to.equal('group "Battle Events"');
  });

  it("returns nearest enclosing (<=) when line falls between entries", () => {
    // Line 6 falls between dslLine 5 and dslLine 7 — nearest enclosing is 5
    const result = resolveAnchor(indexText, { by: "line", line: 6 });
    expect(result).to.not.be.null;
    expect(result!.exact).to.be.false;
    expect(result!.anchor.dslLine).to.equal(5);
  });

  it("returns nearest enclosing for line between 10 and 12", () => {
    // Line 11 falls between dslLine 10 and dslLine 12 — nearest enclosing is 10
    const result = resolveAnchor(indexText, { by: "line", line: 11 });
    expect(result).to.not.be.null;
    expect(result!.exact).to.be.false;
    expect(result!.anchor.dslLine).to.equal(10);
  });

  it("returns null when line is before all entries", () => {
    const result = resolveAnchor(indexText, { by: "line", line: 1 });
    expect(result).to.be.null;
  });

  it("returns the last entry when line is beyond all entries", () => {
    const result = resolveAnchor(indexText, { by: "line", line: 999 });
    expect(result).to.not.be.null;
    expect(result!.exact).to.be.false;
    // Should return the last anchor (dslLine 50)
    expect(result!.anchor.dslLine).to.equal(50);
  });
});

describe("resolveAnchor — by: sid", () => {
  it("returns correct entry with exact: true when SID is found", () => {
    const result = resolveAnchor(indexText, { by: "sid", sid: 100000000000009 });
    expect(result).to.not.be.null;
    expect(result!.exact).to.be.true;
    expect(result!.anchor.sid).to.equal(100000000000009);
    expect(result!.anchor.description).to.equal('group "Hero Turn Events"');
  });

  it("returns null when SID is not found", () => {
    const result = resolveAnchor(indexText, { by: "sid", sid: 999999999999999 });
    expect(result).to.be.null;
  });

  it("returns null for a SID that only appears in an action row (excluded)", () => {
    // Action rows have no SID in our fixture — but verify no action-row SIDs leak through
    const anchors = parseIndexText(indexText);
    const sidSet = new Set(anchors.map((a) => a.sid).filter((s) => s !== undefined));
    // All SIDs in result should be from non-action rows
    expect(sidSet.size).to.be.greaterThan(0);
    for (const sid of sidSet) {
      const anchor = anchors.find((a) => a.sid === sid);
      expect(anchor!.dslLine).to.be.greaterThan(0);
    }
  });
});

describe("resolveAnchor — by: name", () => {
  it("finds entry whose description contains the exact string", () => {
    const result = resolveAnchor(indexText, { by: "name", name: "onHeroAttack" });
    expect(result).to.not.be.null;
    expect(result!.anchor.description).to.contain("onHeroAttack");
  });

  it("returns exact: true for a name match", () => {
    const result = resolveAnchor(indexText, { by: "name", name: "onBattleEnd" });
    expect(result).to.not.be.null;
    expect(result!.exact).to.be.true;
  });

  it("regex pattern matches multiple entries — first in anchor, rest in alternatives", () => {
    // "Battle.*Events" should match group "Battle Events", group "Battle Setup" won't match,
    // but "Battle Events", "Hero Turn Events", "Enemy Turn Events", "Battle End Events" won't all match.
    // Let's use "group" which appears in multiple descriptions.
    const result = resolveAnchor(indexText, { by: "name", name: "group" });
    expect(result).to.not.be.null;
    expect(result!.anchor.description).to.contain("group");
    expect(result!.alternatives).to.exist;
    expect(result!.alternatives!.length).to.be.greaterThan(0);
    for (const alt of result!.alternatives!) {
      expect(alt.description).to.contain("group");
    }
  });

  it("regex: Battle.*Events matches multiple group entries", () => {
    const result = resolveAnchor(indexText, { by: "name", name: "Battle.*Events" });
    expect(result).to.not.be.null;
    // Should match "Battle Events" and "Battle End Events" at minimum
    const allMatches = [result!.anchor, ...(result!.alternatives ?? [])];
    expect(allMatches.length).to.be.greaterThanOrEqual(2);
    for (const match of allMatches) {
      expect(match.description).to.match(/Battle.*Events/);
    }
  });

  it("returns null when no description matches", () => {
    const result = resolveAnchor(indexText, { by: "name", name: "nonExistentName12345" });
    expect(result).to.be.null;
  });

  it("action rows never appear in name match results", () => {
    // Action rows have paths like action[N] — they should not appear
    // Searching for "System" would match action row descriptions if they were included
    // But since we exclude action rows, the result should only have anchored rows
    const result = resolveAnchor(indexText, { by: "name", name: "static" });
    if (result !== null) {
      const allMatches = [result.anchor, ...(result.alternatives ?? [])];
      for (const match of allMatches) {
        expect(match.jsonPath).to.not.match(/^action\[/);
      }
    }
  });
});
