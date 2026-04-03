import { describe, it, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  discoverAndPlanImageCopies,
  cloneSprite,
} from "../../src/c3/spriteScaffold.js";

// ─── Test helpers ───

/** Build a minimal objectType JSON matching the StoryBookIcon shape */
function makeObjectType(
  name: string,
  opts?: {
    sid?: number;
    instanceVarSid?: number;
    animationSid?: number;
    imageSpriteId?: number;
  },
): Record<string, unknown> {
  const sid = opts?.sid ?? 901263524064120;
  const instanceVarSid = opts?.instanceVarSid ?? 589843295581125;
  const animationSid = opts?.animationSid ?? 922468535567438;
  const imageSpriteId = opts?.imageSpriteId ?? 5212012;
  return {
    name,
    "plugin-id": "Sprite",
    sid,
    isGlobal: false,
    editorNewInstanceIsReplica: true,
    instanceVariables: [
      {
        name: "isTouched",
        type: "boolean",
        desc: "",
        show: true,
        sid: instanceVarSid,
      },
    ],
    behaviorTypes: [],
    effectTypes: [],
    animations: {
      items: [
        {
          frames: [
            {
              width: 90,
              height: 120,
              originX: 0.5,
              originY: 0.5,
              originalSource: "",
              exportFormat: "lossy",
              exportQuality: 0.8,
              fileType: "image/png",
              imageSpriteId,
              useCollisionPoly: true,
              duration: 1,
              tag: "",
            },
          ],
          sid: animationSid,
          name: "Animation 1",
          isLooping: false,
          isPingPong: false,
          repeatCount: 1,
          repeatTo: 0,
          speed: 5,
        },
      ],
      subfolders: [],
    },
  };
}

// ─── Tests ───

describe("scaffoldSprite", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "burbank-scaffoldSprite-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeObjectTypeFile(dir: string, filename: string, obj: Record<string, unknown>): void {
    writeFileSync(path.join(dir, filename), JSON.stringify(obj), "utf-8");
  }

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── collectAllObjectTypeSids ───

  describe("collectAllObjectTypeSids", () => {
    it("collects top-level sid, instanceVariable sids, and animation sids from files on disk", () => {
      const dir = makeTmpDir();
      const obj = makeObjectType("StoryBookIcon", {
        sid: 901263524064120,
        instanceVarSid: 589843295581125,
        animationSid: 922468535567438,
      });
      writeObjectTypeFile(dir, "StoryBookIcon.json", obj);

      const sids = collectAllObjectTypeSids(dir);

      assert.isTrue(sids.has(901263524064120), "should contain top-level sid");
      assert.isTrue(sids.has(589843295581125), "should contain instanceVariable sid");
      assert.isTrue(sids.has(922468535567438), "should contain animation sid");
    });

    it("collects sids from multiple files", () => {
      const dir = makeTmpDir();
      writeObjectTypeFile(
        dir,
        "ObjA.json",
        makeObjectType("ObjA", {
          sid: 100000000000001,
          instanceVarSid: 200000000000002,
          animationSid: 300000000000003,
        }),
      );
      writeObjectTypeFile(
        dir,
        "ObjB.json",
        makeObjectType("ObjB", {
          sid: 400000000000004,
          instanceVarSid: 500000000000005,
          animationSid: 600000000000006,
        }),
      );

      const sids = collectAllObjectTypeSids(dir);

      assert.isTrue(sids.has(100000000000001));
      assert.isTrue(sids.has(200000000000002));
      assert.isTrue(sids.has(300000000000003));
      assert.isTrue(sids.has(400000000000004));
      assert.isTrue(sids.has(500000000000005));
      assert.isTrue(sids.has(600000000000006));
    });

    it("does NOT include imageSpriteId values as sids", () => {
      const dir = makeTmpDir();
      const obj = makeObjectType("StoryBookIcon", { imageSpriteId: 5212012 });
      writeObjectTypeFile(dir, "StoryBookIcon.json", obj);

      const sids = collectAllObjectTypeSids(dir);

      assert.isFalse(sids.has(5212012), "imageSpriteId should not be treated as a sid");
    });
  });

  // ─── collectMaxImageSpriteId ───

  describe("collectMaxImageSpriteId", () => {
    it("finds the maximum imageSpriteId across all objectType files", () => {
      const dir = makeTmpDir();
      writeObjectTypeFile(dir, "ObjA.json", makeObjectType("ObjA", { imageSpriteId: 5212012 }));
      writeObjectTypeFile(dir, "ObjB.json", makeObjectType("ObjB", { imageSpriteId: 9996948 }));

      const max = collectMaxImageSpriteId(dir);

      assert.equal(max, 9996948);
    });

    it("returns 0 when no files exist", () => {
      const dir = makeTmpDir();
      const max = collectMaxImageSpriteId(dir);
      assert.equal(max, 0);
    });

    it("returns the single value when only one file exists", () => {
      const dir = makeTmpDir();
      writeObjectTypeFile(dir, "ObjA.json", makeObjectType("ObjA", { imageSpriteId: 1234567 }));
      const max = collectMaxImageSpriteId(dir);
      assert.equal(max, 1234567);
    });
  });

  // ─── discoverAndPlanImageCopies ───

  describe("discoverAndPlanImageCopies", () => {
    it("discovers images by source name prefix and plans copies with target name prefix", () => {
      const dir = makeTmpDir();
      // Create a dummy source image
      const sourceBasename = "storybookicon-animation 1-000.png";
      writeFileSync(path.join(dir, sourceBasename), "fake-png-data", "utf-8");

      const copies = discoverAndPlanImageCopies(dir, "StoryBookIcon", "VideosIcon");

      assert.equal(copies.length, 1, "should find one image");
      assert.equal(copies[0].sourceBasename, sourceBasename);
      assert.equal(copies[0].targetBasename, "videosicon-animation 1-000.png");
      assert.equal(copies[0].sourcePath, path.join(dir, sourceBasename));
      assert.equal(copies[0].targetPath, path.join(dir, "videosicon-animation 1-000.png"));
    });

    it("discovers multiple images for the same source name", () => {
      const dir = makeTmpDir();
      writeFileSync(path.join(dir, "storybookicon-animation 1-000.png"), "data", "utf-8");
      writeFileSync(path.join(dir, "storybookicon-animation 2-000.png"), "data", "utf-8");

      const copies = discoverAndPlanImageCopies(dir, "StoryBookIcon", "VideosIcon");

      assert.equal(copies.length, 2);
      const targetBasenames = copies.map((c) => c.targetBasename).sort();
      assert.deepEqual(targetBasenames, ["videosicon-animation 1-000.png", "videosicon-animation 2-000.png"]);
    });

    it("returns empty array when no matching images exist", () => {
      const dir = makeTmpDir();
      writeFileSync(path.join(dir, "otherobject-animation 1-000.png"), "data", "utf-8");

      const copies = discoverAndPlanImageCopies(dir, "StoryBookIcon", "VideosIcon");

      assert.equal(copies.length, 0);
    });

    it("does not include unrelated images that share a partial prefix", () => {
      const dir = makeTmpDir();
      writeFileSync(path.join(dir, "storybookicon-animation 1-000.png"), "data", "utf-8");
      // "storybookiconextra" is NOT a match for "storybookicon-"
      writeFileSync(path.join(dir, "storybookiconextra-animation 1-000.png"), "data", "utf-8");

      const copies = discoverAndPlanImageCopies(dir, "StoryBookIcon", "VideosIcon");

      assert.equal(copies.length, 1, "should only match exact prefix with hyphen separator");
      assert.equal(copies[0].sourceBasename, "storybookicon-animation 1-000.png");
    });
  });

  // ─── cloneSprite ───

  describe("cloneSprite - basic", () => {
    it("cloned sprite has new name; original is unchanged", () => {
      const source = makeObjectType("StoryBookIcon");
      const existingSids = new Set<number>([
        source.sid as number,
        (source.instanceVariables as Array<Record<string, unknown>>)[0].sid as number,
        ((source.animations as Record<string, unknown>).items as Array<Record<string, unknown>>)[0].sid as number,
      ]);

      const clone = cloneSprite(source, {
        name: "VideosIcon",
        existingSids,
        nextImageSpriteId: 9996949,
      });

      assert.equal(clone.name, "VideosIcon");
      assert.equal(source.name, "StoryBookIcon", "original should be unchanged");
    });
  });

  describe("cloneSprite - SIDs are remapped", () => {
    it("all SIDs in clone are different from source", () => {
      const source = makeObjectType("StoryBookIcon", {
        sid: 901263524064120,
        instanceVarSid: 589843295581125,
        animationSid: 922468535567438,
      });
      const existingSids = new Set<number>([901263524064120, 589843295581125, 922468535567438]);

      const clone = cloneSprite(source, {
        name: "VideosIcon",
        existingSids,
        nextImageSpriteId: 9996949,
      });

      assert.notEqual(clone.sid, 901263524064120, "top-level sid should be remapped");

      const instanceVars = clone.instanceVariables as Array<Record<string, unknown>>;
      assert.notEqual(instanceVars[0].sid, 589843295581125, "instanceVariable sid should be remapped");

      const animItems = (clone.animations as Record<string, unknown>).items as Array<Record<string, unknown>>;
      assert.notEqual(animItems[0].sid, 922468535567438, "animation sid should be remapped");
    });

    it("new SIDs do not collide with existingSids", () => {
      const source = makeObjectType("StoryBookIcon", {
        sid: 100000000000001,
        instanceVarSid: 200000000000002,
        animationSid: 300000000000003,
      });
      const existingSids = new Set<number>([100000000000001, 200000000000002, 300000000000003, 999999999999999]);

      const clone = cloneSprite(source, {
        name: "VideosIcon",
        existingSids,
        nextImageSpriteId: 100,
      });

      const cloneSid = clone.sid as number;
      const cloneInstVarSid = (clone.instanceVariables as Array<Record<string, unknown>>)[0].sid as number;
      const cloneAnimSid = ((clone.animations as Record<string, unknown>).items as Array<Record<string, unknown>>)[0]
        .sid as number;

      assert.isFalse(existingSids.has(cloneSid), "top-level sid must not collide with existingSids");
      assert.isFalse(existingSids.has(cloneInstVarSid), "instanceVariable sid must not collide with existingSids");
      assert.isFalse(existingSids.has(cloneAnimSid), "animation sid must not collide with existingSids");
    });

    it("new SIDs are all unique from each other", () => {
      const source = makeObjectType("StoryBookIcon", {
        sid: 100000000000001,
        instanceVarSid: 200000000000002,
        animationSid: 300000000000003,
      });

      const clone = cloneSprite(source, {
        name: "VideosIcon",
        existingSids: new Set<number>(),
        nextImageSpriteId: 100,
      });

      const cloneSid = clone.sid as number;
      const cloneInstVarSid = (clone.instanceVariables as Array<Record<string, unknown>>)[0].sid as number;
      const cloneAnimSid = ((clone.animations as Record<string, unknown>).items as Array<Record<string, unknown>>)[0]
        .sid as number;

      const allNewSids = [cloneSid, cloneInstVarSid, cloneAnimSid];
      const uniqueSids = new Set(allNewSids);
      assert.equal(uniqueSids.size, allNewSids.length, "all new SIDs should be unique");
    });
  });

  describe("cloneSprite - imageSpriteId is remapped", () => {
    it("new imageSpriteId is greater than source value", () => {
      const sourceImageSpriteId = 5212012;
      const source = makeObjectType("StoryBookIcon", { imageSpriteId: sourceImageSpriteId });

      const clone = cloneSprite(source, {
        name: "VideosIcon",
        existingSids: new Set<number>(),
        nextImageSpriteId: 9996949,
      });

      const cloneAnimItems = (clone.animations as Record<string, unknown>).items as Array<Record<string, unknown>>;
      const cloneFrames = cloneAnimItems[0].frames as Array<Record<string, unknown>>;
      const cloneImageSpriteId = cloneFrames[0].imageSpriteId as number;

      assert.equal(cloneImageSpriteId, 9996949, "new imageSpriteId should be nextImageSpriteId");
      assert.isAbove(cloneImageSpriteId, sourceImageSpriteId, "new imageSpriteId should be greater than source");
    });

    it("assigns sequential imageSpriteIds when there are multiple frames", () => {
      // Build a source with two frames
      const source: Record<string, unknown> = {
        name: "MultiFrame",
        "plugin-id": "Sprite",
        sid: 100000000000001,
        isGlobal: false,
        editorNewInstanceIsReplica: false,
        instanceVariables: [],
        behaviorTypes: [],
        effectTypes: [],
        animations: {
          items: [
            {
              frames: [
                {
                  width: 90,
                  height: 120,
                  originX: 0.5,
                  originY: 0.5,
                  originalSource: "",
                  exportFormat: "lossy",
                  exportQuality: 0.8,
                  fileType: "image/png",
                  imageSpriteId: 1000,
                  useCollisionPoly: true,
                  duration: 1,
                  tag: "",
                },
                {
                  width: 90,
                  height: 120,
                  originX: 0.5,
                  originY: 0.5,
                  originalSource: "",
                  exportFormat: "lossy",
                  exportQuality: 0.8,
                  fileType: "image/png",
                  imageSpriteId: 1001,
                  useCollisionPoly: true,
                  duration: 1,
                  tag: "",
                },
              ],
              sid: 200000000000002,
              name: "Animation 1",
              isLooping: false,
              isPingPong: false,
              repeatCount: 1,
              repeatTo: 0,
              speed: 5,
            },
          ],
          subfolders: [],
        },
      };

      const clone = cloneSprite(source, {
        name: "MultiFrameClone",
        existingSids: new Set<number>(),
        nextImageSpriteId: 5000,
      });

      const cloneAnimItems = (clone.animations as Record<string, unknown>).items as Array<Record<string, unknown>>;
      const cloneFrames = cloneAnimItems[0].frames as Array<Record<string, unknown>>;

      assert.equal(cloneFrames[0].imageSpriteId, 5000, "first frame imageSpriteId should be nextImageSpriteId");
      assert.equal(cloneFrames[1].imageSpriteId, 5001, "second frame imageSpriteId should be nextImageSpriteId + 1");
    });
  });

  describe("cloneSprite - image files are copied", () => {
    it("copyFileSync copies source image to target path with renamed prefix", () => {
      const dir = makeTmpDir();
      const sourceBasename = "storybookicon-animation 1-000.png";
      const sourceImagePath = path.join(dir, sourceBasename);
      writeFileSync(sourceImagePath, "fake-png-data", "utf-8");

      const copies = discoverAndPlanImageCopies(dir, "StoryBookIcon", "VideosIcon");
      assert.equal(copies.length, 1);

      const { sourcePath, targetPath } = copies[0];
      copyFileSync(sourcePath, targetPath);

      assert.isTrue(existsSync(targetPath), "target image should exist after copy");
      assert.isTrue(existsSync(sourceImagePath), "source image should still exist after copy");
    });
  });
});
