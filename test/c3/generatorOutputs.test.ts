import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceOwnedOutputs } from "../../src/c3/generatorOutputs.js";

describe("replaceOwnedOutputs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "chef-genout-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function put(rel: string, content: string): string {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  }

  it("SL11: writes outputs, deletes only owned-suffix orphans, prunes only emptied dirs", () => {
    const kept = put("a.ts", "same");
    const past = new Date(2000, 0, 1);
    utimesSync(kept, past, past);
    put("orphan.ts", "x");
    put("gone/deep/orphan2.ts", "x");
    put("mixed/orphan3.ts", "x");
    put("mixed/notes.md", "keep");
    put("other.dsl.txt", "other generator");
    const outputs = new Map<string, string>([
      [kept, "same"],
      [path.join(dir, "new", "b.ts"), "bee"],
    ]);

    replaceOwnedOutputs(dir, [".ts"], outputs);

    assert.equal(readFileSync(kept, "utf-8"), "same");
    assert.ok(statSync(kept).mtimeMs > past.getTime() + 1000, "unchanged output must still be rewritten");
    assert.equal(readFileSync(path.join(dir, "new", "b.ts"), "utf-8"), "bee");
    assert.ok(!existsSync(path.join(dir, "orphan.ts")));
    assert.ok(!existsSync(path.join(dir, "gone")), "emptied dirs are pruned");
    assert.ok(!existsSync(path.join(dir, "mixed", "orphan3.ts")));
    assert.ok(existsSync(path.join(dir, "mixed", "notes.md")), "non-owned file survives");
    assert.ok(existsSync(path.join(dir, "other.dsl.txt")), "other suffix survives");
  });

  it("SL12: a case-only respelling leaves one file with the new spelling and content", () => {
    put("Foo.ts", "old");
    replaceOwnedOutputs(dir, [".ts"], new Map([[path.join(dir, "foo.ts"), "new"]]));
    assert.deepEqual(readdirSync(dir), ["foo.ts"]);
    assert.equal(readFileSync(path.join(dir, "foo.ts"), "utf-8"), "new");
  });

  it("SL13: a write that throws midway leaves pre-existing orphans in place", () => {
    const old = put("old.ts", "orphan");
    put("blocker", "i am a file");
    const outputs = new Map<string, string>([[path.join(dir, "blocker", "x.ts"), "x"]]);
    assert.throws(() => replaceOwnedOutputs(dir, [".ts"], outputs));
    assert.ok(existsSync(old), "orphan pass must not run after a failed write");
  });
});
