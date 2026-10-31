import { describe, it } from "mocha";
import { assert } from "chai";
import { canonicalizeRecipeKey, keyIssue, identity } from "../../src/c3/recipeKeys.js";

describe("recipeKeys", () => {
  it("KI12: canonicalizeRecipeKey spells section and extension canonically and is idempotent", () => {
    const table: Array<[string, "eventSheets" | "layouts", string]> = [
      ["Gameplay/Event sheet 1", "eventSheets", "eventSheets/Gameplay/Event sheet 1.json"],
      ["eventSheets/Gameplay/Event sheet 1.json", "eventSheets", "eventSheets/Gameplay/Event sheet 1.json"],
      ["EventSheets/X", "eventSheets", "eventSheets/X.json"],
      ["X.JSON", "eventSheets", "eventSheets/X.json"],
      ["Gameplay\\X", "eventSheets", "eventSheets/Gameplay/X.json"],
      ["./X", "eventSheets", "eventSheets/X.json"],
      ["a//b", "eventSheets", "eventSheets/a/b.json"],
      ["Gameplay/Level 1", "layouts", "layouts/Gameplay/Level 1.json"],
      ["layouts/Gameplay/Level 1.json", "layouts", "layouts/Gameplay/Level 1.json"],
      ["Layouts/X", "layouts", "layouts/X.json"],
      ["X.JSON", "layouts", "layouts/X.json"],
      ["Gameplay\\X", "layouts", "layouts/Gameplay/X.json"],
      ["./X", "layouts", "layouts/X.json"],
      ["a//b", "layouts", "layouts/a/b.json"],
    ];
    for (const [input, section, expected] of table) {
      const got = canonicalizeRecipeKey(input, section);
      assert.equal(got, expected, `${section}: ${JSON.stringify(input)}`);
      assert.equal(canonicalizeRecipeKey(got, section), got, `idempotent: ${JSON.stringify(input)}`);
    }
    assert.equal(identity("eventSheets/Foo.json"), "eventsheets/foo.json");
    // A rejected key is never resolved into a different key.
    assert.equal(canonicalizeRecipeKey("eventSheets/../layouts/Foo", "eventSheets"), "eventSheets/../layouts/Foo");
  });

  it("KI13: keyIssue rejects '..', absolute/drive and empty-name keys, accepts normal ones", () => {
    const bad = [
      "../x",
      "a/../b",
      "eventSheets/../layouts/Foo",
      "/eventSheets/X.json",
      "C:/x",
      "C:\\x",
      "",
      "eventSheets/",
      ".json",
      // W1: a trailing slash names a folder, not a file (interior `//` is still collapsed, see KI12).
      "Gameplay/",
      "Gameplay/Sheet.json/",
      "Gameplay\\",
      // W2: ':' is an NTFS alternate data stream on Windows and a literal name elsewhere.
      "Gameplay/C:foo",
      "a:b",
      "Gameplay/Sheet.json:stream",
      // S3: Windows strips trailing spaces and dots, so these segments are '.' / '..' in disguise.
      "a/.. /b",
      "a/.../b",
      "a/. /b",
    ];
    for (const key of bad) {
      assert.isString(keyIssue(key, "eventSheets"), `expected an issue for ${JSON.stringify(key)}`);
    }
    assert.isString(keyIssue("layouts/", "layouts"), "a bare layouts folder names no layout");
    const good = ["X", "Gameplay/Event sheet 1", "eventSheets/Gameplay/X.json", "Gameplay\\X", "./X", "a//b", "X.JSON"];
    for (const key of good) {
      assert.isUndefined(keyIssue(key, "eventSheets"), `expected no issue for ${JSON.stringify(key)}`);
    }
    // Only the key's own section folder is stripped: a files key "layouts" names a real top-level sheet.
    assert.isUndefined(keyIssue("layouts", "eventSheets"), "a files key named layouts is a real sheet");
    assert.isUndefined(keyIssue("eventSheets", "layouts"), "a layouts key named eventSheets is a real layout");
  });

  // #330 helpers: L-key wording, and one object per section so a deep.equal reports every input.
  const lKey = (seg: string, dev: string): string =>
    `must not contain a segment that is a Windows reserved device name: '${seg}' (${dev})`;
  function mapKeys(section: "eventSheets" | "layouts", keys: string[]): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of keys) out[k] = keyIssue(k, section);
    return out;
  }

  it("DN330-R8: keyIssue refuses reserved device names in files keys", () => {
    const keys: Record<string, [string, string]> = {
      NUL: ["NUL", "NUL"],
      "Gameplay/con.txt": ["con.txt", "CON"],
      "CON/Sheet": ["CON", "CON"],
      "eventSheets/NUL .json": ["NUL .json", "NUL"],
      "Gameplay/NUL.": ["NUL.", "NUL"],
    };
    const want: Record<string, string> = {};
    for (const [k, [seg, dev]] of Object.entries(keys)) want[k] = lKey(seg, dev);
    assert.deepEqual(mapKeys("eventSheets", Object.keys(keys)), want);
  });

  it("DN330-R9: keyIssue refuses reserved device names in layouts keys", () => {
    assert.deepEqual(mapKeys("layouts", ["CON", "Gameplay/LPT1"]), {
      CON: lKey("CON", "CON"),
      "Gameplay/LPT1": lKey("LPT1", "LPT1"),
    });
  });

  it("DN330-R10: near-miss keys are accepted in both sections", () => {
    const keys = ["CONSOLE", "NULL", "Con1", "COM0", "LPT0", "NUL_x", "Gameplay/NULx.json"];
    const want: Record<string, undefined> = {};
    for (const k of keys) want[k] = undefined;
    assert.deepEqual(
      { files: mapKeys("eventSheets", keys), layouts: mapKeys("layouts", keys) },
      {
        files: want,
        layouts: want,
      },
    );
  });
});
