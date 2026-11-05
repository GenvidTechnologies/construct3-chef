import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { reportDriftAdvisories } from "../../src/c3/driftAdvisories.js";
import { runCli } from "../helpers/runCli.js";

// Each row runs against a temp COPY of the canonical fixture, never the fixture itself. The seeded
// files are on disk only, so the manifest side of a duplicate is empty.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

describe("drift advisories", function () {
  this.timeout(120_000);

  const dirs: string[] = [];

  function copy(): string {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-da344-"));
    dirs.push(root);
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return root;
  }

  function seedFile(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  function run(root: string): string[] {
    const lines: string[] = [];
    reportDriftAdvisories(root, (l) => lines.push(l));
    return lines;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("DB4-U1: an object type and a family with the same name give the exact [duplicates] line", () => {
    const root = copy();
    seedFile(root, "objectTypes/Player.json", "{}");
    seedFile(root, "families/player.json", "{}");
    const lines = run(root);
    expect(lines.filter((l) => l.startsWith("[duplicates]"))).to.deep.equal([
      "[duplicates]".padEnd(16) + "! objectClasses 'player': manifest (none); disk objectTypes/Player, families/player",
    ]);
    expect(lines.filter((l) => l.startsWith("[links]"))).to.deep.equal(["[links]".padEnd(16) + "(no links)"]);
  });

  it("DB4-U2: two layouts differing in case, in different folders, give the exact [duplicates] line", () => {
    const root = copy();
    seedFile(root, "layouts/Level1.json", "{}");
    seedFile(root, "layouts/sub/level1.json", "{}");
    const lines = run(root);
    expect(lines.filter((l) => l.startsWith("[duplicates]"))).to.deep.equal([
      "[duplicates]".padEnd(16) + "! layouts 'level1': manifest (none); disk layouts/Level1, layouts/sub/level1",
    ]);
  });

  it("DB4-U3: a clean copy of the canonical fixture gives one (no duplicates) and one (no links) line", () => {
    const root = copy();
    const lines = run(root);
    expect(lines).to.deep.equal(["[duplicates]".padEnd(16) + "(no duplicates)", "[links]".padEnd(16) + "(no links)"]);
  });

  it("DB4-U6: an unparsable project.c3proj gives one Could not parse line, then [images] and [strays], and no advisories", () => {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-da344-"));
    dirs.push(root);
    writeFileSync(path.join(root, "project.c3proj"), "{ NOT JSON");
    seedFile(root, "layouts/notes.txt", "a stray note\n");

    const result = runCli(["validate-project", "--project-dir", root]);
    const outLines = result.stdout.split(/\r?\n/).filter((l) => l !== "");
    const errLines = result.stderr.split(/\r?\n/).filter((l) => l !== "");

    expect({
      stderrLines: errLines.length,
      stderrIsParseError: /^Could not parse .*project\.c3proj as JSON/.test(errLines[0] ?? ""),
      stdoutLabels: outLines.map((l) => l.split(/\s/)[0]),
    }).to.deep.equal({ stderrLines: 1, stderrIsParseError: true, stdoutLabels: ["[images]", "[strays]"] });
  });
});
