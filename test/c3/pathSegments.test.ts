import { describe, it } from "mocha";
import { assert } from "chai";
import { reservedDeviceName } from "../../src/c3/pathSegments.js";

const SUP1 = String.fromCharCode(0xb9);
const SUP3 = String.fromCharCode(0xb3);
const DOTLESS_I = String.fromCharCode(0x131);

function mapOf(inputs: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const s of inputs) out[s] = reservedDeviceName(s);
  return out;
}

describe("pathSegments", () => {
  it("DN330-R1: reservedDeviceName names the device behind every refused spelling", () => {
    const expected: Record<string, string | undefined> = {
      nul: "NUL",
      Con: "CON",
      "NUL.json": "NUL",
      "con.txt": "CON",
      "NUL.": "NUL",
      "NUL ": "NUL",
      "NUL .json": "NUL",
      "NUL.tar.gz": "NUL",
      CONIN$: "CONIN$",
      conout$: "CONOUT$",
      ["COM" + SUP1]: "COM" + SUP1,
      ["lpt" + SUP3 + ".json"]: "LPT" + SUP3,
      COM1: "COM1",
      LPT9: "LPT9",
      AUX: "AUX",
      "PRN.x": "PRN",
    };
    assert.deepEqual(mapOf(Object.keys(expected)), expected);
  });

  it("DN330-R2: reservedDeviceName accepts near-misses and non-device names", () => {
    const inputs = [
      "CONSOLE",
      "NULL",
      "Con1",
      "COM0",
      "LPT0",
      "NUL_x",
      "NULx.json",
      "xNUL",
      "COM10",
      "LPT" + SUP1 + "0",
      " NUL",
      ".NUL",
      "a.NUL",
      "CONIN",
      "CON$",
      "con" + DOTLESS_I + "n$",
    ];
    const expected: Record<string, undefined> = {};
    for (const s of inputs) expected[s] = undefined;
    assert.deepEqual(mapOf(inputs), expected);
  });
});
