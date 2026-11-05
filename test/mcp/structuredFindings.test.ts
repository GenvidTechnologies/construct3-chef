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

const ADDON_VALIDATE_FIXTURE = path.join(__dirname, "..", "fixtures", "addon-validate");

/** A project with no bundled packages and one unbundled usedAddons entry (the I311 shape). */
function makeZeroPackageProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-zero-"));
  fs.writeFileSync(
    path.join(root, "project.c3proj"),
    JSON.stringify({ usedAddons: [{ id: "Genvid_YouTube", type: "plugin", bundled: false }] }),
  );
  return root;
}

describe("MCP validate-addons structured content (#349)", function () {
  this.timeout(120000);
  const cleanup: string[] = [];

  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    __resetTestState();
  });

  async function validateAddonsAt(root: string, args: Record<string, unknown> = {}): Promise<any> {
    __setProjectRoot(root);
    __setTestWatcher(makeFakeWatcher(5));
    return __getHandler("validate-addons")!(args, makeExtra());
  }

  function textOf(result: any): string {
    return result.content[0].text;
  }

  it("I349-VA1: validate-addons findings give clean false", async () => {
    const root = copyFixture();
    cleanup.push(root);
    const result = await validateAddonsAt(root);
    expect({
      isError: result.isError,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
    }).to.deep.equal({ isError: undefined, clean: false, reportIsText: true });
  });

  it("I349-VA2: validate-addons accept controls are clean", async () => {
    const root = copyFixture();
    const zero = makeZeroPackageProject();
    cleanup.push(root, zero);
    const effect = await validateAddonsAt(root, { addon: "MyCompany_MyEffect" });
    const none = await validateAddonsAt(zero);
    expect({
      effect: { clean: effect.structuredContent?.clean, consistent: textOf(effect).includes("all consistent") },
      zero: { clean: none.structuredContent?.clean, nothing: textOf(none).includes("nothing to validate") },
    }).to.deep.equal({
      effect: { clean: true, consistent: true },
      zero: { clean: true, nothing: true },
    });
  });

  it("I349-VA3: validate-addons CLI exit code and MCP clean agree", async () => {
    const root = copyFixture();
    const zero = makeZeroPackageProject();
    cleanup.push(root, zero);
    const pair = async (dir: string, cliExtra: string[], args: Record<string, unknown>) => [
      runCli(["validate-addons", "--project-dir", dir, ...cliExtra]).exitCode,
      (await validateAddonsAt(dir, args)).structuredContent?.clean,
    ];
    expect({
      sample: await pair(root, [], {}),
      effect: await pair(root, ["--addon", "MyCompany_MyEffect"], { addon: "MyCompany_MyEffect" }),
      addonValidate: await pair(ADDON_VALIDATE_FIXTURE, [], {}),
      zero: await pair(zero, [], {}),
    }).to.deep.equal({
      sample: [1, false],
      effect: [0, true],
      addonValidate: [1, false],
      zero: [0, true],
    });
  });

  it("I349-VA4: validate-addons error results carry no structured content", async () => {
    const root = copyFixture();
    cleanup.push(root);
    const traversal = await validateAddonsAt(root, { addon: "../x" });
    const missing = await validateAddonsAt(root, { addon: "NoSuchAddonXYZ" });
    expect({
      traversal: { isError: traversal.isError, structured: traversal.structuredContent },
      missing: { isError: missing.isError, structured: missing.structuredContent },
    }).to.deep.equal({
      traversal: { isError: true, structured: undefined },
      missing: { isError: true, structured: undefined },
    });
  });
});
