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
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runSync } from "../../src/c3/projectSync.js";

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
      } catch {
        // already gone
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const R23_MESSAGE =
    "runSync must keep c3source's file-section drift walks out of sync (the nameView in runSync, ADR 0066): since c3source 3.1.0 they follow links";

  it("I358-R2: a junction loop under undeclared files/undecl and scripts/undecl does not throw", () => {
    const root = copy();
    seedFile(root, "scripts/undecl/a.ts", "export {};\n");
    seedLink(root, "scripts/undecl/loop", path.join(root, "scripts", "undecl"));
    seedFile(root, "files/undecl/y.txt", "y\n");
    seedLink(root, "files/undecl/loop", path.join(root, "files", "undecl"));

    expect(dryRun(root), R23_MESSAGE).to.deep.equal({
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

    expect(dryRun(root), R23_MESSAGE).to.deep.equal({
      threw: null,
      lines: [
        "[general]       + undecl/ (new folder)",
        "[general]       + undecl/y.txt (new, sid=<SID>)",
        "\n2 change(s) found: 2 addition(s), 0 removal(s).",
      ],
    });
  });

  it("I358-R4: a junction loop under eventSheets/sub still throws ELOOP", () => {
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
      "a junction loop under a name-section folder still throws ELOOP; if this goes red, c3source fixed link handling: update ADR 0066 and the c3source 3.1.0 ledger entry",
    ).to.deep.equal({ threw: "ELOOP" });
  });
});
