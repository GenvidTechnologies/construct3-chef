import { expect } from "chai";
import { suppressSelfWrites, trackSelfWrites } from "../../src/mcp/selfWrites.js";

interface FakeWatcher {
  expect(p: string): void;
  suppress<T>(fn: () => Promise<T>): Promise<T>;
  calls: string[];
  depthAtCall: number[];
  depth: number;
}

function fakeWatcher(): FakeWatcher {
  const w: FakeWatcher = {
    calls: [],
    depthAtCall: [],
    depth: 0,
    expect(p) {
      w.calls.push(p);
      w.depthAtCall.push(w.depth);
    },
    async suppress(fn) {
      w.depth++;
      try {
        return await fn();
      } finally {
        w.depth--;
      }
    },
  };
  return w;
}

describe("selfWrites", () => {
  it("S1: before(p) calls expect(p) once, synchronously, even when detached", () => {
    const w = fakeWatcher();
    const sw = trackSelfWrites(w);
    const b = sw.before;
    b("/a/x.json");
    expect(w.calls).to.deep.equal(["/a/x.json"]);
  });

  it("S2: refresh() re-expects each registered path once", () => {
    const w = fakeWatcher();
    const sw = trackSelfWrites(w);
    sw.before("/a/x.json");
    sw.before("/a/y.json");
    expect(w.calls).to.have.length(2);
    sw.refresh();
    expect(w.calls.slice(2)).to.have.members(["/a/x.json", "/a/y.json"]);
    expect(w.calls).to.have.length(4);
  });

  it("S3: when fn throws, refresh still runs inside the suppress window and the error propagates", async () => {
    const w = fakeWatcher();
    let caught: unknown;
    try {
      await suppressSelfWrites(w, async (sw) => {
        sw.before("/a/x.json");
        throw new Error("boom");
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).to.equal("boom");
    expect(w.calls).to.deep.equal(["/a/x.json", "/a/x.json"]);
    expect(w.depthAtCall).to.deep.equal([1, 1]);
    expect(w.depth).to.equal(0);
  });

  it("a successful fn has its paths refreshed once at the end and its value returned", async () => {
    const w = fakeWatcher();
    const v = await suppressSelfWrites(w, async (sw) => {
      sw.before("/a/x.json");
      sw.before("/a/y.json");
      return 42;
    });
    expect(v).to.equal(42);
    expect(w.calls).to.have.length(4);
    expect(w.calls.slice(2)).to.have.members(["/a/x.json", "/a/y.json"]);
  });
});
