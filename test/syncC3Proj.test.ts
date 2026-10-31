import { describe, it, beforeEach, afterEach } from "mocha";
import { assert } from "chai";
import tmp from "tmp";
import { mkdirSync, writeFileSync, readFileSync, cpSync, utimesSync, statSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenario, cleanupScenarios } from "./helpers/syncScenarios.js";
import { runCli } from "./helpers/runCli.js";
import {
  detectManifestDrift,
  detectImageDrift,
  deriveExpectedImageNames,
  readProjectManifest,
  serializeProjectManifest,
  type DriftEntry,
} from "@genvidtech/c3source";
import {
  inferMimeType,
  collectAllSids,
  generateSid,
  readDiskDir,
  syncFileFolder,
  applyNameDrift,
  reportImageDrift,
  runSync,
  type FileItem,
  type FileFolder,
  type NameFolder,
  type FileSectionConfig,
  type Change,
} from "../src/c3/projectSync.js";

const sampleProjectDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "construct3-chef-sample");

// Helper to create a temp directory
function createTmpDir(): string {
  return tmp.dirSync({ unsafeCleanup: true }).name;
}

// Helper to create a file in a directory
function touchFile(dir: string, ...parts: string[]): void {
  const filePath = path.join(dir, ...parts);
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, "");
}

describe("syncC3Proj", () => {
  describe("inferMimeType", () => {
    it("returns correct MIME for .ts", () => {
      assert.equal(inferMimeType("main.ts"), "application/typescript");
    });

    it("returns correct MIME for .webm", () => {
      assert.equal(inferMimeType("sound.webm"), "audio/webm; codecs=opus");
    });

    it("returns correct MIME for .png", () => {
      assert.equal(inferMimeType("icon.png"), "image/png");
    });

    it("returns correct MIME for .json", () => {
      assert.equal(inferMimeType("data.json"), "application/json");
    });

    it("returns correct MIME for .html", () => {
      assert.equal(inferMimeType("page.html"), "text/html");
    });

    it("returns correct MIME for .css", () => {
      assert.equal(inferMimeType("styles.css"), "text/css");
    });

    it("returns correct MIME for .xml", () => {
      assert.equal(inferMimeType("config.xml"), "text/xml");
    });

    // #236: the editor records application/octet-stream for a .plist, not the
    // text/xml chef's old local table wrote.
    it("returns application/octet-stream for .plist", () => {
      assert.equal(inferMimeType("Info.plist"), "application/octet-stream");
    });

    // #236: values measured in C3 r49502 (construct3-sample#4) and owned upstream
    // by c3source's EXTENSION_FILE_TYPES.
    it("returns image/jpeg for .jpg", () => {
      assert.equal(inferMimeType("photo.jpg"), "image/jpeg");
    });

    it("returns image/jpeg for .jpeg", () => {
      assert.equal(inferMimeType("photo.jpeg"), "image/jpeg");
    });

    it("returns image/webp for .webp", () => {
      assert.equal(inferMimeType("photo.webp"), "image/webp");
    });

    it("returns image/gif for .gif", () => {
      assert.equal(inferMimeType("anim.gif"), "image/gif");
    });

    it("returns image/svg+xml for .svg", () => {
      assert.equal(inferMimeType("logo.svg"), "image/svg+xml");
    });

    it("returns video/mp4 for .mp4", () => {
      assert.equal(inferMimeType("clip.mp4"), "video/mp4");
    });

    it("returns audio/mpeg for .mp3", () => {
      assert.equal(inferMimeType("track.mp3"), "audio/mpeg");
    });

    it("returns audio/mp4 for .m4a", () => {
      assert.equal(inferMimeType("track.m4a"), "audio/mp4");
    });

    it("returns application/javascript for .js", () => {
      assert.equal(inferMimeType("main.js"), "application/javascript");
    });

    it("is case-insensitive on the extension", () => {
      assert.equal(inferMimeType("PHOTO.JPG"), "image/jpeg");
    });

    it("returns correct MIME for .ttf", () => {
      assert.equal(inferMimeType("font.ttf"), "application/font-sfnt");
    });

    it("returns correct MIME for .txt", () => {
      assert.equal(inferMimeType("readme.txt"), "text/plain");
    });

    it("returns octet-stream for unknown extension", () => {
      assert.equal(inferMimeType("file.xyz"), "application/octet-stream");
    });

    // #236 R11: the fixture's project.c3proj was written by the C3 editor, so every
    // `files/` entry's recorded type is ground truth for what inferMimeType must
    // produce. The floor stops this passing on an empty or shrunken entry set.
    it("matches the editor-recorded type of every files/ entry in the fixture", () => {
      const manifest = readProjectManifest(path.join(sampleProjectDir, "project.c3proj"));
      const entries: FileItem[] = [];
      const walk = (folder: FileFolder): void => {
        entries.push(...folder.items);
        for (const sub of folder.subfolders) walk(sub);
      };
      walk(manifest.rootFileFolders.general as FileFolder);

      assert.isAtLeast(entries.length, 9);
      for (const entry of entries) {
        assert.equal(inferMimeType(entry.name), entry.type, entry.name);
      }
    });
  });

  describe("collectAllSids", () => {
    it("collects SIDs from nested file-based sections", () => {
      const project = {
        rootFileFolders: {
          script: {
            items: [{ name: "a.ts", type: "application/typescript", sid: 111, "script-info": { purpose: "none" } }],
            subfolders: [
              {
                items: [{ name: "b.ts", type: "application/typescript", sid: 222, "script-info": { purpose: "none" } }],
                subfolders: [],
                name: "sub",
              },
            ],
          },
          sound: {
            items: [{ name: "c.webm", type: "audio/webm; codecs=opus", sid: 333, "file-info": { purpose: "none" } }],
            subfolders: [],
          },
        },
      };
      const sids = collectAllSids(project);
      assert.isTrue(sids.has(111));
      assert.isTrue(sids.has(222));
      assert.isTrue(sids.has(333));
      assert.equal(sids.size, 3);
    });

    it("returns empty set when no rootFileFolders", () => {
      const sids = collectAllSids({});
      assert.equal(sids.size, 0);
    });
  });

  describe("generateSid", () => {
    it("generates a 15-digit number", () => {
      const sids = new Set<number>();
      const sid = generateSid(sids);
      assert.isAtLeast(sid, 100000000000000);
      assert.isAtMost(sid, 999999999999999);
    });

    it("avoids collisions with existing SIDs", () => {
      const sids = new Set<number>();
      const first = generateSid(sids);
      assert.isTrue(sids.has(first));
      const second = generateSid(sids);
      assert.notEqual(first, second);
      assert.isTrue(sids.has(second));
    });
  });

  describe("readDiskDir", () => {
    it("reads files filtered by extension", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.ts");
      touchFile(dir, "b.ts");
      touchFile(dir, "c.js");
      const result = readDiskDir(dir, [".ts"], undefined, undefined);
      assert.deepEqual(result.files.sort(), ["a.ts", "b.ts"]);
      assert.deepEqual(result.dirs, []);
    });

    it("reads all files when no extension filter", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.json");
      touchFile(dir, "b.html");
      touchFile(dir, "c.png");
      const result = readDiskDir(dir, undefined, undefined, undefined);
      assert.equal(result.files.length, 3);
    });

    it("ignores specified files", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.ts");
      touchFile(dir, "tsconfig.json");
      const result = readDiskDir(dir, [".ts"], ["tsconfig.json"], undefined);
      assert.deepEqual(result.files, ["a.ts"]);
    });

    it("ignores specified directories", () => {
      const dir = createTmpDir();
      touchFile(dir, "a.ts");
      mkdirSync(path.join(dir, "ts-defs"));
      mkdirSync(path.join(dir, "shared"));
      const result = readDiskDir(dir, [".ts"], undefined, ["ts-defs"]);
      assert.deepEqual(result.dirs, ["shared"]);
    });

    it("returns empty for non-existent directory", () => {
      const result = readDiskDir("/nonexistent/path", undefined, undefined, undefined);
      assert.deepEqual(result, { files: [], dirs: [] });
    });
  });

  describe("runSync error contract", () => {
    it("throws 'Could not read' when project.c3proj is missing", () => {
      const dir = createTmpDir();
      assert.throws(() => runSync(dir, true), /Could not read/);
    });

    it("throws 'Could not parse' on malformed JSON", () => {
      const dir = createTmpDir();
      writeFileSync(path.join(dir, "project.c3proj"), "{ not valid json");
      assert.throws(() => runSync(dir, true), /Could not parse/);
    });

    it("throws 'Could not parse' on a structurally-invalid manifest (valid JSON, missing fields)", () => {
      // Valid JSON but not a well-formed manifest (no name/runtime/...). Before the
      // readProjectManifest adoption this slipped through; it now fails fast.
      const dir = createTmpDir();
      writeFileSync(path.join(dir, "project.c3proj"), JSON.stringify({ foo: "bar" }));
      assert.throws(() => runSync(dir, true), /Could not parse/);
    });
  });

  describe("oracle — detectManifestDrift on construct3-chef-sample", () => {
    // Cross-check our sync against c3source's upstream drift detector for the
    // sections it models the same way we do (the name-folder sections). The file
    // sections (rootFileFolders.*) are deliberately excluded: c3source walks them
    // shallowly and unfiltered, so scripts/*.ts + tsconfig.json would read as drift.
    const NAME_FOLDER_SECTIONS = new Set([
      "layouts",
      "eventSheets",
      "objectTypes",
      "timelines",
      "flowcharts",
      "families",
    ]);

    it("reports no drift on the name-folder sections", () => {
      const drift = detectManifestDrift(sampleProjectDir);
      const nameSections = drift.sections.filter((s) => NAME_FOLDER_SECTIONS.has(s.section));
      for (const s of nameSections) {
        assert.deepEqual(s.entries, [], `${s.section}: unexpected drift`);
      }
    });

    it("covers objectTypes-as-directories without drift", () => {
      // The fixture stores objectTypes in named subfolders (global/images/tiles).
      // Confirm detectManifestDrift resolves that layout without reporting drift.
      const drift = detectManifestDrift(sampleProjectDir);
      const ot = drift.sections.find((s) => s.section === "objectTypes");
      // If the section is in-sync it may be omitted entirely, or present with no entries.
      assert.deepEqual(ot?.entries ?? [], [], "objectTypes: unexpected drift");
    });
  });

  describe("oracle — detectImageDrift on construct3-chef-sample", () => {
    it("returns the images section with no drift entries", () => {
      const drift = detectImageDrift(sampleProjectDir);
      assert.equal(drift?.section, "images");
      assert.deepEqual(drift?.entries ?? [], [], "images: unexpected drift");
    });

    // #63: a non-PNG image member must resolve its on-disk extension from `fileType`
    // (MIME), not an assumed `.png`. The fixture's JPEGTileBackground is JPEG-backed
    // (images/jpegtilebackground.jpg); pre-1.3.0 this produced a false `jpegtilebackground.png
    // missing` + `jpegtilebackground.jpg untracked` pair. This pins the fix and keeps the
    // fixture's non-PNG coverage from silently regressing to all-PNG.
    it("resolves a JPEG member to its real .jpg extension, not assumed .png (#63)", () => {
      const jtb = JSON.parse(
        readFileSync(path.join(sampleProjectDir, "objectTypes", "tiles", "JPEGTileBackground.json"), "utf-8"),
      );
      assert.equal(jtb.image.fileType, "image/jpeg", "fixture must keep a non-PNG member for #63 coverage");
      assert.deepEqual(
        deriveExpectedImageNames(jtb),
        ["jpegtilebackground.jpg"],
        "expected name must derive from fileType, not assume .png",
      );
      const drift = detectImageDrift(sampleProjectDir);
      assert.deepEqual(drift?.entries ?? [], [], "no false missing/untracked pair for the jpeg asset");
    });

    // sync-project now also surfaces this line (#52), so pin reportImageDrift's
    // rendered no-drift output, not just detectImageDrift's data.
    it("reportImageDrift emits a single (no drift) line on the clean fixture", () => {
      const lines: string[] = [];
      reportImageDrift(sampleProjectDir, (m) => lines.push(m));
      assert.lengthOf(lines, 1);
      assert.match(lines[0], /^\[images\]\s+\(no drift\)$/);
    });
  });

  describe("reportImageDrift error guard", () => {
    // c3source THROWS on an image `fileType` it cannot map to an on-disk extension (#63).
    // reportImageDrift calls detectImageDrift directly, and upstream documents that the
    // throw PROPAGATES there (only detectManifestDrift catches it into `degraded`), so the
    // guard must catch and report rather than crash validate-project.
    //
    // The trigger is an UNMAPPED fileType, not an absent one. c3source 1.9.0 (their #68)
    // narrowed the throw: pre-r402 C3 serializes image nodes with no `fileType` at all and
    // the on-disk file is still a real image, so absent is now tolerated (resolved by
    // on-disk stem match, else the legacy .png) and only an unrecognized MIME throws.
    it("reports an error line instead of throwing on an unmapped fileType", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "images"), { recursive: true });
      writeFileSync(path.join(dir, "images", "foo.png"), "");
      mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
      // image member with an unrecognized fileType -> extensionForFileTypeOrUndefined throws.
      writeFileSync(
        path.join(dir, "objectTypes", "Foo.json"),
        JSON.stringify({ name: "Foo", image: { width: 1, height: 1, fileType: "image/bmp" } }),
      );
      const lines: string[] = [];
      assert.doesNotThrow(() => reportImageDrift(dir, (m) => lines.push(m)));
      assert.lengthOf(lines, 1);
      assert.match(lines[0], /^\[images\]\s+error: /, "expected a single [images] error: line");
      assert.include(lines[0], "Foo");
    });
  });

  describe("timelines transitions (nameless) subfolder", () => {
    // #62: the fixture's `timelines` tree mixes the awkward cases C3 produces —
    //   items: ["Timeline 1"]
    //   subfolders:
    //     - NAMELESS subfolder (C3's serialization of the on-disk `timelines/transitions/`
    //       dir, "Eases" in the editor): items ["Matt's Ease"], itself nesting a NAMED
    //       subfolder "Others" (disk `transitions/Others/`) with ["Matt's Ease2"]
    //     - NAMED subfolder "Mixing" (disk `timelines/Mixing/`) with ["Timeline 2"]
    // so a named subfolder sits both inside the nameless one and beside it. runSync must
    // report ZERO changes. Before c3source 1.3.0 (#28) the manifest walk gave the nameless
    // subfolder no path segment while disk yielded `transitions`, so sync reported a false
    // `transitions/ (new folder)` add and "corrected" it by appending a NAMED `"transitions"`
    // subfolder — duplicating the item. This pins the fixed round-trip: no spurious folder,
    // no item duplication.
    it("reports no changes syncing the populated transitions subfolder", () => {
      const result = runSync(sampleProjectDir, true, () => {}, "timelines");
      assert.deepEqual(result.changes, [], "timelines: unexpected changes");
      assert.equal(result.clean, true);
      // Explicit anti-corruption guard: no change may re-introduce a named `transitions` folder.
      assert.isUndefined(
        result.changes.find((c) => /transitions/i.test(c.detail)),
        "sync must not emit a transitions folder change",
      );
    });
  });

  describe("syncFileFolder", () => {
    it("detects new files on disk", () => {
      const dir = createTmpDir();
      touchFile(dir, "new.ts");

      const folder: FileFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "+");
      assert.include(changes[0].detail, "new.ts");
      assert.equal(folder.items.length, 1);
      assert.equal(folder.items[0].name, "new.ts");
      assert.equal(folder.items[0].type, "application/typescript");
      assert.isAbove(folder.items[0].sid, 0);
    });

    it("detects removed files (in project but not on disk)", () => {
      const dir = createTmpDir();
      // Empty dir — nothing on disk

      const folder: FileFolder = {
        items: [{ name: "old.ts", type: "application/typescript", sid: 12345, "script-info": { purpose: "none" } }],
        subfolders: [],
      };
      const changes: Change[] = [];
      const sids = new Set<number>([12345]);
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.include(changes[0].detail, "old.ts");
      assert.equal(folder.items.length, 0);
    });

    it("preserves existing items that match disk", () => {
      const dir = createTmpDir();
      touchFile(dir, "existing.ts");

      const existingItem: FileItem = {
        name: "existing.ts",
        type: "application/typescript",
        sid: 99999,
        "script-info": { purpose: "main" },
      };
      const folder: FileFolder = { items: [existingItem], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>([99999]);
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 0);
      assert.equal(folder.items.length, 1);
      assert.equal(folder.items[0].sid, 99999);
      assert.equal(folder.items[0]["script-info"].purpose, "main");
    });

    it("detects new subfolders on disk", () => {
      const dir = createTmpDir();
      mkdirSync(path.join(dir, "newFolder"));
      touchFile(dir, "newFolder", "file.ts");

      const folder: FileFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.isTrue(changes.some((c) => c.action === "+" && c.detail.includes("newFolder/")));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail.includes("file.ts")));
      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "newFolder");
    });

    it("handles deeply nested subfolders", () => {
      const dir = createTmpDir();
      touchFile(dir, "Auth", "Login", "util.ts");

      const folder: FileFolder = { items: [], subfolders: [] };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "Auth");
      assert.equal(folder.subfolders[0].subfolders.length, 1);
      assert.equal(folder.subfolders[0].subfolders[0].name, "Login");
      assert.equal(folder.subfolders[0].subfolders[0].items[0].name, "util.ts");
    });

    it("detects removed subfolders", () => {
      const dir = createTmpDir();
      // Empty dir — no subfolders

      const folder: FileFolder = {
        items: [],
        subfolders: [{ items: [], subfolders: [], name: "oldFolder" }],
      };
      const changes: Change[] = [];
      const sids = new Set<number>();
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, false);

      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.include(changes[0].detail, "oldFolder/");
      assert.equal(folder.subfolders.length, 0);
    });

    it("dry-run does not modify folder", () => {
      const dir = createTmpDir();
      touchFile(dir, "new.ts");

      const folder: FileFolder = {
        items: [{ name: "old.ts", type: "application/typescript", sid: 111, "script-info": { purpose: "none" } }],
        subfolders: [],
      };
      const changes: Change[] = [];
      const sids = new Set<number>([111]);
      const config: FileSectionConfig = {
        key: "script",
        diskDir: dir,
        infoKey: "script-info",
        extensions: [".ts"],
      };

      syncFileFolder(folder, dir, "", config, sids, changes, true);

      assert.equal(changes.length, 2); // one add, one remove
      // But folder should be unchanged
      assert.equal(folder.items.length, 1);
      assert.equal(folder.items[0].name, "old.ts");
    });
  });

  describe("applyNameDrift", () => {
    it("untracked item at root: adds it and records a '+' change", () => {
      const folder: NameFolder = { items: [], subfolders: [] };
      const entries: DriftEntry[] = [{ kind: "untracked", name: "NewEvent", diskPath: [] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.items, ["NewEvent"]);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "+");
      assert.equal(changes[0].detail, "NewEvent");
    });

    it("missing item at root: removes it and records a '-' change", () => {
      const folder: NameFolder = { items: ["OldEvent"], subfolders: [] };
      const entries: DriftEntry[] = [{ kind: "missing", name: "OldEvent", manifestPath: [] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.items, []);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, "-");
      assert.equal(changes[0].detail, "OldEvent");
    });

    it("folder-untracked + untracked item inside: creates subfolder with item and two '+' changes", () => {
      const folder: NameFolder = { items: [], subfolders: [] };
      const entries: DriftEntry[] = [
        { kind: "folder-untracked", name: "Login", diskPath: ["Login"] },
        { kind: "untracked", name: "LoginEvents", diskPath: ["Login"] },
      ];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.equal(folder.subfolders.length, 1);
      assert.equal(folder.subfolders[0].name, "Login");
      assert.deepEqual(folder.subfolders[0].items, ["LoginEvents"]);
      assert.equal(changes.length, 2);
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "Login/ (new folder)"));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "Login/LoginEvents"));
    });

    it("moved: emits remove@manifestPath + add@diskPath (two changes)", () => {
      const folder: NameFolder = { items: ["Sheet"], subfolders: [{ items: [], subfolders: [], name: "Sub" }] };
      const entries: DriftEntry[] = [{ kind: "moved", name: "Sheet", manifestPath: [], diskPath: ["Sub"] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      // Sheet removed from root, added to Sub
      assert.deepEqual(folder.items, []);
      assert.equal(folder.subfolders[0].items[0], "Sheet");
      assert.equal(changes.length, 2);
      assert.isTrue(changes.some((c) => c.action === "-" && c.detail === "Sheet"));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "Sub/Sheet"));
    });

    it("dry-run: changes recorded but folder object unmutated", () => {
      const folder: NameFolder = { items: ["OldItem"], subfolders: [] };
      const entries: DriftEntry[] = [
        { kind: "missing", name: "OldItem", manifestPath: [] },
        { kind: "untracked", name: "NewItem", diskPath: [] },
      ];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, true);

      // Changes are recorded
      assert.equal(changes.length, 2);
      assert.isTrue(changes.some((c) => c.action === "-" && c.detail === "OldItem"));
      assert.isTrue(changes.some((c) => c.action === "+" && c.detail === "NewItem"));
      // But folder is unmutated
      assert.deepEqual(folder.items, ["OldItem"]);
      assert.equal(folder.subfolders.length, 0);
    });

    it("folder-missing with a multi-segment path: removes the nested subfolder", () => {
      const folder: NameFolder = {
        items: [],
        subfolders: [
          {
            items: [],
            subfolders: [{ items: [], subfolders: [], name: "Nested" }],
            name: "Sub",
          },
        ],
      };
      const entries: DriftEntry[] = [{ kind: "folder-missing", name: "Nested", manifestPath: ["Sub", "Nested"] }];
      const changes: Change[] = [];

      applyNameDrift(folder, entries, "eventSheets", changes, false);

      assert.deepEqual(folder.subfolders[0].subfolders, []);
      assert.equal(changes.length, 1);
      assert.isTrue(changes.some((c) => c.action === "-" && c.detail === "Sub/Nested/"));
    });
  });

  describe("runSync name-section integration", () => {
    it("full-project dry-run on fixture: name sections report no changes (inSync)", () => {
      const result = runSync(sampleProjectDir, true, () => {}, undefined);
      const nameSectionKeys = ["layouts", "eventSheets", "families", "objectTypes", "timelines", "flowcharts"];
      for (const key of nameSectionKeys) {
        const sectionChanges = result.changes.filter((c) => c.section === key);
        assert.deepEqual(sectionChanges, [], `${key}: unexpected changes`);
      }
      assert.equal(result.clean, true);
    });

    it("R6 section filter: eventSheets untracked item only surfaces when that section is requested", () => {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });
      // Add an untracked eventSheet on disk
      touchFile(tmpDir, "eventSheets", "Untracked.json");

      const layoutsResult = runSync(tmpDir, true, () => {}, "layouts");
      const esInLayouts = layoutsResult.changes.filter((c) => c.section === "eventSheets");
      assert.deepEqual(esInLayouts, [], "layouts-only run should not report eventSheets drift");

      const esResult = runSync(tmpDir, true, () => {}, "eventSheets");
      const esChanges = esResult.changes.filter((c) => c.section === "eventSheets");
      assert.isTrue(
        esChanges.some((c) => c.action === "+" && c.detail.includes("Untracked")),
        "eventSheets-only run should report Untracked as untracked",
      );
    });

    it("R8 non-name-section exclusion: images-only drift does not produce name-section changes", () => {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });
      // Add an unreferenced image on disk (images/ drift is detection-only, not a sync target)
      touchFile(tmpDir, "images", "orphan.png");

      const result = runSync(tmpDir, true, () => {}, undefined);
      // No change should be emitted for the images section
      const imageChanges = result.changes.filter((c) => c.section === "images");
      assert.deepEqual(imageChanges, [], "images drift should not produce sync changes");
    });
  });

  describe("runSync manifest write (dryRun=false)", () => {
    // R4/R5/R7: the first non-dry-run runSync test. Seeds drift in the REMOVAL
    // direction — a manifest entry naming an eventSheet that does not exist on
    // disk — so runSync deletes it and the write restores the manifest to its
    // pristine (byte-identical) content. The additive direction can't be used
    // for this: an added entry mints a fresh random SID via mintUniqueSid, so
    // the result could never be byte-identical to the pristine fixture.
    it("removes a spurious eventSheets entry and writes project.c3proj byte-identical to pristine", () => {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });

      const manifestPath = path.join(tmpDir, "project.c3proj");
      const pristineText = readFileSync(path.join(sampleProjectDir, "project.c3proj"), "utf-8");

      // Mutate the parsed manifest IN PLACE (never rebuild via spread) and write
      // it back through the same serializer runSync uses, so the only
      // difference from pristine is the one seeded entry.
      const manifest = readProjectManifest(manifestPath);
      manifest.eventSheets.items.push("SpuriousGhostSheet");
      writeFileSync(manifestPath, serializeProjectManifest(manifest));

      const result = runSync(tmpDir, false, () => {});

      assert.isAbove(result.changes.length, 0, "seeding bug: sync reported no changes");
      assert.equal(result.clean, false);

      const writtenText = readFileSync(manifestPath, "utf-8");

      // R5.1: the write is byte-identical to the pristine fixture's project.c3proj.
      assert.equal(writtenText, pristineText);

      // R5.2: no trailing newline — project.c3proj's write form is distinct from
      // the event-sheet/layout `+ "\n"` form (see CLAUDE.md's write-form note).
      assert.isFalse(writtenText.endsWith("\n"));

      // R5.3: pins the equivalence #154 rests on — upstream's serializer still
      // produces exactly what the removed hand-rolled `JSON.stringify(parsed, null,
      // "\t")` produced. It is correlated with R5.1, not independent of it (a
      // serializer divergence breaks both), but it is the row that says WHY: R5.1
      // goes red for any reason at all — a drift-logic change, a seeding bug, a
      // regenerated fixture — whereas this one goes red only when the serializer
      // stops matching the form chef used to own. Keep it: without it, whoever
      // finds R5.1 red has no way to tell an upstream byte-form change from a
      // local regression.
      assert.equal(writtenText, JSON.stringify(readProjectManifest(manifestPath), null, "\t"));
    });

    // RS: the `beforeWrite` hook fires only when runSync actually writes the manifest.
    function seedGhostSheet(): { tmpDir: string; manifestPath: string } {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });
      const manifestPath = path.join(tmpDir, "project.c3proj");
      const manifest = readProjectManifest(manifestPath);
      manifest.eventSheets.items.push("SpuriousGhostSheet");
      writeFileSync(manifestPath, serializeProjectManifest(manifest));
      return { tmpDir, manifestPath };
    }

    it("RS1: drift calls beforeWrite once with the manifest path while its bytes are still unchanged", () => {
      const { tmpDir, manifestPath } = seedGhostSheet();
      const seeded = readFileSync(manifestPath, "utf-8");
      const calls: Array<{ arg: string; bytes: string }> = [];
      runSync(tmpDir, false, () => {}, undefined, {
        beforeWrite: (p) => {
          calls.push({ arg: p, bytes: readFileSync(manifestPath, "utf-8") });
        },
      });
      assert.lengthOf(calls, 1);
      assert.equal(calls[0].arg, path.resolve(manifestPath));
      assert.equal(calls[0].bytes, seeded);
      assert.notEqual(readFileSync(manifestPath, "utf-8"), seeded, "seeding bug: nothing was written");
    });

    it("RS2: zero drift makes no beforeWrite call", () => {
      const tmpDir = createTmpDir();
      cpSync(sampleProjectDir, tmpDir, { recursive: true });
      let calls = 0;
      const result = runSync(tmpDir, false, () => {}, undefined, {
        beforeWrite: () => {
          calls++;
        },
      });
      assert.equal(result.clean, true);
      assert.equal(calls, 0);
    });

    it("RS3: dryRun with drift makes no beforeWrite call", () => {
      const { tmpDir } = seedGhostSheet();
      let calls = 0;
      const result = runSync(tmpDir, true, () => {}, undefined, {
        beforeWrite: () => {
          calls++;
        },
      });
      assert.equal(result.clean, false, "seeding bug: no drift");
      assert.equal(calls, 0);
    });
  });
});

describe("timelines transitions container (#310)", function () {
  // Each test copies the canonical fixture one or more times.
  this.timeout(30_000);
  afterEach(cleanupScenarios);

  const render = (changes: Change[]): string[] => changes.map((c) => `${c.action} ${c.detail}`);

  /** Write-mode sync of one scenario's timelines, then re-read the tree and re-validate with a dry run. */
  function converge(name: Parameters<typeof buildScenario>[0]) {
    const { root, manifestPath } = buildScenario(name);
    const changes = render(runSync(root, false, () => {}, "timelines").changes);
    const timelines = JSON.parse(readFileSync(manifestPath, "utf8")).timelines as NameFolder;
    const revalidate = render(runSync(root, true, () => {}, "timelines").changes);
    return { changes, timelines, revalidate };
  }

  it("I310-R3b: applyNameDrift throws on an unresolvable folder-missing parent, leaving the folder unmutated", () => {
    const folder: NameFolder = { items: [], subfolders: [] };
    const entries: DriftEntry[] = [{ kind: "folder-missing", name: "Nested", manifestPath: ["NonExistent", "Nested"] }];
    const changes: Change[] = [];
    let message = "";
    try {
      applyNameDrift(folder, entries, "eventSheets", changes, false);
    } catch (err) {
      message = (err as Error).message;
    }
    assert.deepEqual(
      { threw: /cannot apply/.test(message), folder, changes },
      { threw: true, folder: { items: [], subfolders: [] }, changes: [] },
    );
  });

  it("I310-R4: write-mode sync of S1, MV_in, NU and NOC leaves 0 named transitions and exactly 1 nameless subfolder", () => {
    const shape = (t: NameFolder) => ({
      named: t.subfolders.filter((s) => s.name === "transitions").length,
      nameless: t.subfolders.filter((s) => s.name === undefined).length,
    });
    const actual = Object.fromEntries(
      (["S1", "MV_in", "NU", "NOC"] as const).map((n) => [n, shape(converge(n).timelines)]),
    );
    const want = { named: 0, nameless: 1 };
    assert.deepEqual(actual, { S1: want, MV_in: want, NU: want, NOC: want });
  });

  it("I310-R5a: S1 adds the file into the empty container", () => {
    assert.deepEqual(converge("S1"), {
      changes: ["+ transitions/Ease"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: ["Ease"], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5b: S2 removes the ghost item from the container", () => {
    assert.deepEqual(converge("S2"), {
      changes: ["- transitions/Ghost"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: [], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5d: MV_in moves the item from the root into the container", () => {
    assert.deepEqual(converge("MV_in"), {
      changes: ["- Ease", "+ transitions/Ease"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: ["Ease"], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5e: MV_out moves the item from the container to the root", () => {
    assert.deepEqual(converge("MV_out"), {
      changes: ["- transitions/Ease", "+ Ease"],
      timelines: { items: ["Timeline 1", "Ease"], subfolders: [{ items: [], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5c: MI keeps the container and removes only the ghost item", () => {
    assert.deepEqual(converge("MI"), {
      changes: ["- transitions/Ghost"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: [], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5g: NFN keeps the container and removes only the empty Others folder", () => {
    assert.deepEqual(converge("NFN"), {
      changes: ["- transitions/Others/"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: [], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R1: F0 dry-run sync reports no timelines changes and is clean", () => {
    const { root } = buildScenario("F0");
    const result = runSync(root, true, () => {});
    assert.deepEqual(
      { timelinesChanges: render(result.changes.filter((c) => c.section === "timelines")), clean: result.clean },
      { timelinesChanges: [], clean: true },
    );
  });

  it("I310-R3: dry-run and write-mode sync report the same change list for every #310 scenario", () => {
    const names = ["F0", "F1", "S1", "S2", "MI", "MV_in", "MV_out", "NF", "NFN", "NU", "NOC"] as const;
    const dry: Record<string, string[]> = {};
    const write: Record<string, string[]> = {};
    for (const n of names) {
      dry[n] = render(runSync(buildScenario(n).root, true, () => {}, "timelines").changes);
      write[n] = render(runSync(buildScenario(n).root, false, () => {}, "timelines").changes);
    }
    assert.deepEqual(dry, write);
  });

  it("I310-C1: validate, sync, validate on F0 exits 0 each time and never rewrites the manifest", () => {
    const { root, manifestPath } = buildScenario("F0");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(manifestPath, past, past);
    const fingerprint = () => ({
      sha: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
      mtimeMs: statSync(manifestPath).mtimeMs,
    });
    const before = fingerprint();
    const v1 = runCli(["validate-project", "--project-dir", root]);
    const s = runCli(["sync-project", "--project-dir", root]);
    const v2 = runCli(["validate-project", "--project-dir", root]);
    const after = fingerprint();
    const noChanges = /^\[timelines\]\s+\(no changes\)$/m;
    assert.deepEqual(
      {
        codes: [v1.exitCode, s.exitCode, v2.exitCode],
        validate1Timelines: noChanges.test(v1.stdout),
        validate2Timelines: noChanges.test(v2.stdout),
        syncHasUpdated: /^Updated/m.test(s.stdout),
        sha256Same: after.sha === before.sha,
        mtimeSame: after.mtimeMs === before.mtimeMs,
      },
      {
        codes: [0, 0, 0],
        validate1Timelines: true,
        validate2Timelines: true,
        syncHasUpdated: false,
        sha256Same: true,
        mtimeSame: true,
      },
    );
  });

  it("I310-R5f: NF removes the empty Others folder from the container", () => {
    assert.deepEqual(converge("NF"), {
      changes: ["- transitions/Others/"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: [], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5h: NU adds Others inside the nameless container", () => {
    assert.deepEqual(converge("NU"), {
      changes: ["+ transitions/Others/ (new folder)"],
      timelines: {
        items: ["Timeline 1"],
        subfolders: [{ items: [], subfolders: [{ items: [], subfolders: [], name: "Others" }] }],
      },
      revalidate: [],
    });
  });

  it("I310-R5i: NOC creates a nameless container at index 0", () => {
    assert.deepEqual(converge("NOC"), {
      changes: ["+ transitions/Ease", "+ transitions/ (new folder)"],
      timelines: { items: ["Timeline 1"], subfolders: [{ items: ["Ease"], subfolders: [] }] },
      revalidate: [],
    });
  });

  it("I310-R5j: items under a nameless eventSheets subfolder are removed and converge", () => {
    const root = createTmpDir();
    cpSync(sampleProjectDir, root, { recursive: true });
    const manifestPath = path.join(root, "project.c3proj");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.eventSheets.subfolders.push({
      items: ["GhostSheet"],
      subfolders: [{ items: ["GhostSheet2"], subfolders: [], name: "DegSub" }],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
    const dry = render(runSync(root, true, () => {}, "eventSheets").changes);
    const changes = render(runSync(root, false, () => {}, "eventSheets").changes);
    const revalidate = render(runSync(root, true, () => {}, "eventSheets").changes);
    assert.deepEqual(
      { dry, changes, revalidate },
      { dry: changes, changes: ["- GhostSheet", "- DegSub/GhostSheet2", "- DegSub/"], revalidate: [] },
    );
  });

  /** Backdate the manifest, write-mode sync it, and report whether anything was written. */
  function writeSyncOutcome(root: string, manifestPath: string) {
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(manifestPath, past, past);
    const bytesBefore = readFileSync(manifestPath);
    const mtimeBefore = statSync(manifestPath).mtimeMs;
    let beforeWrite = 0;
    const lines: string[] = [];
    const result = runSync(root, false, (l) => lines.push(l), undefined, { beforeWrite: () => beforeWrite++ });
    const bytesAfter = readFileSync(manifestPath);
    return {
      beforeWrite,
      updatedLogged: lines.some((l) => l.startsWith("Updated ")),
      bytesSame: bytesAfter.equals(bytesBefore),
      mtimeSame: statSync(manifestPath).mtimeMs === mtimeBefore,
      wrote: result.wrote,
    };
  }

  const NO_WRITE = { beforeWrite: 0, updatedLogged: false, bytesSame: true, mtimeSame: true, wrote: false };

  it("I310-R2: F0 write-mode sync never calls beforeWrite, logs Updated, or touches the manifest", () => {
    const { root, manifestPath } = buildScenario("F0");
    assert.deepEqual(writeSyncOutcome(root, manifestPath), NO_WRITE);
  });

  it("I310-R2b: F0 saved with CRLF gives the R2 outcome and keeps its CRLF bytes", () => {
    const { root, manifestPath } = buildScenario("F0");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/\n/g, "\r\n"));
    const outcome = writeSyncOutcome(root, manifestPath);
    const hasCRLF = readFileSync(manifestPath, "utf8").includes("\r\n");
    assert.deepEqual({ ...outcome, hasCRLF }, { ...NO_WRITE, hasCRLF: true });
  });

  it("I310-R2c: S1 write-mode sync reports wrote true; a dry run of the same input reports false", () => {
    const dryWrote = runSync(buildScenario("S1").root, true, () => {}).wrote;
    const writeWrote = runSync(buildScenario("S1").root, false, () => {}).wrote;
    assert.deepEqual({ dryWrote, writeWrote }, { dryWrote: false, writeWrote: true });
  });
});

describe("repeated names converge under sync (#343)", function () {
  this.timeout(30_000);

  /** Copy the canonical fixture, then let `mutate` edit the parsed eventSheets section of its manifest. */
  function seed(mutate: (eventSheets: NameFolder) => void): { root: string; manifestPath: string } {
    const root = createTmpDir();
    cpSync(sampleProjectDir, root, { recursive: true });
    const manifestPath = path.join(root, "project.c3proj");
    const manifest = readProjectManifest(manifestPath);
    mutate(manifest.eventSheets as NameFolder);
    writeFileSync(manifestPath, serializeProjectManifest(manifest));
    return { root, manifestPath };
  }

  const render = (changes: Change[]): string[] => changes.map((c) => `${c.action} ${c.detail}`);
  const sheetsOf = (manifestPath: string) => JSON.parse(readFileSync(manifestPath, "utf8")).eventSheets as NameFolder;

  it("I343-R3a: a name listed twice in one folder with no file on disk loses both entries in one sync, and a second sync reports no changes", () => {
    const { root, manifestPath } = seed((es) => {
      es.items.push("DupGhost", "DupGhost");
    });
    const first = render(runSync(root, false, () => {}, "eventSheets").changes);
    const after = sheetsOf(manifestPath);
    const second = render(runSync(root, true, () => {}, "eventSheets").changes);
    assert.deepEqual(
      { rootItems: after.items, firstReported: first.length > 0, second },
      { rootItems: [], firstReported: true, second: [] },
    );
  });

  it("I343-R3b: a ghost entry whose name also exists, on disk and in the manifest, in another folder is removed alone in one sync, and a second sync reports no changes", () => {
    const { root, manifestPath } = seed((es) => {
      es.items.push("Event sheet 1");
    });
    const first = render(runSync(root, false, () => {}, "eventSheets").changes);
    const after = sheetsOf(manifestPath);
    const second = render(runSync(root, true, () => {}, "eventSheets").changes);
    assert.deepEqual(
      {
        rootItems: after.items,
        gameplayItems: after.subfolders.find((s) => s.name === "Gameplay")?.items,
        firstReported: first.length > 0,
        second,
      },
      { rootItems: [], gameplayItems: ["Event sheet 1"], firstReported: true, second: [] },
    );
  });

  it("I343-R3c: a name listed twice in one folder whose file exists gets no sync change and keeps both entries", () => {
    const { root, manifestPath } = seed((es) => {
      es.subfolders.find((s) => s.name === "Gameplay")!.items.push("Event sheet 1");
    });
    const first = render(runSync(root, false, () => {}, "eventSheets").changes);
    const after = sheetsOf(manifestPath);
    assert.deepEqual(
      { first, gameplayItems: after.subfolders.find((s) => s.name === "Gameplay")?.items },
      { first: [], gameplayItems: ["Event sheet 1", "Event sheet 1"] },
    );
  });
});

describe("sync-project file-section moves and subfolder contents (#346)", function () {
  this.timeout(30_000);

  const SAMPLE_SID = 542941095423235;

  function copyFixture(): { root: string; manifestPath: string } {
    const root = createTmpDir();
    cpSync(sampleProjectDir, root, { recursive: true });
    return { root, manifestPath: path.join(root, "project.c3proj") };
  }
  const readManifest = (manifestPath: string) => JSON.parse(readFileSync(manifestPath, "utf8"));
  const writeManifest = (manifestPath: string, m: unknown) =>
    writeFileSync(manifestPath, JSON.stringify(m, null, "\t"));
  const general = (m: any): FileFolder => m.rootFileFolders.general;
  const sub = (m: any, name: string): FileFolder | undefined => general(m).subfolders.find((s) => s.name === name);
  const fileItem = (name: string, sid: number): FileItem => ({
    name,
    type: "application/octet-stream",
    sid,
    "file-info": { purpose: "none" },
  });

  it("SR346-R9: a declared subfolder with no directory on disk reports each contained entry and then itself, and write mode removes it", () => {
    const { root, manifestPath } = copyFixture();
    const m = readManifest(manifestPath);
    general(m).subfolders.push({
      name: "sub",
      items: [fileItem("a.gif", 311111111111111), fileItem("b.gif", 322222222222222)],
      subfolders: [],
    });
    writeManifest(manifestPath, m);

    const dry = runSync(root, true, () => {}, "general");
    assert.deepEqual(
      { details: dry.changes.map((c) => `${c.action} ${c.detail}`), removed: dry.sections.general.removed },
      { details: ["- sub/a.gif", "- sub/b.gif", "- sub/"], removed: 3 },
    );

    runSync(root, false, () => {}, "general");
    assert.isUndefined(sub(readManifest(manifestPath), "sub"));
  });

  it("SR346-R11: a file moved into a new folder keeps its sid, type and file-info (a), and a file moved out of a vanished folder keeps its sid (c)", () => {
    // (a) sample.gif moved into a new files/sub/
    const a = copyFixture();
    const seeded = general(readManifest(a.manifestPath)).items.find((i) => i.name === "sample.gif")!;
    assert.equal(seeded.sid, SAMPLE_SID);
    mkdirSync(path.join(a.root, "files", "sub"));
    renameSync(path.join(a.root, "files", "sample.gif"), path.join(a.root, "files", "sub", "sample.gif"));
    const resultA = runSync(a.root, false, () => {}, "general");
    const afterA = readManifest(a.manifestPath);
    assert.deepEqual(
      {
        moved: sub(afterA, "sub")?.items.find((i) => i.name === "sample.gif"),
        rootHas: general(afterA).items.some((i) => i.name === "sample.gif"),
        changes: resultA.changes.map((c) => ({ ...c })),
      },
      {
        moved: seeded,
        rootHas: false,
        changes: [
          { section: "general", action: "-", detail: "sample.gif", movedTo: "sub/sample.gif" },
          { section: "general", action: "+", detail: "sub/ (new folder)" },
          {
            section: "general",
            action: "+",
            detail: `sub/sample.gif (kept sid=${SAMPLE_SID})`,
            movedFrom: "sample.gif",
          },
        ],
      },
    );

    // (c) manifest declares sub/sample.gif, the file is at the root and sub/ is gone
    const c = copyFixture();
    const mc = readManifest(c.manifestPath);
    const idx = general(mc).items.findIndex((i) => i.name === "sample.gif");
    const [item] = general(mc).items.splice(idx, 1);
    general(mc).subfolders.push({ name: "sub", items: [item], subfolders: [] });
    writeManifest(c.manifestPath, mc);
    runSync(c.root, false, () => {}, "general");
    const afterC = readManifest(c.manifestPath);
    assert.deepEqual(
      { root: general(afterC).items.find((i) => i.name === "sample.gif"), sub: sub(afterC, "sub") },
      { root: item, sub: undefined },
    );
  });

  it("SR346-R12: a name declared in two folders is never paired as a move; the new copy gets a fresh sid", () => {
    const { root, manifestPath } = copyFixture();
    const m = readManifest(manifestPath);
    general(m).subfolders.push(
      { name: "a", items: [fileItem("x.txt", 323456789012345)], subfolders: [] },
      { name: "b", items: [fileItem("x.txt", 423456789012345)], subfolders: [] },
    );
    writeManifest(manifestPath, m);
    mkdirSync(path.join(root, "files", "a"));
    mkdirSync(path.join(root, "files", "c"));
    writeFileSync(path.join(root, "files", "a", "x.txt"), "");
    writeFileSync(path.join(root, "files", "c", "x.txt"), "");

    const result = runSync(root, false, () => {}, "general");
    const after = readManifest(manifestPath);
    const fresh = sub(after, "c")?.items[0].sid;
    assert.deepEqual(
      {
        paired: result.changes.some((c) => c.movedTo !== undefined || c.movedFrom !== undefined),
        freshIsNew: fresh !== undefined && fresh !== 323456789012345 && fresh !== 423456789012345,
        aKept: sub(after, "a")?.items[0].sid,
        bGone: sub(after, "b"),
      },
      { paired: false, freshIsNew: true, aKept: 323456789012345, bGone: undefined },
    );
  });
});
