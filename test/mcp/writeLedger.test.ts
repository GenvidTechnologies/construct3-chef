import { expect } from "chai";
import { failureEffects, newWriteLedger, type WriteLedger } from "../../src/mcp/writeLedger.js";

describe("writeLedger (#255)", () => {
  const cases: Array<[WriteLedger, { bump: boolean; dirty: boolean }]> = [
    [
      { source: false, manifest: false, extracted: false },
      { bump: false, dirty: false },
    ],
    [
      { source: true, manifest: false, extracted: false },
      { bump: true, dirty: true },
    ],
    [
      { source: false, manifest: true, extracted: false },
      { bump: true, dirty: false },
    ],
    [
      { source: false, manifest: false, extracted: true },
      { bump: false, dirty: true },
    ],
    [
      { source: true, manifest: true, extracted: false },
      { bump: true, dirty: true },
    ],
    [
      { source: true, manifest: false, extracted: true },
      { bump: true, dirty: true },
    ],
    [
      { source: false, manifest: true, extracted: true },
      { bump: true, dirty: true },
    ],
    [
      { source: true, manifest: true, extracted: true },
      { bump: true, dirty: true },
    ],
  ];

  for (const [ledger, expected] of cases) {
    it(`failureEffects(${JSON.stringify(ledger)})`, () => {
      expect(failureEffects(ledger)).to.deep.equal(expected);
    });
  }

  it("newWriteLedger returns an all-false, fresh object each call", () => {
    const a = newWriteLedger();
    expect(a).to.deep.equal({ source: false, manifest: false, extracted: false });
    a.source = true;
    const b = newWriteLedger();
    expect(b).to.not.equal(a);
    expect(b.source).to.equal(false);
  });
});
