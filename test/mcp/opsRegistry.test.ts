import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OpsRegistry, type RegisterableServer, type RegisterableTool } from "../../src/mcp/opsRegistry.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_OPS_DIR = path.join(__dirname, "..", "fixtures", "sample-ops");

// ─── Fake infrastructure ──────────────────────────────────────────────────────

/** Capture of a registerTool call */
interface CapturedTool {
  name: string;
  config: {
    title?: string;
    description?: string;
    annotations?: unknown;
    inputSchema?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
  removed: boolean;
  updates: Array<{
    description?: string;
    paramsSchema?: Record<string, unknown>;
    callback?: unknown;
  }>;
}

function makeFakeTool(captured: CapturedTool): RegisterableTool {
  return {
    update(updates) {
      captured.updates.push({
        description: updates.description,
        paramsSchema: updates.paramsSchema,
        callback: updates.callback,
      });
      // Also update the live handler so re-invocations use the new callback
      if (updates.callback) {
        captured.handler = updates.callback as CapturedTool["handler"];
      }
    },
    remove() {
      captured.removed = true;
    },
  };
}

function makeFakeServer(): {
  server: RegisterableServer;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();

  const server: RegisterableServer = {
    registerTool(name, config, handler) {
      const captured: CapturedTool = {
        name,
        config: config as CapturedTool["config"],
        handler: handler as CapturedTool["handler"],
        removed: false,
        updates: [],
      };
      tools.set(name, captured);
      return makeFakeTool(captured);
    },
  };

  return { server, tools };
}

/** Canned CallToolResult returned by the applyRecipe spy */
function cannedResult(): CallToolResult {
  return { content: [{ type: "text", text: "applied" }] };
}

interface SpyCall {
  recipe: Recipe;
  opts: { regenerate?: boolean; label?: string };
}

function makeApplySpy(): {
  spy: (recipe: Recipe, opts: { regenerate?: boolean; label?: string }, extra: unknown) => Promise<CallToolResult>;
  calls: SpyCall[];
} {
  const calls: SpyCall[] = [];
  return {
    spy: async (recipe, opts, _extra) => {
      calls.push({ recipe, opts });
      return cannedResult();
    },
    calls,
  };
}

/** Minimal fake extra — handlers only need it passed through to applyRecipe */
const FAKE_EXTRA = {} as never;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeOpFile(dir: string, name: string, content: object): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(content, null, "\t") + "\n", "utf8");
}

function deleteOpFile(dir: string, name: string): void {
  fs.rmSync(path.join(dir, `${name}.json`));
}

const MINIMAL_OP = {
  description: "A minimal op",
  params: [{ name: "TARGET", type: "string", required: true, description: "target SID" }],
  recipe: {
    files: {
      "eventSheets/{{TARGET}}.json": { create: true, events: [] },
    },
  },
};

const MINIMAL_OP_2 = {
  description: "A second op",
  params: [],
  recipe: {
    files: {
      "eventSheets/second.json": { create: true, events: [] },
    },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OpsRegistry", () => {
  // ── start() with sample-ops fixture ─────────────────────────────────────────

  describe("start() with sample-ops fixture", () => {
    let fakeServer: ReturnType<typeof makeFakeServer>;
    let applySpy: ReturnType<typeof makeApplySpy>;
    let registry: OpsRegistry;

    beforeEach(() => {
      fakeServer = makeFakeServer();
      applySpy = makeApplySpy();
      registry = new OpsRegistry({
        server: fakeServer.server,
        opsDir: SAMPLE_OPS_DIR,
        watch: false,
        applyRecipe: applySpy.spy,
      });
      registry.start();
    });

    afterEach(() => {
      registry.stop();
    });

    it("registers a list-ops tool", () => {
      expect(fakeServer.tools.has("list-ops")).to.equal(true);
    });

    it("registers one op-* tool for add-screen (valid op)", () => {
      expect(fakeServer.tools.has("op-add-screen")).to.equal(true);
    });

    it("does NOT register a tool for bad-schema (malformed op)", () => {
      // bad-schema.json fails OpDefinitionSchema (missing description)
      expect(fakeServer.tools.has("op-bad-schema")).to.equal(false);
    });

    it("op-add-screen tool has correct title and description", () => {
      const tool = fakeServer.tools.get("op-add-screen")!;
      expect(tool.config.title).to.equal("Op: add-screen");
      expect(tool.config.description).to.equal("Add a new screen event sheet");
    });

    it("op-add-screen inputSchema has SCREEN_NAME (required) and DEPTH (optional with default)", () => {
      const tool = fakeServer.tools.get("op-add-screen")!;
      const schema = tool.config.inputSchema!;
      expect(schema).to.have.property("SCREEN_NAME");
      expect(schema).to.have.property("DEPTH");
    });
  });

  // ── list-ops handler ─────────────────────────────────────────────────────────

  describe("list-ops handler", () => {
    let fakeServer: ReturnType<typeof makeFakeServer>;
    let registry: OpsRegistry;

    beforeEach(() => {
      fakeServer = makeFakeServer();
      registry = new OpsRegistry({
        server: fakeServer.server,
        opsDir: SAMPLE_OPS_DIR,
        watch: false,
        applyRecipe: makeApplySpy().spy,
      });
      registry.start();
    });

    afterEach(() => {
      registry.stop();
    });

    it("returns text containing op name for the valid op", async () => {
      const handler = fakeServer.tools.get("list-ops")!.handler;
      const result = await handler({}, FAKE_EXTRA);
      const text = (result.content[0] as { text: string }).text;
      expect(text).to.include("add-screen");
    });

    it("returns text containing load error for bad-schema", async () => {
      const handler = fakeServer.tools.get("list-ops")!.handler;
      const result = await handler({}, FAKE_EXTRA);
      const text = (result.content[0] as { text: string }).text;
      expect(text).to.include("load errors");
      expect(text).to.include("bad-schema.json");
    });

    it("reflects reconcile — shows newly added ops", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-list-test-"));
      try {
        const registry2 = new OpsRegistry({
          server: fakeServer.server,
          opsDir: tmpDir,
          watch: false,
          applyRecipe: makeApplySpy().spy,
        });
        registry2.start();

        // Initially empty
        const listHandler = fakeServer.tools.get("list-ops")!.handler;
        // list-ops was already registered by the first registry; this is a shared fake server
        // — use a separate server for this sub-test
        const { server: srv2, tools: tools2 } = makeFakeServer();
        const reg2 = new OpsRegistry({
          server: srv2,
          opsDir: tmpDir,
          watch: false,
          applyRecipe: makeApplySpy().spy,
        });
        reg2.start();

        const listHandler2 = tools2.get("list-ops")!.handler;

        writeOpFile(tmpDir, "new-op", MINIMAL_OP);
        reg2.reconcile();

        const result = listHandler2({}, FAKE_EXTRA) as unknown as Promise<CallToolResult>;
        // synchronous inspection after reconcile
        reg2.stop();
        void listHandler;
        return result.then((r) => {
          const text = (r.content[0] as { text: string }).text;
          expect(text).to.include("new-op");
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  // ── op handler invocation ────────────────────────────────────────────────────

  describe("op-* handler invocation", () => {
    let fakeServer: ReturnType<typeof makeFakeServer>;
    let applySpy: ReturnType<typeof makeApplySpy>;
    let registry: OpsRegistry;

    beforeEach(() => {
      fakeServer = makeFakeServer();
      applySpy = makeApplySpy();
      registry = new OpsRegistry({
        server: fakeServer.server,
        opsDir: SAMPLE_OPS_DIR,
        watch: false,
        applyRecipe: applySpy.spy,
      });
      registry.start();
    });

    afterEach(() => {
      registry.stop();
    });

    it("valid args: substitutes {{TOKEN}} and calls applyRecipe with regenerate:true", async () => {
      const handler = fakeServer.tools.get("op-add-screen")!.handler;
      const result = await handler({ SCREEN_NAME: "Lobby" }, FAKE_EXTRA);
      // should not be an error
      expect(result.isError).to.not.equal(true);
      expect(applySpy.calls).to.have.length(1);
      const call = applySpy.calls[0];
      expect(call.opts.regenerate).to.equal(true);
      expect(call.opts.label).to.include("add-screen");
      // Verify token substitution: SCREEN_NAME=Lobby should appear in file key
      const files = call.recipe.files;
      expect(files).to.have.property("eventSheets/Lobby.json");
    });

    it("valid args with default DEPTH used when not provided", async () => {
      const handler = fakeServer.tools.get("op-add-screen")!.handler;
      await handler({ SCREEN_NAME: "Menu" }, FAKE_EXTRA);
      const files = applySpy.calls[0].recipe.files!;
      // default DEPTH=0 should appear in the comment
      const events = (files["eventSheets/Menu.json"] as { events: Array<{ comment?: string }> }).events;
      expect(events[0].comment).to.include("depth 0");
    });

    it("missing required param returns mcpError and does NOT call applyRecipe", async () => {
      const handler = fakeServer.tools.get("op-add-screen")!.handler;
      const result = await handler({}, FAKE_EXTRA);
      expect(result.isError).to.equal(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).to.include("SCREEN_NAME");
      expect(applySpy.calls).to.have.length(0);
    });

    it("unknown arg returns mcpError and does NOT call applyRecipe", async () => {
      const handler = fakeServer.tools.get("op-add-screen")!.handler;
      const result = await handler({ SCREEN_NAME: "X", UNKNOWN_PARAM: "oops" }, FAKE_EXTRA);
      expect(result.isError).to.equal(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).to.include("UNKNOWN_PARAM");
      expect(applySpy.calls).to.have.length(0);
    });
  });

  // ── reconcile() — dynamic add/update/remove ──────────────────────────────────

  describe("reconcile() with temp dir", () => {
    let tmpDir: string;
    let fakeServer: ReturnType<typeof makeFakeServer>;
    let applySpy: ReturnType<typeof makeApplySpy>;
    let registry: OpsRegistry;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-reconcile-test-"));
      fakeServer = makeFakeServer();
      applySpy = makeApplySpy();
      registry = new OpsRegistry({
        server: fakeServer.server,
        opsDir: tmpDir,
        watch: false,
        applyRecipe: applySpy.spy,
      });
      registry.start();
    });

    afterEach(() => {
      registry.stop();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it("starts with no op-* tools when tmpDir is empty", () => {
      // only list-ops should be registered
      const toolNames = [...fakeServer.tools.keys()];
      expect(toolNames).to.deep.equal(["list-ops"]);
    });

    it("add op file → new op-* tool registered after reconcile", () => {
      writeOpFile(tmpDir, "my-op", MINIMAL_OP);
      registry.reconcile();
      expect(fakeServer.tools.has("op-my-op")).to.equal(true);
    });

    it("edit op file → update() called on existing tool after reconcile", () => {
      writeOpFile(tmpDir, "my-op", MINIMAL_OP);
      registry.reconcile();

      const before = fakeServer.tools.get("op-my-op")!;
      expect(before.updates).to.have.length(0);

      // Change description
      writeOpFile(tmpDir, "my-op", { ...MINIMAL_OP, description: "Updated description" });
      registry.reconcile();

      expect(before.updates).to.have.length(1);
      expect(before.updates[0].description).to.equal("Updated description");
    });

    it("delete op file → remove() called and tool gone after reconcile", () => {
      writeOpFile(tmpDir, "my-op", MINIMAL_OP);
      registry.reconcile();
      expect(fakeServer.tools.has("op-my-op")).to.equal(true);

      const captured = fakeServer.tools.get("op-my-op")!;
      deleteOpFile(tmpDir, "my-op");
      registry.reconcile();

      expect(captured.removed).to.equal(true);
      // tool map entry stays in fakeServer (we don't delete from the map on remove);
      // the registry's own tracking should reflect the removal
      expect(fakeServer.tools.has("op-my-op")).to.equal(true); // still in fake map
      // But a new reconcile should not re-add it (it's gone from disk)
      registry.reconcile();
      expect(captured.updates).to.have.length(0); // no update after removal
    });

    it("two ops — add one, then add another → both registered", () => {
      writeOpFile(tmpDir, "op-a", MINIMAL_OP);
      registry.reconcile();
      writeOpFile(tmpDir, "op-b", MINIMAL_OP_2);
      registry.reconcile();
      expect(fakeServer.tools.has("op-op-a")).to.equal(true);
      expect(fakeServer.tools.has("op-op-b")).to.equal(true);
    });

    it("malformed op file surfaces in list-ops errors but no tool registered", () => {
      fs.writeFileSync(path.join(tmpDir, "broken.json"), "{ not valid json", "utf8");
      registry.reconcile();
      expect(fakeServer.tools.has("op-broken")).to.equal(false);
      // list-ops should mention the error
      const listHandler = fakeServer.tools.get("list-ops")!.handler;
      return listHandler({}, FAKE_EXTRA).then((result) => {
        const text = (result.content[0] as { text: string }).text;
        expect(text).to.include("load errors");
        expect(text).to.include("broken.json");
      });
    });
  });

  // ── watch: false ─────────────────────────────────────────────────────────────

  describe("watch: false", () => {
    it("does not start an fs.watch — stop() is a no-op", () => {
      const { server, tools } = makeFakeServer();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-nowatch-"));
      try {
        const registry = new OpsRegistry({
          server,
          opsDir: tmpDir,
          watch: false,
          applyRecipe: makeApplySpy().spy,
        });
        registry.start();
        // Should only have list-ops (empty dir)
        expect([...tools.keys()]).to.deep.equal(["list-ops"]);
        // stop() should be safe even with no watcher
        expect(() => registry.stop()).to.not.throw();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  // ── watch: true with non-existent dir ────────────────────────────────────────

  describe("watch: true with non-existent opsDir", () => {
    it("start() succeeds without throwing — hot-reload silently skipped", () => {
      const { server } = makeFakeServer();
      const nonExistent = path.join(os.tmpdir(), `ops-nonexist-${Date.now()}`);
      const logs: string[] = [];
      const registry = new OpsRegistry({
        server,
        opsDir: nonExistent,
        watch: true,
        applyRecipe: makeApplySpy().spy,
        log: (_level, msg) => logs.push(msg),
      });
      expect(() => registry.start()).to.not.throw();
      registry.stop();
      // Should log an info message about the missing dir
      expect(logs.some((l) => l.includes("hot-reload disabled"))).to.equal(true);
    });
  });
});
