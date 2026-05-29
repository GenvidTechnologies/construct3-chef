import { describe, it, after } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { applyRecipeInner } from "../../src/c3/recipeApplier.js";
import { freshSidGen } from "../../src/c3/sidUtils.js";

// End-to-end regression for the 2026-05-04 fix-goal-layout incident: an
// agent hand-edited ~355 lines of layout JSON to extract a same-layer master
// template, producing 18-digit SIDs that overflowed Number.MAX_SAFE_INTEGER.
// The `extract-template` workflow op routes the same scenario through the
// recipe pipeline: copy-instance + templatize on the templates layout + a
// replicify on the source layout, all sharing the recipe's SidGenerator.
//
// This test asserts the post-apply layout JSON has the expected structure
// (template/replica blocks, scene-graphs-folder-root registration) and that
// every new SID falls in the safe [1e14, 1e15) range.

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const SAFE_SID_MIN = 1e14;
const SAFE_SID_MAX = 1e15;

interface LayoutShape {
  layers: Array<{ name: string; instances: unknown[]; subLayers: unknown[]; sid: number }>;
  "scene-graphs-folder-root": { items: Array<{ sid: number }> };
}

interface InstanceShape {
  uid: number;
  type: string;
  sid: number;
  tags: string;
  instanceVariables: Record<string, unknown>;
  world: Record<string, unknown>;
  properties: Record<string, unknown>;
  sceneGraphData: { uid: number; "parent-uid": number; children: Array<{ uid: number }> };
  template?: { mode: string; templateName?: string; sourceTemplateName?: string };
}

function makeInstance(uid: number, type: string, parentUid: number, childUids: number[], sid: number): InstanceShape {
  return {
    uid,
    type,
    sid,
    tags: "",
    instanceVariables: {},
    world: { x: 0, y: 0, width: 64, height: 64, opacity: 1 },
    properties: {},
    sceneGraphData: { uid, "parent-uid": parentUid, children: childUids.map((u) => ({ uid: u })) },
  };
}

// Fixture: ShopLayout has the `IconContainerWithAmount` root + 4 children on
// "Layer 0". Mirrors the original incident's structure.
function makeShopLayout(): LayoutShape {
  const root = makeInstance(1, "IconContainerWithAmount", -1, [2, 3, 4, 5], 200000000000001);
  const c1 = makeInstance(2, "IconSprite", 1, [], 200000000000002);
  const c2 = makeInstance(3, "AmountText", 1, [], 200000000000003);
  const c3 = makeInstance(4, "BackgroundSprite", 1, [], 200000000000004);
  const c4 = makeInstance(5, "BorderSprite", 1, [], 200000000000005);
  return {
    layers: [
      { name: "Layer 0", instances: [root, c1, c2, c3, c4], subLayers: [], sid: 200000000000100 },
    ],
    "scene-graphs-folder-root": { items: [{ sid: 200000000000001 }] },
  };
}

// Fixture: UI_ComponentsLayout has an empty "Layer 0" — the template will
// land here.
function makeUiComponentsLayout(): LayoutShape {
  return {
    layers: [{ name: "Layer 0", instances: [], subLayers: [], sid: 200000000000200 }],
    "scene-graphs-folder-root": { items: [] },
  };
}

function makeProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "c3-extract-template-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "layouts"), { recursive: true });
  mkdirSync(path.join(dir, "eventSheets"), { recursive: true });
  mkdirSync(path.join(dir, "objectTypes"), { recursive: true });
  writeFileSync(
    path.join(dir, "layouts", "ShopLayout.json"),
    JSON.stringify(makeShopLayout(), null, "\t") + "\n",
  );
  writeFileSync(
    path.join(dir, "layouts", "UI_ComponentsLayout.json"),
    JSON.stringify(makeUiComponentsLayout(), null, "\t") + "\n",
  );
  return dir;
}

const noop = () => {};

describe("extract-template integration: fix-goal-layout regression", () => {
  it("extracts a master template into UI_ComponentsLayout and replicates the original on ShopLayout", () => {
    const dir = makeProject();
    const sidGen = freshSidGen();

    const recipe = {
      layouts: {
        "layouts/UI_ComponentsLayout.json": [
          {
            op: "extract-template",
            sourceLayout: "layouts/ShopLayout.json",
            sourceType: "IconContainerWithAmount",
            templateName: "IconContainerWithAmount",
            templatesLayer: "Layer 0",
            includeChildren: true,
          },
        ],
      },
    };

    applyRecipeInner(sidGen, dir, recipe, { regenerate: false, log: noop });

    const uiLayout = JSON.parse(
      readFileSync(path.join(dir, "layouts", "UI_ComponentsLayout.json"), "utf-8"),
    ) as LayoutShape;
    const shopLayout = JSON.parse(
      readFileSync(path.join(dir, "layouts", "ShopLayout.json"), "utf-8"),
    ) as LayoutShape;

    // ── UI_ComponentsLayout: 1 root + 4 children on Layer 0 ──
    const uiLayer = uiLayout.layers.find((l) => l.name === "Layer 0")!;
    const uiInstances = uiLayer.instances as InstanceShape[];
    expect(uiInstances).to.have.lengthOf(5);

    const uiRoot = uiInstances.find((i) => i.type === "IconContainerWithAmount")!;
    expect(uiRoot, "templates layout has IconContainerWithAmount root").to.not.be.undefined;
    expect(uiRoot.template, "templates root has template block").to.not.be.undefined;
    expect(uiRoot.template!.mode).to.equal("template");
    expect(uiRoot.template!.templateName).to.equal("IconContainerWithAmount");

    const uiChildren = uiInstances.filter((i) => i.type !== "IconContainerWithAmount");
    expect(uiChildren, "4 children cloned onto templates layout").to.have.lengthOf(4);
    for (const child of uiChildren) {
      expect(child.sceneGraphData["parent-uid"], "child links to new template root").to.equal(uiRoot.uid);
    }

    // ── UI_ComponentsLayout: scene-graphs-folder-root.items registers the new root SID ──
    const uiSceneGraphItems = uiLayout["scene-graphs-folder-root"].items;
    expect(uiSceneGraphItems.map((it) => it.sid)).to.include(uiRoot.sid);

    // ── ShopLayout: original instance is now a replica ──
    const shopLayer = shopLayout.layers.find((l) => l.name === "Layer 0")!;
    const shopInstances = shopLayer.instances as InstanceShape[];
    const shopRoot = shopInstances.find((i) => i.type === "IconContainerWithAmount")!;
    expect(shopRoot.template, "shop root has template block after replicify").to.not.be.undefined;
    expect(shopRoot.template!.mode).to.equal("replica");
    expect(shopRoot.template!.sourceTemplateName).to.equal("IconContainerWithAmount");

    // ── ShopLayout still has its children (untouched) ──
    expect(shopInstances.filter((i) => i.type !== "IconContainerWithAmount")).to.have.lengthOf(4);

    // ── Every new SID on the templates layout falls in the safe range ──
    const newSids: number[] = [uiRoot.sid, ...uiChildren.map((c) => c.sid)];
    for (const sid of newSids) {
      expect(sid, `new SID ${sid} is in safe [1e14, 1e15) range`).to.be.at.least(SAFE_SID_MIN);
      expect(sid, `new SID ${sid} is in safe [1e14, 1e15) range`).to.be.below(SAFE_SID_MAX);
    }

    // ── No SID collisions across both layouts ──
    const allSids = [...uiInstances, ...shopInstances].map((i) => i.sid);
    expect(new Set(allSids).size, "no SID collisions across both layouts").to.equal(allSids.length);
  });

  it("rejects same-layout sourceLayout at validation time, before any I/O", () => {
    const dir = makeProject();
    const sidGen = freshSidGen();

    const recipe = {
      layouts: {
        "layouts/UI_ComponentsLayout.json": [
          {
            op: "extract-template",
            // Same as the layouts key — this should be templatize-in-place.
            sourceLayout: "layouts/UI_ComponentsLayout.json",
            sourceType: "SomeType",
            templateName: "SomeType",
            templatesLayer: "Layer 0",
          },
        ],
      },
    };

    expect(() => applyRecipeInner(sidGen, dir, recipe, { regenerate: false, log: noop })).to.throw(
      /"sourceLayout" must differ from the layouts key/,
    );
  });
});
