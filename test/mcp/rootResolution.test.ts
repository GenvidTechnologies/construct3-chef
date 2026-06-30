import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRootFolder, isMcpError } from "@genvidtech/mcp-utils";

// ── Dirent fake helpers ───────────────────────────────────────────────────────
// We build the fakeReaddir on top of real temp dirs so that path.join /
// path.resolve produce the same strings on Windows and POSIX.

function makeDirDirent(name: string): fs.Dirent {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  } as unknown as fs.Dirent;
}

function makeFileDirent(name: string): fs.Dirent {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    parentPath: "",
    path: "",
  } as unknown as fs.Dirent;
}

// ── Seam-based precedence tests ──────────────────────────────────────────────
// Uses real temp dirs for `cwd` / child paths so that path.join / path.resolve
// produce the same strings on Windows and POSIX — avoids POSIX-literal path
// comparison failures on Windows (e.g. "/proj" → "C:\proj").

describe("resolveRootFolder precedence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-rrf-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── R1: discovery via single child ─────────────────────────────────────────

  it("R1: discovers the single child that contains the marker", () => {
    const child = path.join(tmp, "game");

    // fakeReaddir: cwd (tmp) lists one directory child;
    // that child's entries include the marker file.
    const fakeReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      if (dir === tmp) return [makeDirDirent("game")];
      if (dir === child) return [makeFileDirent("project.c3proj")];
      return [];
    };

    const result = resolveRootFolder({ marker: "project.c3proj", searchDepth: 1, cwd: tmp }, {}, fakeReaddir);

    expect(isMcpError(result)).to.be.false;
    if (isMcpError(result)) return;
    expect(result.source).to.equal("discovery");
    expect(result.path).to.equal(child);
  });

  // ── R2: explicit wins over everything ──────────────────────────────────────

  it("R2: explicit path wins over env var and discovery", () => {
    const child = path.join(tmp, "game");
    const explicitPath = path.join(tmp, "explicit");
    const envPath = path.join(tmp, "env");

    const fakeReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      if (dir === tmp) return [makeDirDirent("game")];
      if (dir === child) return [makeFileDirent("project.c3proj")];
      return [];
    };

    const result = resolveRootFolder(
      { explicit: explicitPath, envVar: "C3_PROJECT_DIR", marker: "project.c3proj", searchDepth: 1, cwd: tmp },
      { C3_PROJECT_DIR: envPath },
      fakeReaddir,
    );

    expect(isMcpError(result)).to.be.false;
    if (isMcpError(result)) return;
    expect(result.source).to.equal("explicit");
    expect(result.path).to.equal(explicitPath);
  });

  // ── R3: env wins over discovery ────────────────────────────────────────────

  it("R3: env var wins over discovery when no explicit is given", () => {
    const child = path.join(tmp, "game");
    const envPath = path.join(tmp, "env");

    const fakeReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      if (dir === tmp) return [makeDirDirent("game")];
      if (dir === child) return [makeFileDirent("project.c3proj")];
      return [];
    };

    const result = resolveRootFolder(
      { envVar: "C3_PROJECT_DIR", marker: "project.c3proj", searchDepth: 1, cwd: tmp },
      { C3_PROJECT_DIR: envPath },
      fakeReaddir,
    );

    expect(isMcpError(result)).to.be.false;
    if (isMcpError(result)) return;
    expect(result.source).to.equal("env");
    expect(result.path).to.equal(envPath);
  });

  // ── R4: ambiguous (two children each contain the marker) ───────────────────

  it("R4: returns mcpError when two children both contain the marker", () => {
    const child1 = path.join(tmp, "game1");
    const child2 = path.join(tmp, "game2");

    const fakeReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      if (dir === tmp) return [makeDirDirent("game1"), makeDirDirent("game2")];
      if (dir === child1) return [makeFileDirent("project.c3proj")];
      if (dir === child2) return [makeFileDirent("project.c3proj")];
      return [];
    };

    const result = resolveRootFolder({ marker: "project.c3proj", searchDepth: 1, cwd: tmp }, {}, fakeReaddir);

    expect(isMcpError(result)).to.be.true;
  });

  // ── R5: no marker found → falls back to cwd ────────────────────────────────

  it("R5: falls back to cwd when no marker is found anywhere", () => {
    const fakeReaddir = (dir: string, _opts: { withFileTypes: true }): fs.Dirent[] => {
      if (dir === tmp) return [makeDirDirent("child")];
      // child has no project.c3proj
      return [];
    };

    const result = resolveRootFolder({ marker: "project.c3proj", searchDepth: 1, cwd: tmp }, {}, fakeReaddir);

    expect(isMcpError(result)).to.be.false;
    if (isMcpError(result)) return;
    expect(result.source).to.equal("cwd");
    expect(result.path).to.equal(tmp);
  });
});

// ── Integration: real-filesystem discovery and explicit resolution ────────────
// Validates the wiring end-to-end against real temp dirs (no fakeReaddir).
// startServer is NOT invoked here because its StdioServerTransport.connect()
// would block the test process; the seam-based R1-R5 tests above cover the
// resolution logic, and the integration suite below confirms the same behaviour
// when resolveRootFolder reads real directory entries.

describe("resolveRootFolder integration with server test seams", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-rootres-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("explicit path resolves to the given directory", () => {
    // Create a fake project.c3proj inside tmp so it looks like a real project
    fs.writeFileSync(path.join(tmp, "project.c3proj"), "{}");

    const result = resolveRootFolder({
      explicit: tmp,
      envVar: "C3_PROJECT_DIR",
      marker: "project.c3proj",
      searchDepth: 1,
    });

    expect(isMcpError(result)).to.be.false;
    if (isMcpError(result)) return;
    expect(result.source).to.equal("explicit");
    expect(result.path).to.equal(tmp);
  });

  it("discovery picks a single child directory containing project.c3proj", () => {
    // Create a subdirectory with a project.c3proj file
    const childDir = path.join(tmp, "mygame");
    fs.mkdirSync(childDir);
    fs.writeFileSync(path.join(childDir, "project.c3proj"), "{}");

    const result = resolveRootFolder({
      marker: "project.c3proj",
      searchDepth: 1,
      cwd: tmp,
    });

    expect(isMcpError(result)).to.be.false;
    if (isMcpError(result)) return;
    expect(result.source).to.equal("discovery");
    // path.resolve normalizes both to compare safely across platforms
    expect(path.resolve(result.path)).to.equal(path.resolve(childDir));
  });
});
