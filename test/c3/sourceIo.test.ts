import { expect } from "chai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diskIo, OverlayIo } from "../../src/c3/sourceIo.js";

describe("sourceIo", () => {
  let tmp: string;
  let otDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sourceio-"));
    otDir = path.join(tmp, "objectTypes");
    mkdirSync(otDir);
    writeFileSync(path.join(otDir, "Disk.json"), "{}");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("OverlayIo.readText returns written text and leaves disk unchanged", () => {
    const io = new OverlayIo();
    const disk = path.join(otDir, "Disk.json");
    io.writeText(disk, "NEW");
    expect(io.readText(disk)).to.equal("NEW");
    expect(readFileSync(disk, "utf-8")).to.equal("{}");
    const ghost = path.join(otDir, "Ghost.json");
    io.writeText(ghost, "G");
    expect(existsSync(ghost)).to.equal(false);
  });

  it("OverlayIo exists/listObjectTypeFiles union overlay and disk without duplicates", () => {
    const io = new OverlayIo();
    const ghost = path.join(otDir, "Ghost.json");
    io.writeText(ghost, "G");
    io.writeText(path.join(otDir, "Disk.json"), "dup");
    io.writeText(path.join(otDir, "notes.txt"), "x");
    expect(io.exists(ghost)).to.equal(true);
    expect(io.exists(path.join(otDir, "Disk.json"))).to.equal(true);
    expect(io.exists(path.join(otDir, "Nope.json"))).to.equal(false);
    expect(io.listObjectTypeFiles(otDir).sort()).to.deep.equal(
      [path.join(otDir, "Disk.json"), path.join(otDir, "Ghost.json")].sort(),
    );
    expect(diskIo.listObjectTypeFiles(otDir)).to.deep.equal([path.join(otDir, "Disk.json")]);
  });

  it("OverlayIo journals logs and writes in call order and never creates directories", () => {
    const io = new OverlayIo();
    const log = io.logger();
    const target = path.join(tmp, "newdir", "a.json");
    log("one", 2);
    io.writeText(target, "T", { mkdir: true });
    log("three");
    expect(io.journal).to.deep.equal([
      { kind: "log", args: ["one", 2] },
      { kind: "write", abs: target, text: "T", mkdir: true },
      { kind: "log", args: ["three"] },
    ]);
    expect(existsSync(path.join(tmp, "newdir"))).to.equal(false);
  });

  it("diskIo.writeText with mkdir creates the directory and file", () => {
    const target = path.join(tmp, "made", "deep", "b.json");
    diskIo.writeText(target, "B", { mkdir: true });
    expect(readFileSync(target, "utf-8")).to.equal("B");
    expect(diskIo.exists(target)).to.equal(true);
  });
});
