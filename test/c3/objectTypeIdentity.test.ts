import { describe, it } from "mocha";
import { assert } from "chai";
import { lookupObjectTypeByName } from "../../src/c3/objectTypeIdentity.js";

describe("objectTypeIdentity", () => {
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
