import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generateSidRegistry } from "../src/c3/generators.js";
import { runCli } from "./helpers/runCli.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");
const SOURCE_ENTRIES = ["eventSheets", "layouts", "objectTypes", "scripts", "project.c3proj"];

/**
 * A project whose config moves the read surface to `gen/`: the SID registry
 * exists only there, and no default `extracted/` directory exists, so a CLI
 * command that fails to pass the configured extractedDir to applyParsed
 * throws "SID registry not found".
 */
function buildConfiguredProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "c3chef-xd5-"));
  for (const entry of SOURCE_ENTRIES) {
    cpSync(path.join(FIXTURE_ROOT, entry), path.join(root, entry), { recursive: true });
  }
  writeFileSync(path.join(root, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "gen" }));
  generateSidRegistry(root, path.join(root, "gen"), () => {});
  mkdirSync(path.join(root, "ops"));
  writeFileSync(
    path.join(root, "ops", "make-sheet.json"),
    JSON.stringify({
      description: "create an empty sheet",
      params: [],
      recipe: { files: { "eventSheets/XD5Sheet.json": { create: true, events: [] } } },
    }),
  );
  writeFileSync(
    path.join(root, "recipe.json"),
    JSON.stringify({ files: { "eventSheets/XD5Recipe.json": { create: true, events: [] } } }),
  );
  return root;
}

describe("CLI commands seed SIDs from the configured extractedDir", () => {
  let root: string;

  before(() => {
    root = buildConfiguredProject();
    expect(existsSync(path.join(root, "gen", "sid-registry.txt")), "gen/sid-registry.txt precondition").to.equal(true);
    expect(existsSync(path.join(root, "extracted")), "no default extracted/ precondition").to.equal(false);
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function expectSeededFromConfiguredDir(args: string[]): void {
    const r = runCli([...args, "--project-dir", root, "--dry-run"]);
    expect(
      { exitCode: r.exitCode, registryMissing: /SID registry not found/.test(r.stderr + r.stdout) },
      r.stderr,
    ).to.deep.equal({
      exitCode: 0,
      registryMissing: false,
    });
  }

  it("XD5: apply-recipe seeds from the configured directory", function () {
    this.timeout(60000);
    expectSeededFromConfiguredDir(["apply-recipe", path.join(root, "recipe.json")]);
  });

  it("XD5: remove-layer seeds from the configured directory", function () {
    this.timeout(60000);
    expectSeededFromConfiguredDir([
      "remove-layer",
      "--layout",
      "Gameplay/Main Layout.json",
      "--layer",
      "layer 0",
      "--cascade",
      "--remove-instances",
    ]);
  });

  it("XD5: apply-op seeds from the configured directory", function () {
    this.timeout(60000);
    expectSeededFromConfiguredDir(["apply-op", "make-sheet"]);
  });
});
