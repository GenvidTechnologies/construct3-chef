import { describe, it } from "mocha";
import { assert } from "chai";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { EventSheet } from "@genvidtech/c3source";
import type { CustomAceIndex } from "../../src/c3/customAceIndex.js";
import { buildCustomAceIndex, validateInsertedCustomActions } from "../../src/c3/customAceIndex.js";

// ─── Test helpers ───

/** Build a minimal EventSheet with no events (used as original/modified base). */
function emptySheet(name = "TestSheet"): EventSheet {
  return { name, events: [], sid: 0 };
}

/**
 * Build an EventSheet that contains a single block event whose actions array
 * holds the given custom-action objects verbatim.
 */
function sheetWithCustomActions(
  actions: Array<{ customAction: string; objectClass: string; sid: number; customActionObjectClass?: string }>,
): EventSheet {
  return {
    name: "TestSheet",
    sid: 0,
    events: [
      {
        eventType: "block",
        sid: 9000,
        conditions: [],
        actions: actions as unknown as [],
      },
    ],
  };
}

/**
 * Build a hand-wired `CustomAceIndex` from plain data, without touching the disk.
 *
 * @param aces    `[objectClass, aceName]` pairs that ARE defined.
 * @param families  `{ familyName: memberNames[] }` membership map.
 */
function buildTestIndex(aces: Array<[string, string]>, families: Record<string, string[]> = {}): CustomAceIndex {
  const aceMap = new Map<string, Set<string>>();
  for (const [oc, name] of aces) {
    let s = aceMap.get(oc);
    if (!s) {
      s = new Set();
      aceMap.set(oc, s);
    }
    s.add(name);
  }

  const familyToMembers = new Map<string, Set<string>>();
  const memberToFamilies = new Map<string, Set<string>>();
  for (const [fam, members] of Object.entries(families)) {
    const ms = new Set(members);
    familyToMembers.set(fam, ms);
    for (const m of members) {
      let fs2 = memberToFamilies.get(m);
      if (!fs2) {
        fs2 = new Set();
        memberToFamilies.set(m, fs2);
      }
      fs2.add(fam);
    }
  }

  const emptySet: ReadonlySet<string> = new Set();
  return {
    hasAce: (oc, n) => aceMap.get(oc)?.has(n) ?? false,
    familiesOf: (oc) => memberToFamilies.get(oc) ?? emptySet,
    membersOf: (fam) => familyToMembers.get(fam) ?? emptySet,
  };
}

// ─── Pure validator tests ───

describe("validateInsertedCustomActions", () => {
  it("returns no errors when action is defined directly on objectClass (no family)", () => {
    const index = buildTestIndex([["CardScroller", "Initialize"]]);
    const original = emptySheet();
    const modified = sheetWithCustomActions([{ customAction: "Initialize", objectClass: "CardScroller", sid: 1001 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });

  it("returns error with family hint when action is on a family but no family key is set", () => {
    const index = buildTestIndex(
      [["Movables", "Move"]], // 'Move' is defined on family 'Movables', NOT on 'Sprite'
      { Movables: ["Sprite", "Enemy"] },
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([{ customAction: "Move", objectClass: "Sprite", sid: 1002 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /provided by family "Movables"/);
    assert.match(errors[0], /"Sprite"/);
    assert.match(errors[0], /set \{ "family": "Movables" \}/);
  });

  it("returns no errors when family key is correct (action on family + objectClass is member)", () => {
    const index = buildTestIndex([["Movables", "Move"]], { Movables: ["Sprite", "Enemy"] });
    const original = emptySheet();
    const modified = sheetWithCustomActions([
      { customAction: "Move", objectClass: "Sprite", sid: 1003, customActionObjectClass: "Movables" },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });

  it("returns error when specified family does not define the action", () => {
    const index = buildTestIndex(
      [["OtherFamily", "Fly"]], // 'Move' is NOT defined on 'Movables'
      { Movables: ["Sprite"] },
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([
      { customAction: "Move", objectClass: "Sprite", sid: 1004, customActionObjectClass: "Movables" },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Move"/);
    assert.match(errors[0], /"Movables"/);
    assert.match(errors[0], /not defined on family/);
  });

  it("returns error when objectClass is not a member of the specified family", () => {
    const index = buildTestIndex(
      [["Movables", "Move"]],
      { Movables: ["Enemy"] }, // 'Sprite' is NOT in Movables
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([
      { customAction: "Move", objectClass: "Sprite", sid: 1005, customActionObjectClass: "Movables" },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Sprite"/);
    assert.match(errors[0], /not a member of family "Movables"/);
  });

  it("returns error (no family hint) when action is not defined anywhere reachable", () => {
    const index = buildTestIndex(
      [], // nothing defined
      { Movables: ["Sprite"] }, // Sprite IS in a family, but Movables has no 'Teleport' ace
    );
    const original = emptySheet();
    const modified = sheetWithCustomActions([{ customAction: "Teleport", objectClass: "Sprite", sid: 1006 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"Teleport"/);
    assert.match(errors[0], /"Sprite"/);
    assert.match(errors[0], /not defined on "Sprite" or any family/);
  });

  it("skips actions already present in original (same sid)", () => {
    // Action sid 1007 already exists in original — should NOT be validated
    const index = buildTestIndex([]); // empty index — would fail if validated
    const original = sheetWithCustomActions([{ customAction: "OldAction", objectClass: "Sprite", sid: 1007 }]);
    const modified = sheetWithCustomActions([{ customAction: "OldAction", objectClass: "Sprite", sid: 1007 }]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });

  it("only validates the NEW action when original has one and modified has an additional new one", () => {
    // sid 1008 is pre-existing (OK to skip); sid 1009 is inserted (must validate)
    const index = buildTestIndex([["CardScroller", "Initialize"]]);
    const original = sheetWithCustomActions([{ customAction: "OldAction", objectClass: "SomeObj", sid: 1008 }]);
    const modified = sheetWithCustomActions([
      { customAction: "OldAction", objectClass: "SomeObj", sid: 1008 },
      { customAction: "Initialize", objectClass: "CardScroller", sid: 1009 },
    ]);

    const errors = validateInsertedCustomActions(index, original, modified);
    assert.deepStrictEqual(errors, []);
  });
});

// ─── buildCustomAceIndex integration tests ───

describe("buildCustomAceIndex", () => {
  const fixtureDir = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
    "..",
    "fixtures",
    "construct3-chef-sample",
  );

  it("builds without throwing on the real fixture project", () => {
    assert.doesNotThrow(() => buildCustomAceIndex(fixtureDir));
  });

  it("loads families from the fixture project", () => {
    const index = buildCustomAceIndex(fixtureDir);
    // TextFamily has members Text2 and Text
    const textFamilyMembers = index.membersOf("TextFamily");
    assert.isTrue(textFamilyMembers.has("Text"), "TextFamily should include 'Text'");
    assert.isTrue(textFamilyMembers.has("Text2"), "TextFamily should include 'Text2'");

    // Reverse: Text2 should belong to TextFamily
    const text2Families = index.familiesOf("Text2");
    assert.isTrue(text2Families.has("TextFamily"), "Text2 should belong to TextFamily");
  });

  it("indexes the custom-ace definition from the fixture's NavButton.OnClickAction block", () => {
    const index = buildCustomAceIndex(fixtureDir);
    // Event sheet 1 carries a `custom-ace-block` defining NavButton.OnClickAction.
    assert.isTrue(index.hasAce("NavButton", "OnClickAction"));
    // Negative half: a hasAce that answered `true` unconditionally would pass the positive alone.
    assert.isFalse(index.hasAce("NavButton", "NoSuchAction"));
  });

  it("returns empty family sets for an unknown object", () => {
    const index = buildCustomAceIndex(fixtureDir);
    const families = index.familiesOf("NoSuchObject");
    assert.equal(families.size, 0);
  });

  it("handles absent families dir gracefully via a temp project dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      // Create a minimal event-sheets directory with one empty sheet
      const esDir = path.join(tmpDir, "eventSheets");
      fs.mkdirSync(esDir, { recursive: true });
      fs.writeFileSync(
        path.join(esDir, "EmptySheet.json"),
        JSON.stringify({ name: "EmptySheet", events: [], sid: 1 }, null, "\t") + "\n",
      );
      // No families/ directory — should not throw

      let index: CustomAceIndex | undefined;
      assert.doesNotThrow(() => {
        index = buildCustomAceIndex(tmpDir);
      });
      assert.equal(index!.familiesOf("AnyObject").size, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records custom-ace definitions from a hand-authored temp project", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      const esDir = path.join(tmpDir, "eventSheets");
      fs.mkdirSync(esDir, { recursive: true });

      // Craft an event sheet with a custom-ace-block for 'MyWidget.DoSomething'
      const sheet = {
        name: "WidgetSheet",
        sid: 1,
        events: [
          {
            eventType: "custom-ace-block",
            aceType: "action",
            aceName: "DoSomething",
            objectClass: "MyWidget",
            functionDescription: "",
            functionCategory: "",
            functionReturnType: "none",
            functionCopyPicked: false,
            functionIsAsync: false,
            functionParameters: [],
            conditions: [],
            actions: [],
            sid: 2,
          },
        ],
      };
      fs.writeFileSync(path.join(esDir, "WidgetSheet.json"), JSON.stringify(sheet, null, "\t") + "\n");

      // Also add a family
      const familiesDir = path.join(tmpDir, "families");
      fs.mkdirSync(familiesDir, { recursive: true });
      fs.writeFileSync(
        path.join(familiesDir, "Widgets.json"),
        JSON.stringify({ name: "Widgets", members: ["MyWidget", "OtherWidget"] }, null, "\t") + "\n",
      );

      const index = buildCustomAceIndex(tmpDir);

      assert.isTrue(index.hasAce("MyWidget", "DoSomething"), "should detect MyWidget.DoSomething");
      assert.isFalse(index.hasAce("MyWidget", "NoSuchAction"), "should not detect undefined action");
      assert.isTrue(index.membersOf("Widgets").has("MyWidget"), "Widgets family should include MyWidget");
      assert.isTrue(index.familiesOf("MyWidget").has("Widgets"), "MyWidget should belong to Widgets");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── #152 nested-families + editor-local exclusion (A1, A2, B, C, C2, F152) ───

/**
 * Seed a minimal temp project: an `eventSheets/WidgetSheet.json` carrying a
 * `custom-ace-block` for `Widgets.DoSomething` (defined on the FAMILY, per the
 * Case-A shape `validateInsertedCustomActions` expects — see
 * `buildTestIndex([["Movables","Move"]], {Movables:[...]})` above), and a
 * nested real family at `families/Sub/Widgets.json` =
 * `{name:"Widgets",members:["MyWidget"]}`, plus a flat sibling
 * `families/Flat.json` = `{name:"Flat",members:["MyWidget"]}` (proves the walk
 * still finds top-level families, not just subfolders).
 *
 * The nested `Widgets` family doubles as the **in-test positive control** for
 * every editor-local-exclusion test below (B/C/C2): a wholly-broken walk
 * (returns nothing) would fail their control assertion rather than passing
 * their negative assertion vacuously.
 */
function seedNestedFamilyProject(tmpDir: string): void {
  const esDir = path.join(tmpDir, "eventSheets");
  fs.mkdirSync(esDir, { recursive: true });
  const sheet = {
    name: "WidgetSheet",
    sid: 1,
    events: [
      {
        eventType: "custom-ace-block",
        aceType: "action",
        aceName: "DoSomething",
        objectClass: "Widgets",
        functionDescription: "",
        functionCategory: "",
        functionReturnType: "none",
        functionCopyPicked: false,
        functionIsAsync: false,
        functionParameters: [],
        conditions: [],
        actions: [],
        sid: 2,
      },
    ],
  };
  fs.writeFileSync(path.join(esDir, "WidgetSheet.json"), JSON.stringify(sheet, null, "\t") + "\n");

  const subFamiliesDir = path.join(tmpDir, "families", "Sub");
  fs.mkdirSync(subFamiliesDir, { recursive: true });
  fs.writeFileSync(
    path.join(subFamiliesDir, "Widgets.json"),
    JSON.stringify({ name: "Widgets", members: ["MyWidget"] }, null, "\t") + "\n",
  );

  const familiesDir = path.join(tmpDir, "families");
  fs.writeFileSync(
    path.join(familiesDir, "Flat.json"),
    JSON.stringify({ name: "Flat", members: ["MyWidget"] }, null, "\t") + "\n",
  );
}

describe("buildCustomAceIndex — #152 nested families + editor-local exclusion", () => {
  it("A1: registers a family nested under families/Sub/ in both membership maps, alongside a flat sibling", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      seedNestedFamilyProject(tmpDir);
      const index = buildCustomAceIndex(tmpDir);

      assert.isTrue(index.membersOf("Widgets").has("MyWidget"), "nested Widgets family should include MyWidget");
      assert.isTrue(index.familiesOf("MyWidget").has("Widgets"), "MyWidget should belong to nested Widgets family");
      // Proves the walk didn't merely move to subfolders-only — the flat sibling
      // family must still register.
      assert.isTrue(index.membersOf("Flat").has("MyWidget"), "flat sibling Flat family should still register");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("A2: a recipe-inserted family-provided custom action against a NESTED family validates with zero errors", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      seedNestedFamilyProject(tmpDir);
      const index = buildCustomAceIndex(tmpDir);

      const original = emptySheet();
      const modifiedOk = sheetWithCustomActions([
        { customAction: "DoSomething", objectClass: "MyWidget", sid: 5001, customActionObjectClass: "Widgets" },
      ]);
      const okErrors = validateInsertedCustomActions(index, original, modifiedOk);
      assert.deepStrictEqual(okErrors, [], "nested-family membership should validate with zero errors");

      // Paired negative: an objectClass that is NOT a member of the family must
      // still produce exactly one error — proving the validator didn't just
      // become permissive.
      const modifiedBad = sheetWithCustomActions([
        { customAction: "DoSomething", objectClass: "NotAMember", sid: 5002, customActionObjectClass: "Widgets" },
      ]);
      const badErrors = validateInsertedCustomActions(index, original, modifiedBad);
      assert.equal(badErrors.length, 1);
      assert.match(badErrors[0], /"NotAMember" is not a member of family "Widgets"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("B (fileSuffixes): a families/*.uistate.json carrying valid {name,members} contributes no family entry", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      seedNestedFamilyProject(tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, "families", "Ghost.uistate.json"),
        JSON.stringify({ name: "Ghost", members: ["X"] }, null, "\t") + "\n",
      );

      const index = buildCustomAceIndex(tmpDir);

      // In-test positive control: the nested real family must still register,
      // proving the walk ran and reached files.
      assert.isTrue(index.membersOf("Widgets").has("MyWidget"), "control: nested Widgets family must register");

      assert.equal(index.membersOf("Ghost").size, 0, "a *.uistate.json family record must not be registered");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("C (dirs): a families/uistate/Ghost.json carrying valid {name,members} contributes no family entry", () => {
    // NOTE: this row has NO dimension-red of its own at HEAD — at HEAD the
    // families walk is flat (readdirSync, no recursion), so it can never see a
    // file nested under families/uistate/ regardless of editor-local filtering.
    // It is invisible for the WRONG reason, not because HEAD correctly excludes
    // it. This test is red at HEAD only via its embedded nested-real-family
    // control (shared with A1, seeded by seedNestedFamilyProject): that control
    // is itself red at HEAD (flat walk can't see families/Sub/Widgets.json
    // either), and once green it proves the walk descends into subfolders —
    // the exact property this negative assertion depends on to be meaningful
    // post-fix. Do not mistake this for a genuine dimension-red.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      seedNestedFamilyProject(tmpDir);
      const uistateDir = path.join(tmpDir, "families", "uistate");
      fs.mkdirSync(uistateDir, { recursive: true });
      fs.writeFileSync(
        path.join(uistateDir, "Ghost.json"),
        JSON.stringify({ name: "Ghost", members: ["X"] }, null, "\t") + "\n",
      );

      const index = buildCustomAceIndex(tmpDir);

      // Control (shared with A1): proves the walk descends into subfolders.
      assert.isTrue(index.membersOf("Widgets").has("MyWidget"), "control: nested Widgets family must register");

      assert.equal(index.membersOf("Ghost").size, 0, "a families/uistate/*.json family record must not be registered");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("C2 (exactNames): a families/tsconfig.json carrying valid {name,members} contributes no family entry", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      seedNestedFamilyProject(tmpDir);
      fs.writeFileSync(
        path.join(tmpDir, "families", "tsconfig.json"),
        JSON.stringify({ name: "Ghost", members: ["X"] }, null, "\t") + "\n",
      );

      const index = buildCustomAceIndex(tmpDir);

      // In-test positive control: the nested real family must still register.
      assert.isTrue(index.membersOf("Widgets").has("MyWidget"), "control: nested Widgets family must register");

      // tsconfig.json ends in .json, so it passes a hand-written .endsWith(".json")
      // filter — this is the dimension a naive predicate cannot express.
      assert.equal(index.membersOf("Ghost").size, 0, "a families/tsconfig.json family record must not be registered");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("F152: a present-but-unreadable families/ (a regular file, not a directory) fails loudly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chef-test-"));
    try {
      // Minimal eventSheets/ dir so the unrelated event-sheet walk (which throws
      // on a missing eventSheets/ dir today) doesn't trip first.
      fs.mkdirSync(path.join(tmpDir, "eventSheets"), { recursive: true });
      // families is a REGULAR FILE, not a directory — portable and deterministic,
      // no chmod needed.
      fs.writeFileSync(path.join(tmpDir, "families"), "not a directory");

      assert.throws(() => buildCustomAceIndex(tmpDir), /could not read families/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
