import { expect } from "chai";
import {
  layoutNameIssue,
  layoutNameIssueText,
  objectClassNameIssue,
  objectClassNameIssueText,
} from "../../src/c3/c3NameRules.js";

const NBSP = String.fromCharCode(0xa0);
const SOFT_HYPHEN = String.fromCharCode(0xad);
const BACKSLASH = String.fromCharCode(92);

const kindOf = (name: string): string | undefined => layoutNameIssue(name)?.kind;
const objKindOf = (name: string): string | undefined => objectClassNameIssue(name)?.kind;
const textOf = (name: string): string | undefined => {
  const issue = objectClassNameIssue(name);
  return issue === undefined ? undefined : objectClassNameIssueText(issue);
};

describe("c3NameRules", () => {
  it("I260-N1: layoutNameIssue refuses forbidden characters, edge dots and spaces, 200 characters and device names", () => {
    const names = [
      "a/b",
      "a:b",
      "a*b",
      "a?b",
      'a"b',
      "a<b",
      "a>b",
      "a|b",
      "a~b",
      `a${BACKSLASH}b`,
      ".x",
      "x.",
      " x",
      `${NBSP}x`,
      "a".repeat(200),
      "NUL",
    ];
    expect(names.map((n) => [n.length > 20 ? "200xa" : n, kindOf(n)])).to.deep.equal([
      ["a/b", "forbidden-char"],
      ["a:b", "forbidden-char"],
      ["a*b", "forbidden-char"],
      ["a?b", "forbidden-char"],
      ['a"b', "forbidden-char"],
      ["a<b", "forbidden-char"],
      ["a>b", "forbidden-char"],
      ["a|b", "forbidden-char"],
      ["a~b", "forbidden-char"],
      [`a${BACKSLASH}b`, "forbidden-char"],
      [".x", "edge-dot-or-space"],
      ["x.", "edge-dot-or-space"],
      [" x", "edge-dot-or-space"],
      [`${NBSP}x`, "edge-dot-or-space"],
      ["200xa", "too-long"],
      ["NUL", "reserved-device"],
    ]);
    expect(layoutNameIssueText(layoutNameIssue("a~b")!)).to.equal("must not contain '~'");
    expect(layoutNameIssueText(layoutNameIssue(".x")!)).to.equal("must not start or end with '.' or a space");
    expect(layoutNameIssueText(layoutNameIssue("a".repeat(200))!)).to.equal("must be shorter than 200 characters");
    expect(layoutNameIssueText(layoutNameIssue("NUL")!)).to.equal(
      "must not be a Windows reserved device name: 'NUL' (NUL)",
    );
  });

  it("I260-N2: layoutNameIssue accepts ordinary names, reserved object words and near-miss lengths and devices", () => {
    const names = ["Main Layout", "self", "Selfie", "a.b", "a".repeat(199), "CONSOLE"];
    expect(names.map((n) => layoutNameIssue(n))).to.deep.equal(names.map(() => undefined));
  });

  it("I260-N3: objectClassNameIssue refuses self, true, false and system in any letter case", () => {
    const names = ["self", "Self", "TRUE", "false", "System", "system"];
    expect(names.map((n) => objKindOf(n))).to.deep.equal(names.map(() => "reserved-word"));
    expect(textOf("System")).to.equal(
      "must not be 'System': C3 reserves it (self, true, false and system, letter case ignored)",
    );
  });

  it("I260-N4: objectClassNameIssue accepts names that merely contain a reserved word or a digit", () => {
    const names = ["selfish", "Selfie", "systems", "TextFamily2", "Sprite_2", "9patch"];
    expect(names.map((n) => objectClassNameIssue(n))).to.deep.equal(names.map(() => undefined));
  });

  it("I260-N5: objectClassNameIssue refuses a name C3 would rewrite and names the rewritten form", () => {
    const names = [
      "My Sprite",
      "a..b",
      "My-Sprite",
      "Sprite (2)",
      "_x",
      "123",
      `a${SOFT_HYPHEN}b`,
      `a${NBSP}b`,
      "s-elf",
    ];
    expect(names.map((n) => [n, textOf(n)])).to.deep.equal([
      ["My Sprite", "must be a name C3 keeps as written: C3 would load it as 'MySprite'"],
      ["a..b", "must be a name C3 keeps as written: C3 would load it as 'ab'"],
      ["My-Sprite", "must be a name C3 keeps as written: C3 would load it as 'MySprite'"],
      ["Sprite (2)", "must be a name C3 keeps as written: C3 would load it as 'Sprite2'"],
      ["_x", "must be a name C3 keeps as written: C3 would load it as 'x'"],
      ["123", "must be a name C3 keeps as written: C3 would load it as an empty name"],
      [`a${SOFT_HYPHEN}b`, "must be a name C3 keeps as written: C3 would load it as 'ab'"],
      [`a${NBSP}b`, "must be a name C3 keeps as written: C3 would load it as 'ab'"],
      ["s-elf", "must be a name C3 keeps as written: C3 would load it as 'self'"],
    ]);
  });
});
