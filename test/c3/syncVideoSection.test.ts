import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runSync, ALL_SECTION_KEYS } from "../../src/c3/projectSync.js";

// Each row runs against a temp COPY of the canonical fixture, never the fixture itself.

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

describe("sync video file section", function () {
  this.timeout(120_000);

  const dirs: string[] = [];

  function copy(): string {
    const root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-sv358-"));
    dirs.push(root);
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return root;
  }

  function seedFile(root: string, rel: string, content: string): void {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("I358-V1: videos/ files are registered under the video section with c3source's current types", () => {
    const root = copy();
    seedFile(root, "videos/clip.mp4", "mp4\n");
    seedFile(root, "videos/clip.webm", "webm\n");
    seedFile(root, "videos/readme.txt", "r\n");

    const logged: string[] = [];
    runSync(root, false, (line) => logged.push(line));

    const manifestText = readFileSync(path.join(root, "project.c3proj"), "utf8");
    const manifest = JSON.parse(manifestText);
    // Mask the minted SID: a numeric `sid` becomes the string "<SID>".
    const items = (manifest.rootFileFolders.video.items as Array<Record<string, unknown>>)
      .map((item) => ({ ...item, sid: typeof item.sid === "number" ? "<SID>" : item.sid }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const readmeAnywhere = manifestText.includes("readme.txt") || logged.some((l) => l.includes("readme.txt"));

    expect(
      { items, readmeAnywhere },
      "the video section registers .mp4 and .webm with c3source's current types; if c3source's type for a video .webm moved (GenvidTechnologies/c3source#113), update this row, ADR 0066 and the CHANGELOG known-limitation sentence together",
    ).to.deep.equal({
      items: [
        { name: "clip.mp4", type: "video/mp4", sid: "<SID>", "file-info": { purpose: "none" } },
        { name: "clip.webm", type: "audio/webm; codecs=opus", sid: "<SID>", "file-info": { purpose: "none" } },
      ],
      readmeAnywhere: false,
    });
  });

  it("I358-V3: a manifest without rootFileFolders.video warns and sync continues", () => {
    const root = copy();
    const manifestPath = path.join(root, "project.c3proj");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.rootFileFolders.video;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));

    const logged: string[] = [];
    let threw: string | null = null;
    try {
      runSync(root, true, (line) => logged.push(line));
    } catch (e) {
      threw = (e as NodeJS.ErrnoException).code ?? String(e);
    }

    expect({ threw, warnings: logged.filter((l) => l.includes("rootFileFolders.video")) }).to.deep.equal({
      threw: null,
      warnings: ["Warning: rootFileFolders.video not found in project.c3proj"],
    });
  });

  it("I358-V4: video follows music in ALL_SECTION_KEYS and a video-scoped run reports only [video]", () => {
    const root = copy();
    seedFile(root, "videos/clip.mp4", "mp4\n");

    const logged: string[] = [];
    let error: string | null = null;
    try {
      runSync(root, true, (line) => logged.push(line), "video");
    } catch (e) {
      error = (e as Error).message;
    }
    const sections = [...new Set(logged.map((l) => /^\[[^\]]+\]/.exec(l)?.[0]).filter((s) => s !== undefined))].sort();

    expect({
      afterMusic: ALL_SECTION_KEYS.indexOf("video") === ALL_SECTION_KEYS.indexOf("music") + 1,
      sections,
      error,
    }).to.deep.equal({ afterMusic: true, sections: ["[video]"], error: null });
  });
});
