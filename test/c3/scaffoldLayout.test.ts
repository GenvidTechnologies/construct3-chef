import { describe, it, after } from "mocha";
import { assert } from "chai";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectAllUids, collectLayoutUids, collectLayoutSids, cloneLayout } from "../../src/c3/layoutScaffold.js";

// ─── Test helpers ───

/** Build a minimal instance object, optionally with sceneGraphData. */
function makeInstance(
  uid: number,
  sid: number,
  parentUid?: number | null,
  childUids?: number[],
): Record<string, unknown> {
  const inst: Record<string, unknown> = { uid, sid, type: "Sprite" };
  if (parentUid !== undefined || childUids !== undefined) {
    const sgd: Record<string, unknown> = {
      uid,
      "parent-uid": parentUid ?? null,
    };
    if (childUids) {
      sgd.children = childUids.map((cUid) => ({ uid: cUid, flags: {} }));
    }
    inst.sceneGraphData = sgd;
  }
  return inst;
}

/** Build a minimal layer object. */
function makeLayer(sid: number, instances: unknown[] = [], subLayers: unknown[] = []): Record<string, unknown> {
  return { name: "Layer", sid, instances, subLayers };
}

/** Build a minimal layout JSON object. */
function makeLayout(name: string, opts?: { uid?: number; sid?: number; eventSheet?: string }): Record<string, unknown> {
  const uid = opts?.uid ?? 100001;
  const sid = opts?.sid ?? 111111111111111;
  const layerSid = sid + 1;
  const instSid = sid + 2;
  return {
    name,
    eventSheet: opts?.eventSheet ?? "SomeEvents",
    sid,
    layers: [makeLayer(layerSid, [makeInstance(uid, instSid)])],
    "nonworld-instances": [],
    "scene-graphs-folder-root": {
      items: [{ sid: instSid, expanded: true }],
      subfolders: [],
    },
  };
}

// ─── Tests ───

describe("scaffoldLayout", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "burbank-scaffoldLayout-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeLayoutFile(dir: string, filename: string, layout: Record<string, unknown>): void {
    writeFileSync(path.join(dir, filename), JSON.stringify(layout), "utf-8");
  }

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── collectAllUids ───

  describe("collectAllUids", () => {
    it("reads UID fields from layout JSON files on disk", () => {
      const dir = makeTmpDir();
      const layout1 = makeLayout("Layout1", { uid: 100001, sid: 111000000000001 });
      const layout2 = makeLayout("Layout2", { uid: 200002, sid: 222000000000001 });
      writeLayoutFile(dir, "Layout1.json", layout1);
      writeLayoutFile(dir, "Layout2.json", layout2);

      const uids = collectAllUids(dir);

      assert.isTrue(uids.has(100001), "should contain uid from layout1");
      assert.isTrue(uids.has(200002), "should contain uid from layout2");
    });

    it("excludes .uistate.json files", () => {
      const dir = makeTmpDir();
      const layout = makeLayout("Layout1", { uid: 100001, sid: 111000000000001 });
      writeLayoutFile(dir, "Layout1.json", layout);
      // Write a uistate file with a different uid — it should not be collected
      writeFileSync(path.join(dir, "Layout1.uistate.json"), JSON.stringify({ uid: 999999 }), "utf-8");

      const uids = collectAllUids(dir);

      assert.isTrue(uids.has(100001));
      assert.isFalse(uids.has(999999), "uistate file uids should be excluded");
    });
  });

  // ─── collectLayoutUids ───

  describe("collectLayoutUids", () => {
    it("collects instance UIDs from layers", () => {
      const layout = makeLayout("Test", { uid: 111111, sid: 100000000000001 });
      const uids = collectLayoutUids(layout);
      assert.isTrue(uids.has(111111));
    });

    it("collects instance UIDs from sublayers", () => {
      const subLayerInst = makeInstance(222222, 200000000000002);
      const subLayer = makeLayer(300000000000003, [subLayerInst]);
      const layer = makeLayer(400000000000004, [], [subLayer]);
      const layout: Record<string, unknown> = {
        name: "Test",
        sid: 500000000000005,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const uids = collectLayoutUids(layout);
      assert.isTrue(uids.has(222222));
    });

    it("collects UIDs from nonworld-instances", () => {
      const layout: Record<string, unknown> = {
        name: "Test",
        sid: 100000000000001,
        layers: [],
        "nonworld-instances": [{ uid: 333333, sid: 200000000000002, type: "JSON" }],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const uids = collectLayoutUids(layout);
      assert.isTrue(uids.has(333333));
    });

    it("collects sceneGraphData.uid and child UIDs", () => {
      const inst = makeInstance(444444, 100000000000001, null, [555555, 666666]);
      const layer = makeLayer(200000000000002, [inst]);
      const layout: Record<string, unknown> = {
        name: "Test",
        sid: 300000000000003,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const uids = collectLayoutUids(layout);
      assert.isTrue(uids.has(444444), "instance uid");
      assert.isTrue(uids.has(555555), "child uid 1");
      assert.isTrue(uids.has(666666), "child uid 2");
    });
  });

  // ─── collectLayoutSids ───

  describe("collectLayoutSids", () => {
    it("collects layout sid", () => {
      const layout = makeLayout("Test", { uid: 100001, sid: 123456789012345 });
      const sids = collectLayoutSids(layout);
      assert.isTrue(sids.has(123456789012345));
    });

    it("collects layer sids and sublayer sids", () => {
      const subLayer = makeLayer(111111111111111);
      const layer = makeLayer(222222222222222, [], [subLayer]);
      const layout: Record<string, unknown> = {
        name: "Test",
        sid: 333333333333333,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const sids = collectLayoutSids(layout);
      assert.isTrue(sids.has(333333333333333), "layout sid");
      assert.isTrue(sids.has(222222222222222), "layer sid");
      assert.isTrue(sids.has(111111111111111), "sublayer sid");
    });

    it("collects instance sids and nonworld-instance sids", () => {
      const inst = makeInstance(100001, 444444444444444);
      const layer = makeLayer(555555555555555, [inst]);
      const layout: Record<string, unknown> = {
        name: "Test",
        sid: 666666666666666,
        layers: [layer],
        "nonworld-instances": [{ uid: 100002, sid: 777777777777777, type: "JSON" }],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const sids = collectLayoutSids(layout);
      assert.isTrue(sids.has(444444444444444), "instance sid");
      assert.isTrue(sids.has(777777777777777), "nonworld-instance sid");
    });
  });

  // ─── cloneLayout ───

  describe("cloneLayout - basic", () => {
    it("cloned layout has new name and eventSheet; original is unchanged", () => {
      const source = makeLayout("OriginalLayout", { uid: 100001, sid: 100000000000001, eventSheet: "OriginalEvents" });
      const existingUids = new Set<number>([100001]);

      const clone = cloneLayout(source, {
        name: "ClonedLayout",
        eventSheet: "ClonedEvents",
        existingUids,
      });

      assert.equal(clone.name, "ClonedLayout");
      assert.equal(clone.eventSheet, "ClonedEvents");

      // Original must be unchanged
      assert.equal(source.name, "OriginalLayout");
      assert.equal(source.eventSheet, "OriginalEvents");
    });
  });

  describe("cloneLayout - UIDs are remapped", () => {
    it("all UIDs in clone are different from source AND different from existingUids", () => {
      const uid = 100001;
      const source = makeLayout("Source", { uid, sid: 100000000000001 });
      const existingUids = new Set<number>([uid, 200002, 300003]);

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids,
      });

      const sourceUids = collectLayoutUids(source);
      const cloneUids = collectLayoutUids(clone);

      for (const cloneUid of cloneUids) {
        assert.isFalse(sourceUids.has(cloneUid), `clone uid ${cloneUid} should not appear in source`);
        assert.isFalse(existingUids.has(cloneUid), `clone uid ${cloneUid} should not collide with existingUids`);
      }
    });
  });

  describe("cloneLayout - UIDs are sequential", () => {
    it("new UIDs start from maxExistingUid+1 and are contiguous", () => {
      const sourceInst1 = makeInstance(100001, 111111111111111);
      const sourceInst2 = makeInstance(100002, 222222222222222);
      const layer = makeLayer(333333333333333, [sourceInst1, sourceInst2]);
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 444444444444444,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const existingUids = new Set<number>([100001, 100002, 200000]);

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids,
      });

      const cloneUids = Array.from(collectLayoutUids(clone)).sort((a, b) => a - b);
      const expectedStart = 200001; // max(200000, 100001, 100002) + 1

      // UIDs should start at expectedStart and be contiguous
      assert.equal(cloneUids[0], expectedStart, "first uid should be maxExistingUid+1");
      for (let i = 1; i < cloneUids.length; i++) {
        assert.equal(cloneUids[i], cloneUids[i - 1] + 1, "UIDs should be contiguous");
      }
    });
  });

  describe("cloneLayout - SIDs are remapped", () => {
    it("all SIDs in clone are different from source", () => {
      const source = makeLayout("Source", { uid: 100001, sid: 100000000000001 });
      const existingUids = new Set<number>([100001]);

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids,
      });

      const sourceSids = collectLayoutSids(source);
      const cloneSids = collectLayoutSids(clone);

      for (const cloneSid of cloneSids) {
        assert.isFalse(sourceSids.has(cloneSid), `clone sid ${cloneSid} should not appear in source`);
      }
    });
  });

  describe("cloneLayout - sceneGraphData references", () => {
    it("sceneGraphData.uid and sceneGraphData['parent-uid'] are correctly remapped", () => {
      const child = makeInstance(100002, 200000000000002);
      const parent = makeInstance(100001, 100000000000001, null, [100002]);
      // Override child's sceneGraphData to reference parent
      (child as Record<string, unknown>).sceneGraphData = {
        uid: 100002,
        "parent-uid": 100001,
        children: [],
      };

      const layer = makeLayer(300000000000003, [parent, child]);
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 400000000000004,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const existingUids = new Set<number>([100001, 100002]);

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids,
      });

      const cloneLayers = clone.layers as Array<Record<string, unknown>>;
      const cloneInstances = cloneLayers[0].instances as Array<Record<string, unknown>>;
      const cloneParent = cloneInstances[0];
      const cloneChild = cloneInstances[1];

      const parentNewUid = cloneParent.uid as number;
      const childNewUid = cloneChild.uid as number;

      assert.notEqual(parentNewUid, 100001, "parent uid should be remapped");
      assert.notEqual(childNewUid, 100002, "child uid should be remapped");

      const parentSgd = cloneParent.sceneGraphData as Record<string, unknown>;
      const childSgd = cloneChild.sceneGraphData as Record<string, unknown>;

      assert.equal(parentSgd.uid, parentNewUid, "parent sceneGraphData.uid should match new uid");
      assert.equal(childSgd.uid, childNewUid, "child sceneGraphData.uid should match new uid");
      assert.equal(childSgd["parent-uid"], parentNewUid, "child parent-uid should be remapped to new parent uid");
    });

    it("sceneGraphData['parent-uid'] stays null when originally null", () => {
      const inst = makeInstance(100001, 100000000000001, null);
      const layer = makeLayer(200000000000002, [inst]);
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 300000000000003,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids: new Set<number>([100001]),
      });

      const cloneLayers = clone.layers as Array<Record<string, unknown>>;
      const cloneInst = (cloneLayers[0].instances as Array<Record<string, unknown>>)[0];
      const sgd = cloneInst.sceneGraphData as Record<string, unknown>;
      assert.isNull(sgd["parent-uid"], "parent-uid should remain null");
    });
  });

  describe("cloneLayout - sceneGraphData children", () => {
    it("child UIDs in sceneGraphData.children are remapped", () => {
      const childUid1 = 100002;
      const childUid2 = 100003;
      const parentInst = makeInstance(100001, 100000000000001, null, [childUid1, childUid2]);
      const layer = makeLayer(200000000000002, [parentInst]);
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 300000000000003,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const existingUids = new Set<number>([100001, 100002, 100003]);

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids,
      });

      const cloneLayers = clone.layers as Array<Record<string, unknown>>;
      const cloneInst = (cloneLayers[0].instances as Array<Record<string, unknown>>)[0];
      const sgd = cloneInst.sceneGraphData as Record<string, unknown>;
      const children = sgd.children as Array<Record<string, unknown>>;

      assert.equal(children.length, 2);
      assert.notEqual(children[0].uid, childUid1, "child uid 1 should be remapped");
      assert.notEqual(children[1].uid, childUid2, "child uid 2 should be remapped");
    });
  });

  describe("cloneLayout - scene-graphs-folder-root sids", () => {
    it("item SIDs in scene-graphs-folder-root are remapped to match new instance SIDs", () => {
      const instSid = 100000000000001;
      const inst = makeInstance(100001, instSid);
      const layer = makeLayer(200000000000002, [inst]);
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 300000000000003,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": {
          items: [{ sid: instSid, expanded: true }],
          subfolders: [],
        },
      };

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids: new Set<number>([100001]),
      });

      // Get the new instance SID from the cloned layer
      const cloneLayers = clone.layers as Array<Record<string, unknown>>;
      const cloneInst = (cloneLayers[0].instances as Array<Record<string, unknown>>)[0];
      const newInstSid = cloneInst.sid as number;

      // The scene-graphs-folder-root item should reference the new instance SID
      const sgfr = clone["scene-graphs-folder-root"] as Record<string, unknown>;
      const items = sgfr.items as Array<Record<string, unknown>>;

      assert.equal(items.length, 1);
      assert.equal(items[0].sid, newInstSid, "scene-graphs-folder-root item sid should match new instance sid");
      assert.notEqual(items[0].sid, instSid, "scene-graphs-folder-root item sid should not be the original sid");
    });
  });

  describe("cloneLayout - nonworld-instances", () => {
    it("uid and sid are remapped for nonworld-instances", () => {
      const nwUid = 100001;
      const nwSid = 100000000000001;
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 200000000000002,
        layers: [],
        "nonworld-instances": [{ uid: nwUid, sid: nwSid, type: "JSON" }],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids: new Set<number>([nwUid]),
      });

      const cloneNwInstances = clone["nonworld-instances"] as Array<Record<string, unknown>>;
      assert.equal(cloneNwInstances.length, 1);
      assert.notEqual(cloneNwInstances[0].uid, nwUid, "nonworld-instance uid should be remapped");
      assert.notEqual(cloneNwInstances[0].sid, nwSid, "nonworld-instance sid should be remapped");
    });
  });

  describe("cloneLayout - sublayers", () => {
    it("layer sids in subLayers are remapped", () => {
      const subLayerSid = 111111111111111;
      const subLayer = makeLayer(subLayerSid, []);
      const layerSid = 222222222222222;
      const layer = makeLayer(layerSid, [], [subLayer]);
      const source: Record<string, unknown> = {
        name: "Source",
        eventSheet: "SourceEvents",
        sid: 333333333333333,
        layers: [layer],
        "nonworld-instances": [],
        "scene-graphs-folder-root": { items: [], subfolders: [] },
      };

      const clone = cloneLayout(source, {
        name: "Clone",
        eventSheet: "CloneEvents",
        existingUids: new Set<number>(),
      });

      const cloneLayers = clone.layers as Array<Record<string, unknown>>;
      const cloneLayer = cloneLayers[0];
      const cloneSubLayers = cloneLayer.subLayers as Array<Record<string, unknown>>;

      assert.notEqual(cloneLayer.sid, layerSid, "layer sid should be remapped");
      assert.equal(cloneSubLayers.length, 1);
      assert.notEqual(cloneSubLayers[0].sid, subLayerSid, "sublayer sid should be remapped");
    });
  });
});
