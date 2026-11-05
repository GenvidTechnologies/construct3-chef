import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import {
  mkdtempSync,
  cpSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runSync } from "../../src/c3/projectSync.js";
import { reportDriftAdvisories } from "../../src/c3/driftAdvisories.js";

// Each row runs against a temp COPY of the canonical fixture, never the fixture itself. Rows seed
// directory links (junctions, which need no admin rights on Windows) and run a dry-run sync.
// Every link is tracked and unlinked before the temp root is removed, so rmSync never sees a link.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

interface Outcome {
  threw: string | null;
  lines: string[];
}

describe("sync file-section walk and links", function () {
  this.timeout(120_000);

  const dirs: string[] = [];
  const links: string[] = [];

  function copy(): string {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-sw358-"));
    dirs.push(root);
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return root;
  }

  function seedFile(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  /** Create a directory junction at `rel` pointing at the absolute `target`, and track it for cleanup. */
  function seedLink(root: string, rel: string, target: string): void {
    const link = path.join(root, rel);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, "junction");
    links.push(link);
  }

  /** Run a dry-run sync; report the error code (or null) and the logged lines without `(no changes)` lines. */
  function dryRun(root: string): Outcome {
    const logged: string[] = [];
    let threw: string | null = null;
    try {
      runSync(root, true, (line) => logged.push(line));
    } catch (e) {
      threw = (e as NodeJS.ErrnoException).code ?? String(e);
    }
    return {
      threw,
      // Mask the minted SID: `sid=<digits>` becomes `sid=<SID>`.
      lines: logged.filter((l) => !l.endsWith("(no changes)")).map((l) => l.replace(/sid=\d+/g, "sid=<SID>")),
    };
  }

  afterEach(() => {
    for (const l of links.splice(0)) {
      try {
        if (lstatSync(l).isSymbolicLink()) unlinkSync(l);
      } catch (e) {
        // A link that is already gone is fine; any other failure must stop before rmSync follows the link.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const GUARD_MESSAGE =
    "runSync must keep c3source's file-section drift walks out of sync (the skipFileSections option in runSync, ADR 0066): since c3source 3.1.0 they follow links";

  it("I358-R2: a junction loop under undeclared files/undecl and scripts/undecl does not throw", () => {
    const root = copy();
    seedFile(root, "scripts/undecl/a.ts", "export {};\n");
    seedLink(root, "scripts/undecl/loop", path.join(root, "scripts", "undecl"));
    seedFile(root, "files/undecl/y.txt", "y\n");
    seedLink(root, "files/undecl/loop", path.join(root, "files", "undecl"));

    expect(dryRun(root), GUARD_MESSAGE).to.deep.equal({
      threw: null,
      lines: [
        "[script]        + undecl/ (new folder)",
        "[script]        + undecl/a.ts (new, sid=<SID>)",
        "[general]       + undecl/ (new folder)",
        "[general]       + undecl/y.txt (new, sid=<SID>)",
        "\n4 change(s) found: 4 addition(s), 0 removal(s).",
      ],
    });
  });

  it("I358-R3: a dangling junction under files/undecl does not throw", () => {
    const root = copy();
    seedFile(root, "files/undecl/y.txt", "y\n");
    const gone = path.join(root, "gone-target");
    mkdirSync(gone);
    seedLink(root, "files/undecl/dead", gone);
    rmSync(gone, { recursive: true });

    expect(dryRun(root), GUARD_MESSAGE).to.deep.equal({
      threw: null,
      lines: [
        "[general]       + undecl/ (new folder)",
        "[general]       + undecl/y.txt (new, sid=<SID>)",
        "\n2 change(s) found: 2 addition(s), 0 removal(s).",
      ],
    });
  });

  it("DB4-R4: a junction loop under eventSheets/sub does not throw", () => {
    const root = copy();
    mkdirSync(path.join(root, "eventSheets", "sub"), { recursive: true });
    seedLink(root, "eventSheets/sub/loop", path.join(root, "eventSheets", "sub"));

    let threw: string | null = null;
    try {
      runSync(root, true, () => {});
    } catch (e) {
      threw = (e as NodeJS.ErrnoException).code ?? String(e);
    }

    expect(
      { threw },
      "c3source 4.0.0 walks no longer follow links below a walk root (c3source#114), so a name-section link loop does not fail the run",
    ).to.deep.equal({ threw: null });
  });

  it("DB4-U7: a junction at layouts/sub/loop gives the exact [links] line", () => {
    const root = copy();
    mkdirSync(path.join(root, "layouts", "sub"), { recursive: true });
    seedLink(root, "layouts/sub/loop", path.join(root, "layouts", "sub"));

    const lines: string[] = [];
    reportDriftAdvisories(root, (l) => lines.push(l));

    expect(lines.filter((l) => l.startsWith("[links]"))).to.deep.equal([
      "[links]".padEnd(16) + "! layouts/sub/loop (not followed)",
    ]);
  });

  const EDITOR_LOCAL_MESSAGE =
    "editor-local files (uistate/, ts-defs/, *.uistate.json, tsconfig.json) are not file-section members at any depth (ADR 0066)";

  it("I358-R5a: editor-local directories are not members at any depth; lookalike files are", () => {
    const root = copy();
    seedFile(root, "files/uistate/a.txt", "a\n");
    seedFile(root, "files/ts-defs/z.txt", "z\n");
    seedFile(root, "scripts/sub/ts-defs/y.ts", "export {};\n");
    seedFile(root, "scripts/uistate/q.ts", "export {};\n");
    seedFile(root, "icons/uistate/i.png", "i\n");
    seedFile(root, "files/uistate.txt", "u\n");
    seedFile(root, "files/keep.txt", "k\n");

    expect(dryRun(root), EDITOR_LOCAL_MESSAGE).to.deep.equal({
      threw: null,
      lines: [
        "[script]        + sub/ (new folder)",
        "[general]       + keep.txt (new, sid=<SID>)",
        "[general]       + uistate.txt (new, sid=<SID>)",
        "\n3 change(s) found: 3 addition(s), 0 removal(s).",
      ],
    });
  });

  it("I358-R5b: a *.uistate.json file is not a member; a plain file beside it is", () => {
    const root = copy();
    seedFile(root, "files/x.uistate.json", "{}");
    seedFile(root, "files/keep.txt", "k\n");

    expect(dryRun(root), EDITOR_LOCAL_MESSAGE).to.deep.equal({
      threw: null,
      lines: ["[general]       + keep.txt (new, sid=<SID>)", "\n1 change(s) found: 1 addition(s), 0 removal(s)."],
    });
  });

  it("I358-R5c: a nested tsconfig.json is not a member; its sibling and folder are", () => {
    const root = copy();
    seedFile(root, "files/sub/tsconfig.json", "{}");
    seedFile(root, "files/sub/keep2.txt", "k\n");

    expect(dryRun(root), EDITOR_LOCAL_MESSAGE).to.deep.equal({
      threw: null,
      lines: [
        "[general]       + sub/ (new folder)",
        "[general]       + sub/keep2.txt (new, sid=<SID>)",
        "\n2 change(s) found: 2 addition(s), 0 removal(s).",
      ],
    });
  });

  it("I358-R6: declared editor-local manifest entries are inert", () => {
    const root = copy();
    const manifestPath = path.join(root, "project.c3proj");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const general = manifest.rootFileFolders.general;
    general.items.push({
      name: "tsconfig.json",
      type: "application/json",
      sid: 111111111111111,
      "file-info": { purpose: "none" },
    });
    general.subfolders.push({
      name: "uistate",
      items: [{ name: "a.txt", type: "text/plain", sid: 222222222222222, "file-info": { purpose: "none" } }],
      subfolders: [],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
    seedFile(root, "files/tsconfig.json", "{}");
    seedFile(root, "files/uistate/a.txt", "a\n");

    const dry = dryRun(root);
    let pruneWrote: boolean | null = null;
    try {
      pruneWrote = runSync(root, false, () => {}, undefined, { prune: true }).wrote;
    } catch {
      pruneWrote = null;
    }

    expect(
      { dryLines: dry.lines, pruneWrote },
      "a declared manifest entry with an editor-local name is inert: never added, removed or moved (ADR 0066)",
    ).to.deep.equal({
      dryLines: ["\nAll sections in sync."],
      pruneWrote: false,
    });
  });
});
