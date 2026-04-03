import { strict as assert } from "node:assert";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateUniqueSid,
  collectSids,
  initSidContextFromSet,
  initSidContext,
  resetSidContext,
} from "../../src/c3/sidUtils.js";

const MIN_SID = 1e14;
const MAX_SID = 1e15;

describe("sidUtils", () => {
  beforeEach(() => {
    resetSidContext();
  });

  describe("generateUniqueSid()", () => {
    it("throws when context is null (not initialized)", () => {
      assert.throws(() => generateUniqueSid(), /not initialized|initSidContext/i);
    });

    it("returns a value in [1e14, 1e15)", () => {
      initSidContextFromSet(new Set());
      const sid = generateUniqueSid();
      assert.ok(sid >= MIN_SID, `sid ${sid} < 1e14`);
      assert.ok(sid < MAX_SID, `sid ${sid} >= 1e15`);
    });

    it("never returns 0", () => {
      initSidContextFromSet(new Set());
      for (let i = 0; i < 20; i++) {
        const sid = generateUniqueSid();
        assert.notEqual(sid, 0);
      }
    });

    it("returns unique values across N calls with empty initial set", () => {
      initSidContextFromSet(new Set());
      const sids = new Set<number>();
      for (let i = 0; i < 50; i++) {
        const sid = generateUniqueSid();
        assert.ok(!sids.has(sid), `duplicate sid ${sid} at call ${i}`);
        sids.add(sid);
      }
    });

    it("avoids SIDs seeded via initSidContextFromSet", () => {
      const seeded = new Set<number>([100000000000000, 100000000000001, 100000000000002]);
      initSidContextFromSet(seeded);
      for (let i = 0; i < 30; i++) {
        const sid = generateUniqueSid();
        assert.ok(!seeded.has(sid), `generated seeded SID ${sid}`);
      }
    });

    it("throws after 100 attempts when forced collision", () => {
      // Fill all possible SIDs in a tiny range, leaving only 1 slot open at the very high end
      // Strategy: override Math.random to return values that always collide
      // Better: use a near-full set covering almost all of [1e14, 1e15)
      // We can't realistically fill 9e14 values, so instead we mock Math.random
      const origRandom = Math.random;
      let callCount = 0;
      // Always return a value that maps to a taken SID
      const takenSid = 100000000000000;
      Math.random = () => {
        callCount++;
        // Always produce the same SID (takenSid)
        // generateUniqueSid: floor(Math.random() * (MAX - MIN)) + MIN
        // So we need (takenSid - MIN) / (MAX - MIN)
        return (takenSid - MIN_SID) / (MAX_SID - MIN_SID);
      };
      try {
        initSidContextFromSet(new Set([takenSid]));
        assert.throws(() => generateUniqueSid(), /100 attempts|collision/i);
      } finally {
        Math.random = origRandom;
      }
    });
  });

  describe("collectSids(json)", () => {
    it("returns empty Set for null input", () => {
      const result = collectSids(null);
      assert.equal(result.size, 0);
    });

    it("returns empty Set for undefined input", () => {
      const result = collectSids(undefined);
      assert.equal(result.size, 0);
    });

    it("returns empty Set for non-object input (string)", () => {
      const result = collectSids("hello");
      assert.equal(result.size, 0);
    });

    it("returns empty Set for empty object", () => {
      const result = collectSids({});
      assert.equal(result.size, 0);
    });

    it("returns empty Set for sid-free JSON", () => {
      const result = collectSids({ name: "foo", count: 3 });
      assert.equal(result.size, 0);
    });

    it("collects top-level numeric sid", () => {
      const result = collectSids({ sid: 12345 });
      assert.ok(result.has(12345));
      assert.equal(result.size, 1);
    });

    it("ignores non-numeric sid values", () => {
      const result = collectSids({ sid: "not-a-number" });
      assert.equal(result.size, 0);
    });

    it("collects sids nested in objects", () => {
      const json = {
        outer: {
          sid: 111,
          inner: { sid: 222 },
        },
      };
      const result = collectSids(json);
      assert.ok(result.has(111));
      assert.ok(result.has(222));
      assert.equal(result.size, 2);
    });

    it("collects sids from arrays", () => {
      const json = [{ sid: 10 }, { sid: 20 }, { sid: 30 }];
      const result = collectSids(json);
      assert.ok(result.has(10));
      assert.ok(result.has(20));
      assert.ok(result.has(30));
      assert.equal(result.size, 3);
    });

    it("handles deeply nested mixed structure", () => {
      const json = {
        sid: 1,
        children: [{ sid: 2, actions: [{ sid: 3 }] }, { sid: 4 }],
        meta: { sid: 5 },
      };
      const result = collectSids(json);
      assert.deepEqual(result, new Set([1, 2, 3, 4, 5]));
    });

    it("handles arrays within arrays", () => {
      const json = [[{ sid: 100 }], [{ sid: 200 }]];
      const result = collectSids(json);
      assert.ok(result.has(100));
      assert.ok(result.has(200));
    });
  });

  describe("initSidContextFromSet()", () => {
    it("populates context so generateUniqueSid avoids those SIDs", () => {
      const existing = new Set<number>([200000000000000, 200000000000001]);
      initSidContextFromSet(existing);
      for (let i = 0; i < 20; i++) {
        const sid = generateUniqueSid();
        assert.ok(!existing.has(sid));
      }
    });

    it("allows generating SIDs after initialization with empty set", () => {
      initSidContextFromSet(new Set());
      const sid = generateUniqueSid();
      assert.ok(sid >= MIN_SID && sid < MAX_SID);
    });
  });

  describe("resetSidContext()", () => {
    it("nulls state so generateUniqueSid throws after reset", () => {
      initSidContextFromSet(new Set());
      generateUniqueSid(); // should not throw
      resetSidContext();
      assert.throws(() => generateUniqueSid(), /not initialized|initSidContext/i);
    });
  });

  describe("initSidContext() with registry file", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "sid-registry-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reads registry file and parses SIDs from first column", () => {
      const registryPath = path.join(tmpDir, "sid-registry.txt");
      const content = [
        "# SID registry",
        "300000000000001\teventSheets/Main.json\tevents[0]",
        "300000000000002\teventSheets/Main.json\tevents[1]",
        "",
        "300000000000003\teventSheets/Other.json\tevents[0]",
      ].join("\n");
      writeFileSync(registryPath, content, "utf-8");

      initSidContext(registryPath);

      // The seeded SIDs should not be generated
      for (let i = 0; i < 30; i++) {
        const sid = generateUniqueSid();
        assert.ok(
          sid !== 300000000000001 && sid !== 300000000000002 && sid !== 300000000000003,
          `generated a registry SID: ${sid}`,
        );
      }
    });

    it("ignores blank lines and comment lines", () => {
      const registryPath = path.join(tmpDir, "sid-registry.txt");
      // Only line 400000000000001 is valid
      const content = ["# comment line", "", "   ", "400000000000001\tsomefile\tlocation", "# another comment"].join(
        "\n",
      );
      writeFileSync(registryPath, content, "utf-8");

      initSidContext(registryPath);
      // Should not throw — context is initialized
      const sid = generateUniqueSid();
      assert.ok(sid >= MIN_SID && sid < MAX_SID);
      assert.notEqual(sid, 400000000000001);
    });

    it("throws if registry file does not exist", () => {
      const missing = path.join(tmpDir, "nonexistent.txt");
      assert.throws(() => initSidContext(missing), /SID registry not found/);
    });
  });
});
