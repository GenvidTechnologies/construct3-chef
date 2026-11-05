import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanReportContent } from "../../src/mcp/structuredReport.js";
import {
  __getHandler,
  __getToolConfig,
  __setTestWatcher,
  __setProjectRoot,
  __resetTestState,
} from "../../src/mcp/server.js";
import { runCli } from "../helpers/runCli.js";
import { seedAbsentFile } from "../helpers/seedAbsentFile.js";
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";

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
    // A crash also exits 1, so the drift case also asserts the CLI reached its report.
    const driftRun = runCli(["validate-project", "--project-dir", tmp]);
    const driftCli = driftRun.exitCode;
    const driftReported = driftRun.stdout.includes("change(s) found");
    const driftMcp = (await validate()).structuredContent?.clean;
    const pristine = copyFixture();
    try {
      const inSyncCli = runCli(["validate-project", "--project-dir", pristine]).exitCode;
      __setProjectRoot(pristine);
      const inSyncMcp = (await validate()).structuredContent?.clean;
      expect({
        drift: { cliExit: driftCli, cliReported: driftReported, mcpClean: driftMcp },
        inSync: { cliExit: inSyncCli, mcpClean: inSyncMcp },
      }).to.deep.equal({
        drift: { cliExit: 1, cliReported: true, mcpClean: false },
        inSync: { cliExit: 0, mcpClean: true },
      });
    } finally {
      fs.rmSync(pristine, { recursive: true, force: true });
    }
  });

  it("I349-VP6: section scopes clean", async () => {
    seedLayoutDrift(tmp);
    const otherCli = runCli(["validate-project", "--project-dir", tmp, "--section", "eventSheets"]).exitCode;
    const ownRun = runCli(["validate-project", "--project-dir", tmp, "--section", "layouts"]);
    const ownCli = ownRun.exitCode;
    const other = await validate({ section: "eventSheets" });
    const own = await validate({ section: "layouts" });
    expect({
      other: {
        cliExit: otherCli,
        mcpClean: other.structuredContent?.clean,
        noLayoutsLine: !textOf(other).includes("[layouts]"),
      },
      own: {
        cliExit: ownCli,
        cliReported: ownRun.stdout.includes("change(s) found"),
        mcpClean: own.structuredContent?.clean,
      },
      strays: textOf(other).includes("[strays]"),
    }).to.deep.equal({
      other: { cliExit: 0, mcpClean: true, noLayoutsLine: true },
      own: { cliExit: 1, cliReported: true, mcpClean: false },
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

describe("MCP scan-addon-usage structured content (#349)", function () {
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

  async function scan(args: Record<string, unknown>): Promise<any> {
    return __getHandler("scan-addon-usage")!(args, makeExtra());
  }

  function textOf(result: any): string {
    return result.content[0].text;
  }

  it("I349-SU1: scan blast radius with affected sites gives clean false", async () => {
    const result = await scan({ addon: "MyCompany_MyEffect", from: "MyCompany_MyEffect" });
    expect({
      isError: result.isError,
      clean: result.structuredContent?.clean,
      affected: textOf(result).includes("3 site(s) affected"),
    }).to.deep.equal({ isError: undefined, clean: false, affected: true });
  });

  it("I349-SU2: scan with no affected site, or without from, is clean", async () => {
    const none = await scan({ addon: "MyCompany_MyBehavior", from: "MyCompany_MyBehavior" });
    const plain = await scan({ addon: "MyCompany_MyEffect" });
    expect({
      none: none.structuredContent?.clean,
      plain: plain.structuredContent?.clean,
    }).to.deep.equal({ none: true, plain: true });
  });

  it("I349-SU3: scan with an unresolvable source is isError with the same text", async () => {
    const addon = await scan({ addon: "NoSuchAddonXYZ" });
    const from = await scan({ addon: "MyCompany_MyBehavior", from: "NoSuchSourceXYZ" });
    expect({
      addon: { isError: addon.isError, structured: addon.structuredContent, text: textOf(addon) },
      from: { isError: from.isError, structured: from.structuredContent },
    }).to.deep.equal({
      addon: {
        isError: true,
        structured: undefined,
        text: "scan-addon-usage: addon source not found: NoSuchAddonXYZ\ntxId: default:5",
      },
      from: { isError: true, structured: undefined },
    });
  });

  it("I349-SU4: scan CLI exit code and MCP result agree", async () => {
    // A crash also exits 1, so each case also reports whether the CLI printed its own verdict line.
    const pair = async (cliArgs: string[], args: Record<string, unknown>, marker: string) => {
      const run = runCli(["scan-addon-usage", ...cliArgs, "--project-dir", tmp]);
      const result = await scan(args);
      return [
        run.exitCode,
        (run.stdout + run.stderr).includes(marker),
        result.isError ? "isError" : result.structuredContent?.clean,
      ];
    };
    expect({
      blast: await pair(
        ["MyCompany_MyEffect", "--from", "MyCompany_MyEffect"],
        { addon: "MyCompany_MyEffect", from: "MyCompany_MyEffect" },
        "3 site(s) affected",
      ),
      none: await pair(
        ["MyCompany_MyBehavior", "--from", "MyCompany_MyBehavior"],
        { addon: "MyCompany_MyBehavior", from: "MyCompany_MyBehavior" },
        "scan-addon-usage: MyCompany_MyBehavior",
      ),
      plain: await pair(["MyCompany_MyEffect"], { addon: "MyCompany_MyEffect" }, "applied at 3 site(s)"),
      missing: await pair(["NoSuchAddonXYZ"], { addon: "NoSuchAddonXYZ" }, "addon source not found: NoSuchAddonXYZ"),
    }).to.deep.equal({
      blast: [1, true, false],
      none: [0, true, true],
      plain: [0, true, true],
      missing: [1, true, "isError"],
    });
  });
});

describe("MCP addon metadata sync structured content (#349)", function () {
  this.timeout(120000);
  const cleanup: string[] = [];
  let watcher: any;

  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    __resetTestState();
  });

  function tempDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-sync-"));
    cleanup.push(root);
    return root;
  }

  /** A temp copy of the sample's manifest and addons/, with MyCompany_MyBehavior's version drifted when asked. */
  function seededProject(drift: boolean): string {
    const root = tempDir();
    seedManifestDrift(FIXTURE_DIR, root, drift ? [{ id: "MyCompany_MyBehavior", version: "0.9.0.0" }] : []);
    return root;
  }

  /** A temp copy of test/fixtures/addon-validate (blocked rows CorruptZip and LfsPointer, stale package Complete). */
  function addonValidateProject(): string {
    const root = tempDir();
    fs.cpSync(ADDON_VALIDATE_FIXTURE, root, { recursive: true });
    return root;
  }

  async function call(tool: string, root: string, args: Record<string, unknown>): Promise<any> {
    __setProjectRoot(root);
    watcher = makeFakeWatcher(5);
    __setTestWatcher(watcher);
    return __getHandler(tool)!(args, makeExtra());
  }

  const preview = (root: string, args: Record<string, unknown>) => call("preview-addon-metadata-sync", root, args);
  const sync = (root: string, args: Record<string, unknown>) => call("sync-addon-metadata", root, args);
  const MFP = { direction: "manifest-from-package" };
  const PFM = { direction: "package-from-manifest" };

  it("I349-MS1: preview with drift or a blocked row gives clean false", async () => {
    const drifted = await preview(seededProject(true), MFP);
    const blocked = await preview(addonValidateProject(), MFP);
    expect({
      drifted: { isError: drifted.isError, clean: drifted.structuredContent?.clean },
      blocked: { isError: blocked.isError, clean: blocked.structuredContent?.clean },
    }).to.deep.equal({
      drifted: { isError: undefined, clean: false },
      blocked: { isError: undefined, clean: false },
    });
  });

  it("I349-MS2: preview of an in-sync project, or of a no-manifest-entry row only, is clean", async () => {
    const pristine = await preview(seededProject(false), MFP);
    const noEntry = await preview(addonValidateProject(), { ...PFM, addon: "Misnamed.c3addon" });
    expect({
      pristine: pristine.structuredContent?.clean,
      noEntry: {
        clean: noEntry.structuredContent?.clean,
        row: noEntry.content[0].text.includes("[no-manifest-entry] NotMisnamed"),
      },
    }).to.deep.equal({ pristine: true, noEntry: { clean: true, row: true } });
  });

  it("I349-MS3: sync-addon-metadata reports clean after the call", async () => {
    const written = await sync(seededProject(true), MFP);
    const bumped = watcher.txId - 5;
    const blocked = await sync(addonValidateProject(), MFP);
    const stale = await sync(addonValidateProject(), PFM);
    expect({
      written: { clean: written.structuredContent?.clean, bumped },
      blocked: blocked.structuredContent?.clean,
      stale: stale.structuredContent?.clean,
    }).to.deep.equal({ written: { clean: true, bumped: 1 }, blocked: false, stale: false });
  });

  it("I349-MS4: sync CLI exit code and MCP clean agree", async () => {
    const cli = (root: string, extra: string[]) =>
      runCli(["sync-addon-metadata", "--project-dir", root, ...extra]).exitCode;
    const mfp = ["--direction", "manifest-from-package"];
    const pfm = ["--direction", "package-from-manifest"];
    const cleanOf = (r: any) => r.structuredContent?.clean;
    expect({
      seededApply: [cli(seededProject(true), mfp), cleanOf(await sync(seededProject(true), MFP))],
      blockedApply: [cli(addonValidateProject(), mfp), cleanOf(await sync(addonValidateProject(), MFP))],
      seededDryRun: [cli(seededProject(true), [...mfp, "--dry-run"]), cleanOf(await preview(seededProject(true), MFP))],
      pristineDryRun: [
        cli(seededProject(false), [...mfp, "--dry-run"]),
        cleanOf(await preview(seededProject(false), MFP)),
      ],
      stale: [
        cli(addonValidateProject(), pfm),
        cleanOf(await sync(addonValidateProject(), PFM)),
        cleanOf(await preview(addonValidateProject(), PFM)),
      ],
    }).to.deep.equal({
      seededApply: [0, true],
      blockedApply: [1, false],
      seededDryRun: [1, false],
      pristineDryRun: [0, true],
      stale: [1, false, false],
    });
  });

  it("I349-MS5: sync error results carry no structured content", async () => {
    const staleTx = await sync(seededProject(true), { ...MFP, txId: "default:4" });
    const syncMissing = await sync(seededProject(false), { ...MFP, addon: "NoSuchAddon" });
    const previewMissing = await preview(seededProject(false), { ...MFP, addon: "NoSuchAddon" });
    const shape = (r: any) => ({ isError: r.isError, structured: r.structuredContent });
    expect({
      staleTx: shape(staleTx),
      syncMissing: shape(syncMissing),
      previewMissing: shape(previewMissing),
    }).to.deep.equal({
      staleTx: { isError: true, structured: undefined },
      syncMissing: { isError: true, structured: undefined },
      previewMissing: { isError: true, structured: undefined },
    });
  });
});

describe("MCP findings tool descriptions (#349)", () => {
  it("I349-VP7: each findings tool's description states the structured result", () => {
    const desc = (name: string) => String(__getToolConfig(name)?.description ?? "");
    const vp = desc("validate-project");
    expect({
      "validate-project": {
        clean: vp.includes("clean"),
        section: vp.includes("section"),
        isError: vp.includes("isError"),
        strays: /stray/i.test(vp),
      },
      "validate-addons": { clean: desc("validate-addons").includes("clean") },
      "scan-addon-usage": {
        clean: desc("scan-addon-usage").includes("clean"),
        from: desc("scan-addon-usage").includes("from"),
      },
      "preview-addon-metadata-sync": { clean: desc("preview-addon-metadata-sync").includes("clean") },
      "sync-addon-metadata": { clean: desc("sync-addon-metadata").includes("clean") },
    }).to.deep.equal({
      "validate-project": { clean: true, section: true, isError: true, strays: true },
      "validate-addons": { clean: true },
      "scan-addon-usage": { clean: true, from: true },
      "preview-addon-metadata-sync": { clean: true },
      "sync-addon-metadata": { clean: true },
    });
  });
});
