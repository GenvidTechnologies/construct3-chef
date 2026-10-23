import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { __getHandler, __setRegistry, __resetTestState } from "../../src/mcp/server.js";
import { createProjectContext } from "../../src/mcp/projectContext.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";

/**
 * #289 — the MCP tools seed SIDs from the registry under the project's CONFIGURED
 * `extractedDir`, not a hardcoded `extracted/`.
 *
 * Each synthetic project keeps its sid-registry.txt under exactly one directory
 * and has no `extracted/` at all (asserted as a precondition), so a call site that
 * drops `extractedDir` reads `<root>/extracted/sid-registry.txt` and throws.
 * Built through createProjectContext + __setRegistry (not __setProjectRoot, which
 * hardcodes the default config and cannot carry a configured extractedDir).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

const VALID_RECIPE = JSON.stringify({
  addInstVars: [{ type: "Text", instanceVariables: [{ name: "extractedDirSeeding", type: "number" }] }],
});

// The handlers only touch watcher.txId / bump / suppress / expect.
function makeFakeWatcher(): any {
  return {
    txId: 0,
    bump() {
      this.txId++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    expect() {},
  };
}

const extra = () => ({ signal: new AbortController().signal });

describe("MCP tools seed SIDs from the configured extractedDir (#289)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "xd-seed-"));
    fs.cpSync(FIXTURE_DIR, root, { recursive: true });
  });

  afterEach(() => {
    __resetTestState();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Moves the generated output to `dir` (null: leave it under extracted/) and
  // optionally writes a config naming it. Returns a registered context.
  async function setup(dir: string | null) {
    if (dir !== null) {
      fs.renameSync(path.join(root, "extracted"), path.join(root, dir));
      fs.writeFileSync(path.join(root, "construct3-chef.config.json"), JSON.stringify({ extractedDir: dir }));
      expect(fs.existsSync(path.join(root, "extracted")), "precondition: no extracted/ directory").to.be.false;
    }
    const outDir = dir ?? "extracted";
    expect(fs.existsSync(path.join(root, outDir, "sid-registry.txt")), "precondition: registry present").to.be.true;

    const ctx = await createProjectContext("xd", root);
    expect(ctx.config.extractedDir, "precondition: configured value").to.equal(outDir);
    ctx.watcher = makeFakeWatcher();
    ctx.extractedDirty = true; // skip the registry freshness scan
    const registry = new ProjectRegistry();
    registry.add(ctx);
    __setRegistry(registry);
  }

  it("XD1: validate-recipe seeds SIDs from the configured extractedDir", async () => {
    await setup("gen");
    const result = (await __getHandler("validate-recipe")!({ recipe: VALID_RECIPE }, extra())) as any;
    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
  });

  it("XD2: apply-recipe seeds SIDs from the configured extractedDir", async () => {
    await setup("gen");
    const result = (await __getHandler("apply-recipe")!(
      { recipe: VALID_RECIPE, txId: "xd:0", regenerate: false },
      extra(),
    )) as any;
    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
  });

  it("XD3: a workflow tool seeds SIDs from the configured extractedDir", async () => {
    await setup("gen");
    const result = (await __getHandler("clone-replica-to-layouts")!(
      {
        templatesLayout: "layouts/Templates Layout.json",
        templateName: "default",
        sourceType: "Sprite3",
        targets: [{ layout: "layouts/UI/Second Layout.json", layer: "layer 1" }],
        txId: "xd:0",
        regenerate: false,
      },
      extra(),
    )) as any;
    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
  });

  it("XD4: an unconfigured project still seeds from <root>/extracted (root-relative value, not the absolute one)", async () => {
    await setup(null);
    expect(fs.existsSync(path.join(root, "construct3-chef.config.json")), "precondition: no config").to.be.false;
    const result = (await __getHandler("validate-recipe")!({ recipe: VALID_RECIPE }, extra())) as any;
    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
  });
});
