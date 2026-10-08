import { describe, it, before, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { runCli } from "../helpers/runCli.js";

// #254: the scaffold-layout / scaffold-sprite CLI subcommands must refuse an output that
// already exists (or collides by name) with exit 1, before any write. Each row runs the real
// CLI against a temp COPY of the canonical fixture — never the fixture itself. (C4, the
// CLI-vs-MCP byte-identity row, lives in test/mcp/serverHandlers.test.ts where the MCP
// handler harness is.)

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const LAYOUT_REL = "layouts/Gameplay/Main Layout.json";
const SHEET_REL = "eventSheets/Gameplay/Event sheet 1.json";

/** relPath -> sha256 of every file under root (optionally under a sub-dir). */
function snapshotTree(root: string, sub = ""): Map<string, string> {
  const snap = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        snap.set(
          path.relative(root, full).split(path.sep).join("/"),
          createHash("sha256").update(readFileSync(full)).digest("hex"),
        );
    }
  };
  walk(path.join(root, sub));
  return snap;
}

describe("scaffold-layout / scaffold-sprite CLI refuse overwrites (#254)", function () {
  // Each row spawns the real CLI via tsx — see test/helpers/runCli.ts.
  this.timeout(60_000);

  let tmp: string;

  before(() => {
    expect(existsSync(FIXTURE_ROOT), "fixture must be materialized (npm run fixture:prep)").to.be.true;
  });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-scaffold-cli-"));
    cpSync(FIXTURE_ROOT, tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("C1: scaffold-layout with --source == --out is refused, exit 1, tree unchanged, no yargs help", () => {
    const layout = path.join(tmp, LAYOUT_REL);
    const before = snapshotTree(tmp);

    const r = runCli(
      [
        "scaffold-layout",
        "--project-dir",
        tmp,
        "--source",
        layout,
        "--out",
        layout,
        "--name",
        "C1",
        "--event-sheet",
        "Event sheet 1",
      ],
      { cwd: tmp },
    );

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr).to.include("scaffold-layout refused:");
    expect(r.stderr + r.stdout).to.not.include("Options:");
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });

  // NOTE: the plan's C2 passes --no-regenerate, but the CLI declares an option literally named
  // "no-regenerate", which yargs .strict() rejects as "Unknown argument: regenerate" (exit 1 plus
  // help, before the handler runs). It is omitted here so the refusal itself is what is asserted.
  it("C2: scaffold-layout --out onto an existing event sheet is refused, no Scaffolded line, sheet unchanged", () => {
    const sheet = path.join(tmp, SHEET_REL);
    const sheetBefore = readFileSync(sheet);

    const r = runCli(
      [
        "scaffold-layout",
        "--project-dir",
        tmp,
        "--source",
        path.join(tmp, LAYOUT_REL),
        "--out",
        sheet,
        "--name",
        "C2",
        "--event-sheet",
        "Event sheet 1",
      ],
      { cwd: tmp },
    );

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr).to.include("scaffold-layout refused:");
    expect(r.stderr).to.include("eventSheets/");
    expect(r.stdout).to.not.include("Scaffolded");
    expect(readFileSync(sheet).equals(sheetBefore)).to.be.true;
  });

  it("C3: scaffold-sprite onto an existing objectType name is refused, nothing written to objectTypes/ or images/", () => {
    const imagesBefore = snapshotTree(tmp, "images");
    const objectTypesBefore = snapshotTree(tmp, "objectTypes");

    // "Sprite" exists as objectTypes/images/Sprite.json in the fixture (a name collision, not a path one).
    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "Sprite"], { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr).to.include("scaffold-sprite refused:");
    expect(existsSync(path.join(tmp, "objectTypes", "Sprite.json"))).to.be.false;
    expect(snapshotTree(tmp, "images")).to.deep.equal(imagesBefore);
    expect(snapshotTree(tmp, "objectTypes")).to.deep.equal(objectTypesBefore);
  });

  it("C5: positive control — scaffold-sprite onto a fresh name still succeeds and creates the file", () => {
    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "FreshCli"], { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(existsSync(path.join(tmp, "objectTypes", "FreshCli.json"))).to.be.true;
  });
});
