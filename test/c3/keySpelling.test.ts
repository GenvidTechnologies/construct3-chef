import { describe, it } from "mocha";
import { assert } from "chai";
import { findCaseFoldedMatch, findSpellingMismatches } from "../../src/c3/recipeKeys.js";

describe("keySpelling (#253)", () => {
  it("KS1: an ops ref differing only in case from an on-disk file is a mismatch naming the on-disk spelling", () => {
    const got = findSpellingMismatches(
      [{ path: "eventSheets/gameplay/event sheet 1.json", kind: "file" }],
      ["eventSheets/Gameplay/Event sheet 1.json"],
    );
    assert.lengthOf(got, 1);
    assert.deepEqual(got[0]!.onDisk, ["eventSheets/Gameplay"]);
    assert.equal(got[0]!.path, "eventSheets/gameplay/event sheet 1.json");
  });

  it("KS2: an exact match beats a case-folded one, so nothing is flagged", () => {
    const got = findSpellingMismatches(
      [{ path: "eventSheets/foo.json", kind: "file" }],
      ["eventSheets/Foo.json", "eventSheets/foo.json"],
    );
    assert.deepEqual(got, []);
  });

  it("KS3: a CREATE ref checks folder segments only", () => {
    const listing = ["eventSheets/Gameplay/Event sheet 1.json"];
    const got = findSpellingMismatches([{ path: "eventSheets/gameplay/New Sheet.json", kind: "create" }], listing);
    assert.lengthOf(got, 1);
    assert.deepEqual(got[0]!.onDisk, ["eventSheets/Gameplay"]);
    // The leaf is not checked for a create ref.
    assert.deepEqual(
      findSpellingMismatches([{ path: "eventSheets/Gameplay/event SHEET 1.json", kind: "create" }], listing),
      [],
    );
  });

  it("KS4: a nonexistent path is not a mismatch", () => {
    const got = findSpellingMismatches(
      [{ path: "eventSheets/Nowhere/New.json", kind: "file" }],
      ["eventSheets/Gameplay/Event sheet 1.json"],
    );
    assert.deepEqual(got, []);
  });

  it("KS5: layout refs are checked the same way", () => {
    const got = findSpellingMismatches(
      [{ path: "layouts/gameplay/main layout.json", kind: "file" }],
      ["layouts/Gameplay/Main Layout.json"],
    );
    assert.lengthOf(got, 1);
    assert.deepEqual(got[0]!.onDisk, ["layouts/Gameplay"]);
  });

  it("KS13: findCaseFoldedMatch returns the on-disk spelling, and nothing for an exact match", () => {
    assert.deepEqual(findCaseFoldedMatch("eventSheets/foo.json", ["eventSheets/Foo.json"]), ["eventSheets/Foo.json"]);
    assert.deepEqual(findCaseFoldedMatch("eventSheets/Foo.json", ["eventSheets/Foo.json"]), []);
    assert.deepEqual(findCaseFoldedMatch("eventSheets/bar.json", ["eventSheets/Foo.json"]), []);
  });
});
