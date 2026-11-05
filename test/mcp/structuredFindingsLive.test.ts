import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { __getServer, __setTestWatcher, __setProjectRoot, __resetTestState } from "../../src/mcp/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

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
