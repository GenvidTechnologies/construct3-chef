import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProjectRegistry } from "../../src/mcp/launchConfig.js";

/**
 * #216: `--discover-projects` opt-in multi-root auto-discovery, threaded
 * through `buildProjectRegistry`'s `opts.discoverProjects`. Synthetic
 * temp-dir only (R8) — the canonical fixture has no multi-marker layout, so
 * a fixture-based assertion here would pass vacuously.
 *
 * `test/mcp/rootResolution.test.ts` and `test/mcp/launchConfig.test.ts` are
 * NOT touched by this feature: with the flag omitted (the default), nothing
 * in the resolution path changes (R3). These tests only exercise the NEW
 * `discoverProjects: true` branch.
 */
describe("buildProjectRegistry --discover-projects (#216)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-discover-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function makeMarkerDir(parent: string, name: string): string {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "project.c3proj"), "{}");
    return dir;
  }

  // ── R4: flag on, 2+ discovered → all N registered ──────────────────────────

  it("R4: registers every discovered root when 2+ markers are found and --default-project is given", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    const rootA = makeMarkerDir(tmp, "game-a");
    const rootB = makeMarkerDir(tmp, "game-b");
    try {
      const registry = await buildProjectRegistry(undefined, undefined, "game-a", {
        log: () => {},
        env: { ...process.env, C3_PROJECT_DIR: undefined } as unknown as NodeJS.ProcessEnv,
        discoverProjects: true,
      });

      expect(
        registry
          .list()
          .map((p) => p.id)
          .sort(),
      ).to.deep.equal(["game-a", "game-b"]);
      expect(registry.get("game-a")?.root).to.equal(rootA);
      expect(registry.get("game-b")?.root).to.equal(rootB);
      expect(registry.defaultId).to.equal("game-a");
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ── R5: flag on, 2+ discovered, no --default-project → actionable failure ──

  it("R5: fails the launch naming the discovered ids and the disambiguating flag", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    makeMarkerDir(tmp, "game-a");
    makeMarkerDir(tmp, "game-b");
    try {
      let caught: Error | undefined;
      try {
        await buildProjectRegistry(undefined, undefined, undefined, {
          log: () => {},
          env: { ...process.env, C3_PROJECT_DIR: undefined } as unknown as NodeJS.ProcessEnv,
          discoverProjects: true,
        });
      } catch (e) {
        caught = e as Error;
      }
      expect(caught, "buildProjectRegistry should have thrown").to.exist;
      expect(caught!.message).to.include("game-a");
      expect(caught!.message).to.include("game-b");
      expect(caught!.message).to.include("--default-project");
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ── R6 (half 1): flag on, exactly 1 discovered → single root, unchanged ────

  it("R6a: exactly one discovered root registers a single project, same as the flag being off", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    const child = makeMarkerDir(tmp, "mygame");
    try {
      const registry = await buildProjectRegistry(undefined, undefined, undefined, {
        log: () => {},
        env: { ...process.env, C3_PROJECT_DIR: undefined } as unknown as NodeJS.ProcessEnv,
        discoverProjects: true,
      });

      expect(registry.list()).to.deep.equal([
        { id: "mygame", root: child, extractedDir: path.join(child, "extracted"), isDefault: true },
      ]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ── R6 (half 2): flag on, 0 discovered → cwd fallback + existing warning ───

  it("R6b: no markers found falls back to cwd with the existing stderr warning, unchanged", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      const logs: string[] = [];
      const registry = await buildProjectRegistry(undefined, undefined, undefined, {
        log: (m) => logs.push(m),
        env: { ...process.env, C3_PROJECT_DIR: undefined } as unknown as NodeJS.ProcessEnv,
        discoverProjects: true,
      });

      expect(registry.list()).to.have.lengthOf(1);
      expect(registry.list()[0].root).to.equal(tmp);
      expect(logs.some((l) => l.includes("no project.c3proj found via --project-dir"))).to.equal(true);
      expect(logs.some((l) => l.includes("(source: cwd)"))).to.equal(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ── R7: the isMcpError guard on the plural probe result ─────────────────────

  it("R7: a plural-probe I/O error is handled (not thrown, not mistaken for 2+ candidates)", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      const failingReaddir = (): fs.Dirent[] => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      };

      const logs: string[] = [];
      // The fake readdir only reaches the PROBE call (resolveDiscoveredRoots'
      // own `readdir` param); the 0/1-spec delegate below it uses the real
      // fs, so this proves the probe's mcpError result is caught by the
      // `isMcpError` guard rather than propagating or being read as
      // `paths.length >= 2` — it falls through to the untouched delegate,
      // which (since `tmp` has no marker) resolves via the normal cwd
      // fallback.
      const registry = await buildProjectRegistry(undefined, undefined, undefined, {
        log: (m) => logs.push(m),
        env: { ...process.env, C3_PROJECT_DIR: undefined } as unknown as NodeJS.ProcessEnv,
        discoverProjects: true,
        readdir: failingReaddir as unknown as (dir: string, opts: { withFileTypes: true }) => fs.Dirent[],
      });

      expect(registry.list()).to.have.lengthOf(1);
      expect(registry.list()[0].root).to.equal(tmp);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ── flag off: discovery is never triggered, even with 2+ markers present ───

  it("flag off: 2+ markers present but --discover-projects omitted behaves exactly as an ambiguous discovery does today (cwd fallback)", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    makeMarkerDir(tmp, "game-a");
    makeMarkerDir(tmp, "game-b");
    try {
      const logs: string[] = [];
      const registry = await buildProjectRegistry(undefined, undefined, undefined, {
        log: (m) => logs.push(m),
        env: { ...process.env, C3_PROJECT_DIR: undefined } as unknown as NodeJS.ProcessEnv,
        // discoverProjects intentionally omitted
      });

      expect(registry.list()).to.have.lengthOf(1);
      expect(registry.list()[0].root).to.equal(tmp);
      expect(logs.some((l) => l.includes("ambiguous root") && l.includes("falling back to cwd"))).to.equal(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
