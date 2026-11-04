import { describe, it } from "mocha";
import { assert } from "chai";
import { lookupObjectTypeByName, objectClassNameMatches } from "../../src/c3/objectTypeIdentity.js";

describe("objectTypeIdentity", () => {
  it("I260-H1: objectClassNameMatches tags kinds, ignores letter case, returns both kinds for one name", () => {
    const listing = {
      objectTypes: ["objectTypes/Sprite.json", "objectTypes/Sub/sprite.json", "objectTypes/Other.json"],
      families: ["families/Sub/SPRITE.json", "families/TextFamily.json"],
    };
    assert.deepEqual(
      {
        both: objectClassNameMatches(listing, "Sprite"),
        lowerQuery: objectClassNameMatches(listing, "sprite"),
        familyOnly: objectClassNameMatches(listing, "textfamily"),
        objectTypeOnly: objectClassNameMatches(listing, "OTHER"),
        none: objectClassNameMatches(listing, "Nope"),
        emptyListing: objectClassNameMatches({ objectTypes: [], families: [] }, "Sprite"),
      },
      {
        both: [
          { path: "objectTypes/Sprite.json", kind: "objectType" },
          { path: "objectTypes/Sub/sprite.json", kind: "objectType" },
          { path: "families/Sub/SPRITE.json", kind: "family" },
        ],
        lowerQuery: [
          { path: "objectTypes/Sprite.json", kind: "objectType" },
          { path: "objectTypes/Sub/sprite.json", kind: "objectType" },
          { path: "families/Sub/SPRITE.json", kind: "family" },
        ],
        familyOnly: [{ path: "families/TextFamily.json", kind: "family" }],
        objectTypeOnly: [{ path: "objectTypes/Other.json", kind: "objectType" }],
        none: [],
        emptyListing: [],
      },
    );
  });

  it("SR1: lookupObjectTypeByName dispositions on a synthetic listing", () => {
    const flat = ["objectTypes/Text.json"];
    const exactTwice = ["objectTypes/Text.json", "objectTypes/tiles/Text.json"];
    const exactAndVariant = ["objectTypes/Text.json", "objectTypes/tiles/text.json"];
    assert.deepEqual(
      {
        found: lookupObjectTypeByName(flat, "Text"),
        caseMismatch: lookupObjectTypeByName(flat, "text"),
        ambiguousExact: lookupObjectTypeByName(exactTwice, "Text"),
        ambiguousVariant: lookupObjectTypeByName(exactAndVariant, "Text"),
        notFound: lookupObjectTypeByName(flat, "Nope"),
      },
      {
        found: { kind: "found", path: "objectTypes/Text.json" },
        caseMismatch: { kind: "case-mismatch", onDisk: "objectTypes/Text.json" },
        ambiguousExact: { kind: "ambiguous", matches: exactTwice },
        ambiguousVariant: { kind: "ambiguous", matches: exactAndVariant },
        notFound: { kind: "not-found" },
      },
    );
  });
});
