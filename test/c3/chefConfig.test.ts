import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadChefConfig, resolveOpsDir } from "../../src/c3/chefConfig.js";

describe("loadChefConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns schema default when no config file is present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg).to.deep.equal({ extractedDir: "extracted", ops: { dir: "ops", watch: true } });
  });

  it("returns value from config file when present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "my-extracted" }));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg).to.deep.equal({ extractedDir: "my-extracted", ops: { dir: "ops", watch: true } });
  });

  it("override beats file value", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "from-file" }));
    const cfg = await loadChefConfig(tmpDir, { extractedDir: "from-override" });
    expect(cfg.extractedDir).to.equal("from-override");
  });

  it("override beats schema default when no file present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    const cfg = await loadChefConfig(tmpDir, { extractedDir: "ovr" });
    expect(cfg.extractedDir).to.equal("ovr");
  });

  it("falls back to default when config contains a path-escaping extractedDir", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ extractedDir: "../escape" }));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg.extractedDir).to.not.equal("../escape");
    expect(cfg.extractedDir).to.equal("extracted");
  });

  it("falls back to default when config file contains malformed JSON", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), "{ not valid json");
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg).to.deep.equal({ extractedDir: "extracted", ops: { dir: "ops", watch: true } });
  });

  // ── ops block ──────────────────────────────────────────────────────────────

  it("absent ops block yields { dir: 'ops', watch: true }", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg.ops).to.deep.equal({ dir: "ops", watch: true });
  });

  it("explicit ops block is honored", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(
      path.join(tmpDir, "construct3-chef.config.json"),
      JSON.stringify({ ops: { dir: "recipes", watch: false } }),
    );
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg.ops).to.deep.equal({ dir: "recipes", watch: false });
  });

  it("partial ops block fills missing fields with defaults", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), JSON.stringify({ ops: { watch: false } }));
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg.ops).to.deep.equal({ dir: "ops", watch: false });
  });

  it("error-fallback branch returns ops default when config is malformed", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), "{ not valid json");
    const cfg = await loadChefConfig(tmpDir);
    expect(cfg.ops).to.deep.equal({ dir: "ops", watch: true });
  });

  it("error-fallback branch honors ops override", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-"));
    writeFileSync(path.join(tmpDir, "construct3-chef.config.json"), "{ not valid json");
    const cfg = await loadChefConfig(tmpDir, { ops: { dir: "custom", watch: false } });
    expect(cfg.ops).to.deep.equal({ dir: "custom", watch: false });
  });
});

describe("resolveOpsDir", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns <root>/ops when no config file is present", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-ops-"));
    const result = await resolveOpsDir(tmpDir);
    expect(result).to.equal(path.join(tmpDir, "ops"));
  });

  it("returns configured absolute path when ops.dir is set", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-ops-"));
    writeFileSync(
      path.join(tmpDir, "construct3-chef.config.json"),
      JSON.stringify({ ops: { dir: "recipes", watch: false } }),
    );
    const result = await resolveOpsDir(tmpDir);
    expect(result).to.equal(path.join(tmpDir, "recipes"));
  });

  it("falls back to <root>/ops when ops.dir escapes the project root", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-ops-"));
    writeFileSync(
      path.join(tmpDir, "construct3-chef.config.json"),
      JSON.stringify({ ops: { dir: "../escape", watch: true } }),
    );
    const result = await resolveOpsDir(tmpDir);
    expect(result).to.equal(path.join(tmpDir, "ops"));
  });

  it("always returns an absolute path", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "chefcfg-ops-"));
    const result = await resolveOpsDir(tmpDir);
    expect(path.isAbsolute(result)).to.be.true;
  });
});
