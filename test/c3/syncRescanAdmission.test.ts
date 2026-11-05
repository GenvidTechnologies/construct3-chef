import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  runSync,
  syncFileFolder,
  FILE_SECTIONS,
  type Change,
  type FileFolder,
  type FileItem,
  type FileSectionConfig,
} from "../../src/c3/projectSync.js";

// Each row runs against a temp directory or a temp COPY of the canonical fixture, never the fixture itself.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

describe("sync rescan admission", function () {
  this.timeout(120_000);

  const dirs: string[] = [];

  function tempDir(): string {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-cs41-"));
    dirs.push(root);
    return root;
  }

  function copy(): string {
    const root = tempDir();
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return root;
  }

  function seedFile(root: string, rel: string, content = "x"): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const configOf = (key: string): FileSectionConfig => {
    const found = FILE_SECTIONS.find((s) => s.key === key);
    if (!found) throw new Error(`no FILE_SECTIONS entry for ${key}`);
    return found;
  };

  const item = (name: string, sid: number): FileItem => ({
    name,
    type: "application/octet-stream",
    sid,
    "file-info": { purpose: "none" },
  });

  /** A manifest folder listing the given section-relative paths (`sub/s.ts` goes into a `sub` subfolder). */
  function listing(paths: string[]): FileFolder {
    const root: FileFolder = { items: [], subfolders: [] };
    let sid = 400000000000000;
    for (const p of paths) {
      const segs = p.split("/");
      const name = segs.pop() as string;
      let folder = root;
      for (const seg of segs) {
        let next = folder.subfolders.find((s) => s.name === seg);
        if (!next) {
          next = { name: seg, items: [], subfolders: [] };
          folder.subfolders.push(next);
        }
        folder = next;
      }
      folder.items.push(item(name, sid++));
    }
    return root;
  }

  /** Section-relative paths of every item in `folder`. */
  function members(folder: FileFolder, prefix = ""): string[] {
    return [
      ...folder.items.map((i) => prefix + i.name),
      ...folder.subfolders.flatMap((s) => members(s, `${prefix}${s.name}/`)),
    ];
  }

  interface SectionRun {
    key: string;
    listed: string[];
    disk: string[];
    withhold?: boolean;
    config?: FileSectionConfig;
  }

  /** `syncFileFolder` on a fresh temp directory holding `disk`; returns the folder after the sync and the changes. */
  function runSection(run: SectionRun): { folder: FileFolder; changes: Change[]; added: string[] } {
    const dir = tempDir();
    for (const rel of run.disk) seedFile(dir, rel);
    const folder = listing(run.listed);
    const changes: Change[] = [];
    syncFileFolder(
      folder,
      dir,
      "",
      run.config ?? configOf(run.key),
      new Set<number>(),
      changes,
      false,
      run.withhold ? { withhold: true } : undefined,
    );
    const added = changes
      .filter((c) => c.action === "+")
      .map((c) => c.detail.replace(/ \(new, sid=\d+\)$/, ""))
      .sort();
    return { folder, changes, added };
  }

  const BOTH = ["script", "general"];

  it("CS41-S1: runSync lists the admitted and omits the refused file in each section's disk folder", () => {
    const root = copy();
    const put: Array<[string, string]> = [
      ["script", "cs41.js"],
      ["script", "cs41.txt"],
      ["sound", "cs41.wav"],
      ["sound", "cs41.txt"],
      ["music", "cs41.mp3"],
      ["music", "cs41.png"],
      ["video", "cs41.mp4"],
      ["video", "cs41.txt"],
      ["font", "cs41.woff2"],
      ["font", "cs41.ttf"],
      ["font", "cs41.png"],
      ["icon", "cs41.jpg"],
      ["icon", "cs41.ogg"],
      ["general", "cs41.txt"],
      ["general", "data.json"],
    ];
    for (const [key, name] of put) seedFile(root, `${configOf(key).diskDir}/${name}`);
    runSync(root, false, () => {});
    const manifest = JSON.parse(readFileSync(path.join(root, "project.c3proj"), "utf8"));
    const actual: Record<string, boolean> = {};
    const expected: Record<string, boolean> = {};
    const admitted = new Set([
      "script/cs41.js",
      "sound/cs41.wav",
      "music/cs41.mp3",
      "video/cs41.mp4",
      "font/cs41.woff2",
      "font/cs41.ttf",
      "icon/cs41.jpg",
      "general/cs41.txt",
    ]);
    for (const [key, name] of put) {
      actual[`${key}/${name}`] = members(manifest.rootFileFolders[key]).includes(name);
      expected[`${key}/${name}`] = admitted.has(`${key}/${name}`);
    }
    expect(actual).to.deep.equal(expected);
  });

  it("CS41-S2: a listed .ts blocks only its own .js; an unlisted .ts blocks it in script and not in general", () => {
    const actual: Record<string, Record<string, boolean>> = {};
    for (const key of BOTH) {
      const { folder } = runSection({
        key,
        listed: ["l.ts"],
        disk: ["l.ts", "l.js", "n.ts", "n.js", "solo.js"],
      });
      const m = members(folder);
      actual[key] = {
        lJs: m.includes("l.js"),
        nTs: m.includes("n.ts"),
        nJs: m.includes("n.js"),
        soloJs: m.includes("solo.js"),
      };
    }
    expect(actual).to.deep.equal({
      script: { lJs: false, nTs: true, nJs: false, soloJs: true },
      general: { lJs: false, nTs: true, nJs: true, soloJs: true },
    });
  });

  it("CS41-S3: a twin blocks the .js only at its own level", () => {
    const actual: Record<string, Record<string, boolean>> = {};
    for (const key of BOTH) {
      const { folder } = runSection({
        key,
        listed: ["sub/s.ts", "x.ts"],
        disk: ["sub/s.ts", "sub/s.js", "x.ts", "sub/x.js"],
      });
      const m = members(folder);
      actual[key] = { subSJs: m.includes("sub/s.js"), subXJs: m.includes("sub/x.js") };
    }
    expect(actual).to.deep.equal({
      script: { subSJs: false, subXJs: true },
      general: { subSJs: false, subXJs: true },
    });
  });

  it("CS41-S4: a twin matches ignoring letter case and Unicode form, and not a different stem", () => {
    const nfd = "e" + String.fromCharCode(0x301);
    const nfc = String.fromCharCode(0xe9);
    expect(nfd).to.not.equal(nfc);
    const actual: Record<string, Record<string, boolean>> = {};
    for (const key of BOTH) {
      const { folder } = runSection({
        key,
        listed: ["Case.ts", `${nfd}.ts`, "ABD.ts"],
        disk: ["Case.ts", `${nfd}.ts`, "ABD.ts", "case.js", `${nfc}.js`, "abc.js"],
      });
      const m = members(folder);
      actual[key] = { caseJs: m.includes("case.js"), nfcJs: m.includes(`${nfc}.js`), abcJs: m.includes("abc.js") };
    }
    expect(actual).to.deep.equal({
      script: { caseJs: false, nfcJs: false, abcJs: true },
      general: { caseJs: false, nfcJs: false, abcJs: true },
    });
  });

  it("CS41-S5: a listed .ts that is missing on disk does not block its .js", () => {
    const actual: Record<string, Record<string, boolean>> = {};
    for (const key of BOTH) {
      const { folder } = runSection({ key, listed: ["gone.ts"], disk: ["gone.js"], withhold: true });
      actual[key] = { goneJs: members(folder).includes("gone.js") };
    }
    expect(actual).to.deep.equal({ script: { goneJs: true }, general: { goneJs: true } });
  });

  it("CS41-S6: runSync in general: a listed .ts blocks its .js, an unlisted pair adds both", () => {
    const root = copy();
    const manifestPath = path.join(root, "project.c3proj");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.rootFileFolders.general.items.push(item("cs41-l.ts", 411111111111111));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
    for (const name of ["cs41-l.ts", "cs41-l.js", "cs41-u.ts", "cs41-u.js"]) seedFile(root, `files/${name}`);
    runSync(root, false, () => {});
    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    const m = members(after.rootFileFolders.general);
    expect({ lJs: m.includes("cs41-l.js"), uTs: m.includes("cs41-u.ts"), uJs: m.includes("cs41-u.js") }).to.deep.equal({
      lJs: false,
      uTs: true,
      uJs: true,
    });
  });

  it("CS41-S7: an unknown section key gets the name check only and does not throw", () => {
    const actual: Record<string, string[]> = {};
    for (const key of ["custom", "toString"]) {
      const config: FileSectionConfig = { key, diskDir: "x", infoKey: "file-info" };
      actual[key] = runSection({ key, listed: [], disk: ["a.js", "a.ts", "index.html", "a~b.txt"], config }).added;
    }
    expect(actual).to.deep.equal({
      custom: ["a.js", "a.ts", "index.html"],
      toString: ["a.js", "a.ts", "index.html"],
    });
  });

  it("CS41-S8: extensions narrowing also gates the same-sync twin", () => {
    const script = configOf("script");
    const tsOnly = runSection({
      key: "script",
      listed: [],
      disk: ["a.js", "b.ts"],
      config: { ...script, extensions: [".ts"] },
    }).added;
    const jsOnly = runSection({
      key: "script",
      listed: [],
      disk: ["t.ts", "t.js"],
      config: { ...script, extensions: [".js"] },
    }).added;
    expect({ tsOnly, jsOnly }).to.deep.equal({ tsOnly: ["b.ts"], jsOnly: ["t.js"] });
  });

  it("CS41-S10: a listed folder the rescan rule would refuse stays listed; an unlisted one is not added", () => {
    const root = copy();
    const manifestPath = path.join(root, "project.c3proj");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.rootFileFolders.general.subfolders.push({
      name: ".hidden",
      items: [item("ok.txt", 422222222222222)],
      subfolders: [],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
    seedFile(root, "files/.hidden/ok.txt");
    seedFile(root, "files/.other/z.txt");
    seedFile(root, "files/Visible/v.txt");
    runSync(root, false, () => {}, undefined, { prune: true });
    const m = members(JSON.parse(readFileSync(manifestPath, "utf8")).rootFileFolders.general);
    expect({
      hiddenFile: m.includes(".hidden/ok.txt"),
      otherFile: m.includes(".other/z.txt"),
      visibleFile: m.includes("Visible/v.txt"),
    }).to.deep.equal({ hiddenFile: true, otherFile: false, visibleFile: true });
  });
});
