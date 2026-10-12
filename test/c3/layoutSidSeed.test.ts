import { describe, it } from "mocha";
import { assert } from "chai";
import path from "node:path";
import { seedLayoutSids } from "../../src/c3/layoutSidSeed.js";

describe("layoutSidSeed (#253)", () => {
  it("SS1: a bare layout key is seeded from its canonical layouts/ path", () => {
    const read: string[] = [];
    const used = new Set<number>();
    seedLayoutSids("/root", { "Gameplay/Main Layout": {} }, used, (p) => {
      read.push(p);
      return JSON.stringify({ sid: 123456789012345 });
    });
    assert.deepEqual(read, [path.join("/root", "layouts/Gameplay/Main Layout.json")]);
    assert.isTrue(used.has(123456789012345));
  });

  it("SS2: an escaping key is skipped without a read", () => {
    const read: string[] = [];
    seedLayoutSids("/root", { "../x": {} }, new Set<number>(), (p) => {
      read.push(p);
      return undefined;
    });
    assert.deepEqual(read, []);
  });
});
