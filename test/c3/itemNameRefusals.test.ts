import { expect } from "chai";
import { layoutNameRefusal, objectClassNameRefusal } from "../../src/c3/itemNameRefusals.js";

const NBSP = String.fromCharCode(0xa0);
const SOFT_HYPHEN = String.fromCharCode(0xad);

const RESERVED = "(self, true, false and system, letter case ignored)";
const KEEPS = "must be a name C3 keeps as written: C3 would load it as";

describe("itemNameRefusals", () => {
  it("DB4-N1: layoutNameRefusal gives the wording for each kind upstream reports", () => {
    const names = ["a~b", ".x", "...", "a".repeat(200), "NUL"];
    expect(names.map((n) => layoutNameRefusal(n))).to.deep.equal([
      `${KEEPS} 'ab'`,
      `${KEEPS} 'x'`,
      `${KEEPS} an empty name`,
      "must be shorter than 200 characters",
      "must not be a Windows reserved device name: 'NUL' (NUL)",
    ]);
    expect(layoutNameRefusal("ab")).to.equal(undefined);
  });

  it("DB4-N2: layoutNameRefusal accepts names C3 keeps as written", () => {
    const names = ["Main Layout", "self", "Selfie", "a.b", "a".repeat(199), "CONSOLE"];
    expect(names.map((n) => layoutNameRefusal(n))).to.deep.equal(names.map(() => undefined));
  });

  it("DB4-N3: objectClassNameRefusal refuses the reserved words, and System keeps its text", () => {
    const names = ["self", "Self", "TRUE", "false", "System", "system"];
    expect(names.map((n) => objectClassNameRefusal(n))).to.deep.equal(
      names.map((n) => `must not be '${n}': C3 reserves it ${RESERVED}`),
    );
    expect(objectClassNameRefusal("selfish")).to.equal(undefined);
  });

  it("DB4-N4: objectClassNameRefusal accepts names C3 keeps as written", () => {
    const names = ["selfish", "Selfie", "systems", "TextFamily2", "Sprite_2", "9patch", "Timer", "Times"];
    expect(names.map((n) => objectClassNameRefusal(n))).to.deep.equal(names.map(() => undefined));
  });

  it("DB4-N5: objectClassNameRefusal refuses a name C3 would rewrite and names the rewritten form", () => {
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
    expect(names.map((n) => objectClassNameRefusal(n))).to.deep.equal([
      `${KEEPS} 'MySprite'`,
      `${KEEPS} 'ab'`,
      `${KEEPS} 'MySprite'`,
      `${KEEPS} 'Sprite2'`,
      `${KEEPS} 'x'`,
      `${KEEPS} an empty name`,
      `${KEEPS} 'ab'`,
      `${KEEPS} 'ab'`,
      `must not be 's-elf': C3 would load it as 'self', which C3 reserves ${RESERVED}`,
    ]);
    expect(objectClassNameRefusal("MySprite")).to.equal(undefined);
  });

  it("DB4-N6: objectClassNameRefusal refuses a System expression name", () => {
    const names = ["Time", "time", "random", "LayoutName"];
    expect(names.map((n) => objectClassNameRefusal(n))).to.deep.equal(
      names.map((n) => `must not be '${n}': C3 reserves it as a System expression name (letter case ignored)`),
    );
    expect(objectClassNameRefusal("T ime")).to.equal(
      "must not be 'T ime': C3 would load it as 'TIme', which C3 reserves as a System expression name (letter case ignored)",
    );
    expect(objectClassNameRefusal("Timer")).to.equal(undefined);
    expect(objectClassNameRefusal("Times")).to.equal(undefined);
  });

  it("DB4-N7: objectClassNameRefusal gives the device text with the load form", () => {
    expect(objectClassNameRefusal("N-UL")).to.equal(
      "must not be 'N-UL': C3 would load it as 'NUL', a Windows reserved device name (NUL)",
    );
    expect(objectClassNameRefusal("NULL")).to.equal(undefined);
  });
});
