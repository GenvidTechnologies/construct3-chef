import { describe, it, before, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { runCli } from "../helpers/runCli.js";
import {
  formatScaffoldPathRejection,
  formatScaffoldNameRejection,
  formatScaffoldSourceNotFound,
} from "../../src/c3/scaffoldPlan.js";

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

  it("T7: scaffold-layout --out onto an existing event sheet is rejected as outside layouts/, sheet unchanged", () => {
    const sheet = path.join(tmp, SHEET_REL);
    const sheetBefore = readFileSync(sheet);
    const snapBefore = snapshotTree(tmp);

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
        "--no-regenerate",
      ],
      { cwd: tmp },
    );

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.trimEnd()).to.equal(formatScaffoldPathRejection("output", sheet));
    expect(r.stderr).to.not.include("refused:");
    expect(r.stdout).to.not.include("Scaffolded");
    expect(readFileSync(sheet).equals(sheetBefore)).to.be.true;
    expect(snapshotTree(tmp)).to.deep.equal(snapBefore);
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

  for (const flag of ["--no-regenerate", "--regenerate=false"]) {
    it(`T4: scaffold-layout ${flag} succeeds, writes the layout, leaves extracted/ untouched`, () => {
      const extractedBefore = snapshotTree(tmp, "extracted");

      const r = runCli(
        [
          "scaffold-layout",
          "--project-dir",
          tmp,
          "--source",
          path.join(tmp, LAYOUT_REL),
          "--out",
          path.join(tmp, "layouts/Gameplay/C6.json"),
          "--name",
          "C6",
          "--event-sheet",
          "Event sheet 1",
          flag,
        ],
        { cwd: tmp },
      );

      expect(r.exitCode, r.stderr).to.equal(0);
      expect(existsSync(path.join(tmp, "layouts/Gameplay/C6.json"))).to.be.true;
      expect(snapshotTree(tmp, "extracted")).to.deep.equal(extractedBefore);
      expect(r.stdout + r.stderr).to.not.include("Options:");
    });
  }

  it("T5/T11: control — scaffold-layout with no regenerate flag regenerates extracted/", () => {
    const r = runCli(
      [
        "scaffold-layout",
        "--project-dir",
        tmp,
        "--source",
        path.join(tmp, LAYOUT_REL),
        "--out",
        path.join(tmp, "layouts/Gameplay/C6.json"),
        "--name",
        "C6",
        "--event-sheet",
        "Event sheet 1",
      ],
      { cwd: tmp },
    );

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(existsSync(path.join(tmp, "extracted/layouts/Gameplay/C6.layout.txt"))).to.be.true;
    expect(r.stdout.split(/\r?\n/).some((l) => l.startsWith("[strays]"))).to.be.false;
    expect(r.stdout.split(/\r?\n/)).to.include("Scaffolded C6 → layouts/Gameplay/C6.json");
  });

  it("C5: positive control — scaffold-sprite onto a fresh name still succeeds and creates the file", () => {
    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "FreshCli"], { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(existsSync(path.join(tmp, "objectTypes", "FreshCli.json"))).to.be.true;
  });

  it("SR12: scaffold-sprite clones a source the fixture keeps in a subfolder, writing the clone flat", () => {
    const r = runCli(
      ["scaffold-sprite", "--project-dir", tmp, "--source", "Sprite2", "--name", "SR12Clone", "--no-regenerate"],
      { cwd: tmp },
    );

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(existsSync(path.join(tmp, "objectTypes", "SR12Clone.json"))).to.be.true;
    expect(existsSync(path.join(tmp, "images", "sr12clone-animation 1-000.png"))).to.be.true;
    expect(existsSync(path.join(tmp, "objectTypes", "Sprite2.json"))).to.be.false;
    expect(readFileSync(path.join(tmp, "project.c3proj"), "utf8")).to.include("SR12Clone");
  });

  const registryRows = (file: string): number =>
    readFileSync(path.join(tmp, "extracted", "sid-registry.txt"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes(file)).length;

  it("R5: scaffold-sprite regenerates extracted/ by default", () => {
    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "RG5"], { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(registryRows("objectTypes/RG5.json")).to.be.at.least(1);
  });

  for (const flag of ["--no-regenerate", "--regenerate=false"]) {
    it(`R6: scaffold-sprite ${flag} skips regeneration`, () => {
      const before = snapshotTree(tmp, "extracted");
      const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "RG6", flag], {
        cwd: tmp,
      });

      expect(r.exitCode, r.stderr).to.equal(0);
      expect(existsSync(path.join(tmp, "objectTypes", "RG6.json"))).to.be.true;
      expect(snapshotTree(tmp, "extracted")).to.deep.equal(before);
    });
  }

  const layoutArgs = (
    projectDir: string,
    source: string,
    out: string,
    name: string,
    extra: string[] = ["--no-regenerate"],
  ): string[] => [
    "scaffold-layout",
    "--project-dir",
    projectDir,
    "--source",
    source,
    "--out",
    out,
    "--name",
    name,
    "--event-sheet",
    "Event sheet 1",
    ...extra,
  ];
  const STACK_FRAME = /^ {4}at /m;

  it("T6: --out escaping the project root via .. is rejected, nothing written outside", () => {
    const outer = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-scaffold-cli-outer-"));
    try {
      const proj = path.join(outer, "proj");
      cpSync(FIXTURE_ROOT, proj, { recursive: true });
      const before = snapshotTree(outer);

      const r = runCli(layoutArgs(proj, LAYOUT_REL, "../C7Esc.json", "C7"), { cwd: proj });

      expect(r.exitCode, r.stderr).to.equal(1);
      expect(r.stderr.trimEnd()).to.equal(formatScaffoldPathRejection("output", "../C7Esc.json"));
      expect(existsSync(path.join(outer, "C7Esc.json"))).to.be.false;
      expect(snapshotTree(outer)).to.deep.equal(before);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("T8: --source outside layouts/ is rejected", () => {
    const before = snapshotTree(tmp);

    const r = runCli(layoutArgs(tmp, SHEET_REL, "layouts/T8.json", "T8", []), { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.trimEnd()).to.equal(formatScaffoldPathRejection("source", SHEET_REL));
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });

  it("T9: relative paths resolve against --project-dir, not cwd", () => {
    const cwdDir = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-scaffold-cli-cwd-"));
    try {
      const r = runCli(layoutArgs(tmp, LAYOUT_REL, "layouts/Gameplay/C9.json", "C9"), { cwd: cwdDir });

      expect(r.exitCode, r.stderr).to.equal(0);
      expect(existsSync(path.join(tmp, "layouts/Gameplay/C9.json"))).to.be.true;
      expect(readdirSync(cwdDir).length).to.equal(0);
    } finally {
      rmSync(cwdDir, { recursive: true, force: true });
    }
  });

  it("T10: missing parent folders of --out are created", () => {
    const r = runCli(layoutArgs(tmp, LAYOUT_REL, "layouts/NewDir/C10.json", "C10"), { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(existsSync(path.join(tmp, "layouts/NewDir/C10.json"))).to.be.true;
  });

  it("T12: missing --source layout prints one message line, no help, no stack", () => {
    const before = snapshotTree(tmp);

    const r = runCli(layoutArgs(tmp, "layouts/Nope.json", LAYOUT_REL, "C12"), { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.trimEnd()).to.equal(formatScaffoldSourceNotFound("layout", "layouts/Nope.json"));
    const all = r.stdout + r.stderr;
    expect(all).to.not.include("refused:");
    expect(all).to.not.include("Options:");
    expect(all).to.not.match(STACK_FRAME);
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });

  it("T13: scaffold-sprite with a missing source objectType prints one message line, no stack", () => {
    const before = snapshotTree(tmp);

    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "NoSuchSprite", "--name", "Text"], {
      cwd: tmp,
    });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.trimEnd()).to.equal(formatScaffoldSourceNotFound("objectType", "objectTypes/NoSuchSprite.json"));
    const all = r.stdout + r.stderr;
    expect(all).to.not.include("refused:");
    expect(all).to.not.match(STACK_FRAME);
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });

  it("T14: scaffold-sprite --name with a path separator is rejected", () => {
    const before = snapshotTree(tmp);

    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "../EscC"], {
      cwd: tmp,
    });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.trimEnd()).to.equal(formatScaffoldNameRejection("name", "../EscC"));
    expect(existsSync(path.join(tmp, "EscC.json"))).to.be.false;
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });

  it("T15: scaffold-sprite --source with a path separator is rejected", () => {
    const before = snapshotTree(tmp);

    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "images/Sprite", "--name", "SubSrc"], {
      cwd: tmp,
    });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.trimEnd()).to.equal(formatScaffoldNameRejection("source", "images/Sprite"));
    expect(existsSync(path.join(tmp, "objectTypes", "SubSrc.json"))).to.be.false;
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });

  it("T16: scaffold-sprite succeeds when the project has no images/ directory", () => {
    rmSync(path.join(tmp, "images"), { recursive: true, force: true });

    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "C16"], { cwd: tmp });

    expect(r.exitCode, r.stderr).to.equal(0);
    expect(existsSync(path.join(tmp, "objectTypes", "C16.json"))).to.be.true;
    expect(readFileSync(path.join(tmp, "project.c3proj"), "utf-8")).to.include("C16");
    expect(existsSync(path.join(tmp, "images"))).to.be.false;
  });

  it("T17: scaffold-sprite over an unparseable source prints `Error: <message>`, no stack, nothing written", () => {
    writeFileSync(path.join(tmp, "objectTypes", "Broken.json"), "{ bad");
    const before = snapshotTree(tmp);

    const r = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Broken", "--name", "BrokenCopy"], {
      cwd: tmp,
    });

    expect(r.exitCode, r.stderr).to.equal(1);
    expect(r.stderr.startsWith("Error:"), r.stderr).to.be.true;
    const all = r.stdout + r.stderr;
    expect(all).to.not.match(STACK_FRAME);
    expect(all).to.not.include("Options:");
    expect(existsSync(path.join(tmp, "objectTypes", "BrokenCopy.json"))).to.be.false;
    expect(snapshotTree(tmp)).to.deep.equal(before);
  });
});
