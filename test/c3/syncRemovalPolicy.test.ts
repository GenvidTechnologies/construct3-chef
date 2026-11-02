import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runCli } from "../helpers/runCli.js";
import { seedAbsentFile, SAMPLE_GIF_SID } from "../helpers/seedAbsentFile.js";
import { runSync } from "../../src/c3/projectSync.js";

// #346: sync withholds removals by default. Each row runs against a temp COPY of the canonical
// fixture, never the fixture itself. The removal-only seed deletes files/sample.gif (declared in
// `general`, SID 542941095423235); the shared seed also adds scripts/newScript.ts for a `+` line.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

interface ManifestFileItem {
  name: string;
  type: string;
  sid: number;
  "file-info": unknown;
}

function sampleGifEntry(root: string): ManifestFileItem | undefined {
  const manifest = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf8"));
  return (manifest.rootFileFolders.general.items as ManifestFileItem[]).find((i) => i.name === "sample.gif");
}

describe("sync-project removal policy (#346)", function () {
  // Rows spawn the real CLI via tsx — see test/helpers/runCli.ts.
  this.timeout(120_000);

  const dirs: string[] = [];
  let seededEntry: ManifestFileItem | undefined;

  function copy(): string {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-sr346-"));
    dirs.push(root);
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return root;
  }

  /** The shared seed: sample.gif declared but absent, plus a new scripts/newScript.ts. */
  function seedR1(): string {
    const root = copy();
    seedAbsentFile(root);
    writeFileSync(path.join(root, "scripts", "newScript.ts"), "export {};\n");
    return root;
  }

  beforeEach(() => {
    seededEntry = sampleGifEntry(FIXTURE_ROOT);
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("SR346-R1: the default write sync keeps the entry of a missing file, adds the new file, and marks the removal withheld", () => {
    const root = seedR1();
    expect(seededEntry?.sid, "precondition: the fixture declares sample.gif").to.equal(SAMPLE_GIF_SID);

    const result = runSync(root, false, () => {});

    expect({
      entry: sampleGifEntry(root),
      added: result.changes.some((c) => c.action === "+" && c.detail.includes("newScript.ts")),
      removalWithheld: result.changes.find((c) => c.action === "-" && c.detail === "sample.gif")?.withheld,
      wrote: result.wrote,
    }).to.deep.equal({ entry: seededEntry, added: true, removalWithheld: true, wrote: true });
  });

  it("SR346-R2: sync-project through the CLI withholds the removal, and validate-project keeps reporting it", () => {
    const root = seedR1();
    const withheldLine = /^\[general\]\s+- sample\.gif \[withheld\]$/m;

    const firstValidate = runCli(["validate-project", "--project-dir", root]);
    const sync = runCli(["sync-project", "--project-dir", root]);
    const secondValidate = runCli(["validate-project", "--project-dir", root]);

    expect({
      exitCodes: [firstValidate.exitCode, sync.exitCode, secondValidate.exitCode],
      syncWithheld: withheldLine.test(sync.stdout),
      validateWithheld: withheldLine.test(secondValidate.stdout),
      entry: sampleGifEntry(root),
    }).to.deep.equal({ exitCodes: [1, 0, 1], syncWithheld: true, validateWithheld: true, entry: seededEntry });
  });

  it("SR346-R3: CLI scaffold-layout and scaffold-sprite keep the entry of a missing file and report it withheld", () => {
    const layoutRoot = copy();
    seedAbsentFile(layoutRoot);
    const layout = runCli([
      "scaffold-layout",
      "--project-dir",
      layoutRoot,
      "--source",
      "layouts/Gameplay/Main Layout.json",
      "--out",
      "layouts/SR346R3Layout.json",
      "--name",
      "SR346R3Layout",
      "--event-sheet",
      "Event sheet 1",
      "--no-regenerate",
    ]);

    const spriteRoot = copy();
    seedAbsentFile(spriteRoot);
    const sprite = runCli([
      "scaffold-sprite",
      "--project-dir",
      spriteRoot,
      "--source",
      "Text",
      "--name",
      "SR346R3Sprite",
      "--no-regenerate",
    ]);

    expect({
      exitCodes: [layout.exitCode, sprite.exitCode],
      withheld: [layout.stdout.includes("- sample.gif [withheld]"), sprite.stdout.includes("- sample.gif [withheld]")],
      entries: [sampleGifEntry(layoutRoot), sampleGifEntry(spriteRoot)],
    }).to.deep.equal({
      exitCodes: [0, 0],
      withheld: [true, true],
      entries: [seededEntry, seededEntry],
    });
  });

  it("SR346-R8: sync-project --prune removes the entry of a missing file, reports it unwithheld, and validate-project then passes", () => {
    const root = seedR1();

    const sync = runCli(["sync-project", "--project-dir", root, "--prune"]);
    const validate = runCli(["validate-project", "--project-dir", root]);
    const removalLines = sync.stdout.split("\n").filter((l) => l.includes("- sample.gif"));

    expect({
      syncExit: sync.exitCode,
      removalLines: removalLines.length,
      anyWithheld: removalLines.some((l) => l.includes("[withheld]")),
      entry: sampleGifEntry(root),
      validateExit: validate.exitCode,
    }).to.deep.equal({ syncExit: 0, removalLines: 1, anyWithheld: false, entry: undefined, validateExit: 0 });
  });
});
