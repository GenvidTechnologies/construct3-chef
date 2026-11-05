import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanReportContent } from "../../src/mcp/structuredReport.js";
import { __getHandler, __setTestWatcher, __setProjectRoot, __resetTestState } from "../../src/mcp/server.js";
import { runCli } from "../helpers/runCli.js";
import { seedAbsentFile } from "../helpers/seedAbsentFile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

describe("structuredReport", () => {
  it("I349-H1: cleanReportContent's report equals the text block, footer included", () => {
    expect({
      withFooter: cleanReportContent("a", "txId: x", false),
      noFooterReport: cleanReportContent("a", undefined, true).structuredContent,
    }).to.deep.equal({
      withFooter: {
        content: [{ type: "text", text: "a\ntxId: x" }],
        structuredContent: { clean: false, report: "a\ntxId: x" },
      },
      noFooterReport: { clean: true, report: "a" },
    });
  });
});

// Handlers under test touch watcher.txId (the footer) only; a bare object is enough.
function makeFakeWatcher(txId = 0): any {
  return {
    txId,
    bump() {
      this.txId++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    expect() {},
  };
}

function makeExtra(): any {
  return { signal: new AbortController().signal };
}

/** A fresh copy of the canonical fixture; the caller removes it. */
function copyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-"));
  fs.cpSync(FIXTURE_DIR, root, { recursive: true });
  return root;
}

/** Drift in layouts only: a layout file the manifest does not declare. */
function seedLayoutDrift(root: string): void {
  fs.copyFileSync(path.join(root, "layouts", "Templates Layout.json"), path.join(root, "layouts", "Extra349.json"));
}

describe("MCP validate-project structured content (#349)", function () {
  this.timeout(120000);
  let tmp: string;

  beforeEach(() => {
    tmp = copyFixture();
    __setProjectRoot(tmp);
    __setTestWatcher(makeFakeWatcher(5));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    __resetTestState();
  });

  async function validate(args: Record<string, unknown> = {}): Promise<any> {
    return __getHandler("validate-project")!(args, makeExtra());
  }

  function textOf(result: any): string {
    return result.content[0].text;
  }

  it("I349-VP1: drift gives clean false", async () => {
    seedLayoutDrift(tmp);
    const result = await validate();
    expect({
      isError: result.isError,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
      hasDrift: textOf(result).includes("change(s) found"),
    }).to.deep.equal({ isError: undefined, clean: false, reportIsText: true, hasDrift: true });
  });

  it("I349-VP2: a withheld removal is drift until prune", async () => {
    seedAbsentFile(tmp);
    const before = await validate();
    await __getHandler("sync-project")!({ prune: true }, makeExtra());
    const after = await validate();
    expect({
      before: {
        clean: before.structuredContent?.clean,
        withheld: textOf(before).includes("- sample.gif [withheld]"),
      },
      after: {
        clean: after.structuredContent?.clean,
        inSync: textOf(after).includes("All sections in sync."),
      },
    }).to.deep.equal({
      before: { clean: false, withheld: true },
      after: { clean: true, inSync: true },
    });
  });

  it("I349-VP3: a pristine project is clean", async () => {
    const result = await validate();
    expect({
      isError: result.isError,
      clean: result.structuredContent?.clean,
      inSync: textOf(result).includes("All sections in sync."),
    }).to.deep.equal({ isError: undefined, clean: true, inSync: true });
  });

  it("I349-VP4: strays and image drift stay clean", async () => {
    fs.writeFileSync(path.join(tmp, "layouts", "notes.txt"), "a stray note\n");
    fs.copyFileSync(path.join(tmp, "images", "9patch.png"), path.join(tmp, "images", "extra349.png"));
    const result = await validate();
    const text = textOf(result);
    expect({
      isError: result.isError,
      clean: result.structuredContent?.clean,
      stray: text.includes("! layouts/notes.txt"),
      image: text.split("\n").some((l) => l.includes("[images]") && l.includes("extra349.png")),
    }).to.deep.equal({ isError: undefined, clean: true, stray: true, image: true });
  });

  it("I349-VP5: CLI exit code and MCP clean agree", async () => {
    seedLayoutDrift(tmp);
    const driftCli = runCli(["validate-project", "--project-dir", tmp]).exitCode;
    const driftMcp = (await validate()).structuredContent?.clean;
    const pristine = copyFixture();
    try {
      const inSyncCli = runCli(["validate-project", "--project-dir", pristine]).exitCode;
      __setProjectRoot(pristine);
      const inSyncMcp = (await validate()).structuredContent?.clean;
      expect({
        drift: { cliExit: driftCli, mcpClean: driftMcp },
        inSync: { cliExit: inSyncCli, mcpClean: inSyncMcp },
      }).to.deep.equal({
        drift: { cliExit: 1, mcpClean: false },
        inSync: { cliExit: 0, mcpClean: true },
      });
    } finally {
      fs.rmSync(pristine, { recursive: true, force: true });
    }
  });

  it("I349-VP6: section scopes clean", async () => {
    seedLayoutDrift(tmp);
    const otherCli = runCli(["validate-project", "--project-dir", tmp, "--section", "eventSheets"]).exitCode;
    const ownCli = runCli(["validate-project", "--project-dir", tmp, "--section", "layouts"]).exitCode;
    const other = await validate({ section: "eventSheets" });
    const own = await validate({ section: "layouts" });
    expect({
      other: {
        cliExit: otherCli,
        mcpClean: other.structuredContent?.clean,
        noLayoutsLine: !textOf(other).includes("[layouts]"),
      },
      own: { cliExit: ownCli, mcpClean: own.structuredContent?.clean },
      strays: textOf(other).includes("[strays]"),
    }).to.deep.equal({
      other: { cliExit: 0, mcpClean: true, noLayoutsLine: true },
      own: { cliExit: 1, mcpClean: false },
      strays: true,
    });
  });
});
