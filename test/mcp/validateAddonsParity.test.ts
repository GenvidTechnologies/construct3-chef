import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { runCli } from "../helpers/runCli.js";
import {
  __getHandler,
  __getToolConfig,
  __setProjectRoot,
  __setTestWatcher,
  __resetTestState,
} from "../../src/mcp/server.js";

// Pins acceptance criterion R6 (#220, ADR 0038 — "validate-addons gating is a
// deny-list"): the `validate-addons` MCP tool's rendered text must equal the
// CLI's stdout for the same project — both surfaces render through the same
// `formatAddonValidation` formatter (wiki/reference/cli-addons.md: "Output
// uses the same formatAddonValidation formatter as the MCP validate-addons
// tool, so results are byte-identical between surfaces") — and the MCP tool
// must NOT have gained a --skip-gate counterpart: following ADR 0025's
// precedent for --fail-on-strays, exit-code gating stays CLI-only and MCP's
// isError is reserved for genuine tool failure, never a findings threshold.
//
// validate-addons is READ_ONLY (see test/c3/validateAddonsCli.test.ts's own
// comment), so — like that file — the tracked fixtures are addressed
// directly; no temp copy needed.

const ADDON_VALIDATE_ROOT = path.resolve("test/fixtures/addon-validate");
const SAMPLE_FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

function makeExtra(): any {
  const ac = new AbortController();
  return { signal: ac.signal };
}

// Minimal fake watcher — validate-addons only reads watcher.txId (via
// txIdLine); it never bumps or suppresses.
function makeFakeWatcher(txId = 0): any {
  return {
    txId,
    bump(): void {
      this.txId++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    expect(_filePath: string): void {},
  };
}

describe("validate-addons MCP/CLI parity (#220 R6)", function () {
  // Spawns the real CLI via tsx (~0.5-2s each) — see test/helpers/runCli.ts.
  this.timeout(30_000);

  afterEach(() => {
    __resetTestState();
  });

  const cases: Array<[string, string]> = [
    ["addon-validate (multi-family findings)", ADDON_VALIDATE_ROOT],
    ["construct3-chef-sample (lang-only findings)", SAMPLE_FIXTURE_ROOT],
  ];

  for (const [label, root] of cases) {
    it(`${label}: MCP text equals CLI stdout modulo the CLI's trailing newline and the MCP txId footer`, async () => {
      const cliResult = runCli(["validate-addons", "--project-dir", root]);

      __setProjectRoot(root);
      __setTestWatcher(makeFakeWatcher(0));

      const handler = __getHandler("validate-addons")!;
      expect(handler).to.exist;
      const mcpResult = (await handler({}, makeExtra())) as any;

      expect(mcpResult.isError).to.be.undefined;
      expect(mcpResult.content).to.have.length(1);
      expect(mcpResult.content[0].type).to.equal("text");

      // CLI: console.log appends exactly one trailing "\n" after
      // formatAddonValidation's own (no-trailing-newline) output — strip it
      // explicitly rather than reaching for a loose .include() check.
      expect(
        cliResult.stdout.endsWith("\n"),
        `CLI stdout should end with exactly one newline: ${cliResult.stdout}`,
      ).to.equal(true);
      expect(cliResult.stdout.endsWith("\n\n"), "CLI stdout should not carry a second trailing newline").to.equal(
        false,
      );
      const cliText = cliResult.stdout.slice(0, -1);

      // MCP: mcpContent appends a "\ntxId: <token>" footer line.
      const mcpRawText: string = mcpResult.content[0].text;
      expect(mcpRawText, `MCP text should carry a txId footer: ${mcpRawText}`).to.match(/\ntxId: [^\n]+$/);
      const mcpText = mcpRawText.replace(/\ntxId: [^\n]+$/, "");

      expect(mcpText, "MCP text (txId footer stripped) should equal CLI stdout (trailing newline stripped)").to.equal(
        cliText,
      );
    });
  }

  it("inputSchema carries no --skip-gate counterpart (ADR 0038: exit-code gating stays CLI-only)", () => {
    const config = __getToolConfig("validate-addons");
    expect(config, "validate-addons should be registered").to.exist;
    const keys = Object.keys(config!.inputSchema as Record<string, unknown>);

    // Positive control (same shape as T17 in serverHandlers.test.ts): without
    // this, a zero-hit gate-key check below would pass just as happily if
    // __getToolConfig returned undefined, an empty object, or the wrong tool.
    expect(keys, `validate-addons inputSchema keys: ${keys.join(", ")}`).to.include("addon");

    expect(
      keys.some((key) => /gate/i.test(key)),
      `validate-addons inputSchema keys: ${keys.join(", ")}`,
    ).to.equal(false);
  });
});
