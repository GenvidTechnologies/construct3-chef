import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __getServer, __setTestWatcher, __setProjectRoot, __resetTestState } from "../../src/mcp/server.js";
import { ALL_SECTION_KEYS } from "../../src/c3/projectSync.js";
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");
const ADDON_VALIDATE_FIXTURE = path.join(__dirname, "..", "fixtures", "addon-validate");

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

/** Live SDK client over an in-memory pair, so the SDK's own input and output validation runs. */
describe("MCP structured findings through the live SDK (#349)", function () {
  this.timeout(60000);
  let client: Client;
  let tmp: string;

  before(async () => {
    client = new Client({ name: "structuredFindingsLive-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), __getServer().connect(serverTransport)]);
    // The client caches output validators from listTools; callTool without it skips them.
    await client.listTools();
  });

  after(async () => {
    await client.close();
    await __getServer().close();
  });

  beforeEach(() => {
    __setTestWatcher(makeFakeWatcher(5));
  });

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    __resetTestState();
  });

  function textOf(result: any): string {
    return result.content[0].text;
  }

  it("I349-L1: tools/list carries the outputSchema on exactly the five findings tools", async () => {
    const { tools } = await client.listTools();
    const withSchema = tools.filter((t: any) => t.outputSchema !== undefined);
    const vp: any = tools.find((t) => t.name === "validate-project");
    expect({
      names: withSchema.map((t) => t.name).sort(),
      shapes: withSchema.map((t: any) => ({
        type: t.outputSchema.type,
        required: [...(t.outputSchema.required ?? [])].sort(),
      })),
      sectionEnum: vp?.inputSchema?.properties?.section?.enum,
    }).to.deep.equal({
      names: [
        "preview-addon-metadata-sync",
        "scan-addon-usage",
        "sync-addon-metadata",
        "validate-addons",
        "validate-project",
      ],
      shapes: Array.from({ length: 5 }, () => ({ type: "object", required: ["clean", "report"] })),
      sectionEnum: ALL_SECTION_KEYS,
    });
  });

  it("I349-L2a: live validate-project survives SDK validation", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    fs.copyFileSync(path.join(tmp, "layouts", "Templates Layout.json"), path.join(tmp, "layouts", "Extra349.json"));
    __setProjectRoot(tmp);
    const result: any = await client.callTool({ name: "validate-project", arguments: {} });
    expect({
      isError: result.isError,
      blocks: result.content.length,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
      noSubstitution: !textOf(result).includes("Output validation error"),
    }).to.deep.equal({ isError: undefined, blocks: 1, clean: false, reportIsText: true, noSubstitution: true });
  });

  it("I349-L2b: live validate-addons survives SDK validation", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    __setProjectRoot(tmp);
    const result: any = await client.callTool({ name: "validate-addons", arguments: {} });
    expect({
      isError: result.isError,
      blocks: result.content.length,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
      noSubstitution: !textOf(result).includes("Output validation error"),
    }).to.deep.equal({ isError: undefined, blocks: 1, clean: false, reportIsText: true, noSubstitution: true });
  });

  it("I349-L2c: live scan-addon-usage survives SDK validation", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    __setProjectRoot(tmp);
    const result: any = await client.callTool({
      name: "scan-addon-usage",
      arguments: { addon: "MyCompany_MyEffect", from: "MyCompany_MyEffect" },
    });
    expect({
      isError: result.isError,
      blocks: result.content.length,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
      noSubstitution: !textOf(result).includes("Output validation error"),
    }).to.deep.equal({ isError: undefined, blocks: 1, clean: false, reportIsText: true, noSubstitution: true });
  });

  it("I349-L2d: live preview-addon-metadata-sync survives SDK validation", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    seedManifestDrift(FIXTURE_DIR, tmp, [{ id: "MyCompany_MyBehavior", version: "0.9.0.0" }]);
    __setProjectRoot(tmp);
    const result: any = await client.callTool({
      name: "preview-addon-metadata-sync",
      arguments: { direction: "manifest-from-package" },
    });
    expect({
      isError: result.isError,
      blocks: result.content.length,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
      noSubstitution: !textOf(result).includes("Output validation error"),
    }).to.deep.equal({ isError: undefined, blocks: 1, clean: false, reportIsText: true, noSubstitution: true });
  });

  it("I349-L2e: live sync-addon-metadata survives SDK validation", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    fs.cpSync(ADDON_VALIDATE_FIXTURE, tmp, { recursive: true });
    __setProjectRoot(tmp);
    const result: any = await client.callTool({
      name: "sync-addon-metadata",
      arguments: { direction: "manifest-from-package" },
    });
    expect({
      isError: result.isError,
      blocks: result.content.length,
      clean: result.structuredContent?.clean,
      reportIsText: result.structuredContent?.report === textOf(result),
      noSubstitution: !textOf(result).includes("Output validation error"),
    }).to.deep.equal({ isError: undefined, blocks: 1, clean: false, reportIsText: true, noSubstitution: true });
  });

  it("I349-L3b: live scan-addon-usage with an unresolvable addon is isError", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    __setProjectRoot(tmp);
    const result: any = await client.callTool({ name: "scan-addon-usage", arguments: { addon: "NoSuchAddonXYZ" } });
    expect({
      isError: result.isError,
      structured: result.structuredContent,
      notFound: textOf(result).includes("addon source not found"),
    }).to.deep.equal({ isError: true, structured: undefined, notFound: true });
  });

  it("I349-L3a: live validate-project failure paths", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i349-live-"));
    fs.mkdirSync(path.join(tmp, "layouts"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "project.c3proj"), "{ NOT JSON");
    fs.writeFileSync(path.join(tmp, "layouts", "notes.txt"), "a stray note\n");
    __setProjectRoot(tmp);
    const failed: any = await client.callTool({ name: "validate-project", arguments: {} });
    const bogus: any = await client.callTool({ name: "validate-project", arguments: { section: "bogus" } });
    expect({
      failed: {
        isError: failed.isError,
        structured: failed.structuredContent,
        parse: textOf(failed).includes("Could not parse"),
        stray: textOf(failed).includes("! layouts/notes.txt"),
      },
      bogus: { isError: bogus.isError, input: textOf(bogus).includes("Input validation error") },
    }).to.deep.equal({
      failed: { isError: true, structured: undefined, parse: true, stray: true },
      bogus: { isError: true, input: true },
    });
  });
});
