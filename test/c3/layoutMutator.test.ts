import { describe, it } from "mocha";
import { expect } from "chai";
import {
  findLayer,
  buildLayer,
  addSublayer,
  addLayer,
  findInstanceByType,
  findChildInstances,
  copyInstance,
  buildTemplateBlock,
  removeInstance,
  removeLayer,
  moveInstance,
  renameLayer,
  templatize,
  replicify,
  addReplica,
  type LayoutJson,
  type LayerJson,
  type InstanceJson,
  type InstanceOverrides,
} from "../../src/c3/layoutMutator.js";

// ─── Test helpers ───

function makeTestLayer(name: string, instances?: unknown[], subLayers?: unknown[]): LayerJson {
  return {
    name,
    instances: instances ?? [],
    subLayers: subLayers ?? [],
    sid: 0,
  } as LayerJson;
}

function makeTestLayout(layers: LayerJson[], sceneGraphRoot?: unknown): LayoutJson {
  const layout: LayoutJson = { layers };
  if (sceneGraphRoot) {
    layout["scene-graphs-folder-root"] = sceneGraphRoot;
  }
  return layout;
}

function makeTestInstance(
  uid: number,
  type: string,
  opts?: {
    sid?: number;
    parentUid?: number | null;
    childUids?: number[];
    tags?: string;
    instanceVariables?: Record<string, unknown>;
    world?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    instanceFolderItem?: Record<string, unknown>;
  },
): InstanceJson {
  const instance: InstanceJson = {
    uid,
    type,
    sid: opts?.sid ?? 100 + uid,
    tags: opts?.tags ?? "",
    instanceVariables: opts?.instanceVariables ?? {},
    world: opts?.world ?? {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      opacity: 1,
    },
    properties: opts?.properties ?? {},
    sceneGraphData: {
      uid,
      "parent-uid": opts?.parentUid ?? -1,
      children: (opts?.childUids ?? []).map((u) => ({ uid: u })),
    },
  };
  if (opts?.instanceFolderItem) {
    instance.instanceFolderItem = opts.instanceFolderItem;
  }
  return instance;
}

// ─── Tests ───

describe("layoutMutator", () => {
  // ─── findLayer ───

  describe("findLayer", () => {
    it("finds a top-level layer by name", () => {
      const layer = makeTestLayer("UI");
      const layout = makeTestLayout([layer]);
      const result = findLayer(layout, "UI");
      expect(result).to.equal(layer);
    });

    it("finds a sublayer by name", () => {
      const sub = makeTestLayer("Details");
      const parent = makeTestLayer("UI", [], [sub]);
      const layout = makeTestLayout([parent]);
      const result = findLayer(layout, "Details");
      expect(result).to.equal(sub);
    });

    it("finds a deeply nested sublayer", () => {
      const deep = makeTestLayer("DeepChild");
      const mid = makeTestLayer("Mid", [], [deep]);
      const top = makeTestLayer("Top", [], [mid]);
      const layout = makeTestLayout([top]);
      const result = findLayer(layout, "DeepChild");
      expect(result).to.equal(deep);
    });

    it("returns null when not found", () => {
      const layout = makeTestLayout([makeTestLayer("UI")]);
      const result = findLayer(layout, "NonExistent");
      expect(result).to.be.null;
    });

    it("returns null for empty layout (no layers)", () => {
      const layout: LayoutJson = {};
      const result = findLayer(layout, "Anything");
      expect(result).to.be.null;
    });
  });

  // ─── buildLayer ───

  describe("buildLayer", () => {
    it("returns object with all required C3 fields", () => {
      const layer = buildLayer("TestLayer");
      expect(layer).to.have.property("name");
      expect(layer).to.have.property("sid");
      expect(layer).to.have.property("subLayers");
      expect(layer).to.have.property("instances");
      expect(layer).to.have.property("isInitiallyVisible");
      expect(layer).to.have.property("renderingMode");
      expect(layer).to.have.property("blendMode");
    });

    it("has sid equal to 0", () => {
      const layer = buildLayer("TestLayer");
      expect(layer.sid).to.equal(0);
    });

    it("has empty subLayers array", () => {
      const layer = buildLayer("TestLayer");
      expect(layer.subLayers).to.deep.equal([]);
    });

    it("has empty instances array", () => {
      const layer = buildLayer("TestLayer");
      expect(layer.instances).to.deep.equal([]);
    });

    it("name matches parameter", () => {
      const layer = buildLayer("MyCustomLayer");
      expect(layer.name).to.equal("MyCustomLayer");
    });
  });

  // ─── addSublayer ───

  describe("addSublayer", () => {
    it("appends by default (no after)", () => {
      const existing = makeTestLayer("Existing");
      const parent = makeTestLayer("Parent", [], [existing]);
      const newLayer = addSublayer(parent, "NewSub");
      const subs = parent.subLayers as LayerJson[];
      expect(subs).to.have.lengthOf(2);
      expect(subs[0]).to.equal(existing);
      expect(subs[1]).to.equal(newLayer);
    });

    it("inserts after named sibling", () => {
      const first = makeTestLayer("First");
      const second = makeTestLayer("Second");
      const parent = makeTestLayer("Parent", [], [first, second]);
      const newLayer = addSublayer(parent, "Inserted", { after: "First" });
      const subs = parent.subLayers as LayerJson[];
      expect(subs).to.have.lengthOf(3);
      expect((subs[0] as Record<string, unknown>).name).to.equal("First");
      expect((subs[1] as Record<string, unknown>).name).to.equal("Inserted");
      expect((subs[2] as Record<string, unknown>).name).to.equal("Second");
      expect(subs[1]).to.equal(newLayer);
    });

    it("throws on missing after sibling name", () => {
      const parent = makeTestLayer("Parent", [], []);
      expect(() => addSublayer(parent, "New", { after: "Ghost" })).to.throw('sibling layer "Ghost" not found');
    });

    it("returns the new layer", () => {
      const parent = makeTestLayer("Parent", [], []);
      const newLayer = addSublayer(parent, "NewSub");
      expect(newLayer.name).to.equal("NewSub");
      expect(newLayer.sid).to.equal(0);
    });
  });

  // ─── addLayer ───

  describe("addLayer", () => {
    it("appends to top-level layers by default", () => {
      const existing = makeTestLayer("Existing");
      const layout = makeTestLayout([existing]);
      const newLayer = addLayer(layout, "NewTop");
      const layers = layout.layers as LayerJson[];
      expect(layers).to.have.lengthOf(2);
      expect(layers[1]).to.equal(newLayer);
    });

    it("inserts after named top-level layer", () => {
      const first = makeTestLayer("First");
      const second = makeTestLayer("Second");
      const layout = makeTestLayout([first, second]);
      addLayer(layout, "Middle", { after: "First" });
      const layers = layout.layers as LayerJson[];
      expect(layers).to.have.lengthOf(3);
      expect((layers[1] as Record<string, unknown>).name).to.equal("Middle");
    });

    it("throws on missing after name", () => {
      const layout = makeTestLayout([makeTestLayer("Only")]);
      expect(() => addLayer(layout, "New", { after: "Missing" })).to.throw('sibling layer "Missing" not found');
    });
  });

  // ─── findInstanceByType ───

  describe("findInstanceByType", () => {
    it("finds instance in top-level layer", () => {
      const inst = makeTestInstance(1, "Sprite");
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer]);
      const result = findInstanceByType(layout, "Sprite");
      expect(result).to.not.be.null;
      expect(result!.instance).to.equal(inst);
    });

    it("finds instance in sublayer", () => {
      const inst = makeTestInstance(2, "Button");
      const sub = makeTestLayer("Sub", [inst]);
      const top = makeTestLayer("Top", [], [sub]);
      const layout = makeTestLayout([top]);
      const result = findInstanceByType(layout, "Button");
      expect(result).to.not.be.null;
      expect(result!.instance).to.equal(inst);
    });

    it("returns null for missing type", () => {
      const layout = makeTestLayout([makeTestLayer("UI")]);
      const result = findInstanceByType(layout, "NonExistent");
      expect(result).to.be.null;
    });

    it("returns the layer name where instance was found", () => {
      const inst = makeTestInstance(3, "Text");
      const layer = makeTestLayer("HUD", [inst]);
      const layout = makeTestLayout([layer]);
      const result = findInstanceByType(layout, "Text");
      expect(result).to.not.be.null;
      expect(result!.layerName).to.equal("HUD");
    });
  });

  // ─── findChildInstances ───

  describe("findChildInstances", () => {
    it("finds children across layers", () => {
      const parent = makeTestInstance(1, "Container", { childUids: [2, 3] });
      const child1 = makeTestInstance(2, "ChildA", { parentUid: 1 });
      const child2 = makeTestInstance(3, "ChildB", { parentUid: 1 });
      const layer1 = makeTestLayer("L1", [parent, child1]);
      const layer2 = makeTestLayer("L2", [child2]);
      const layout = makeTestLayout([layer1, layer2]);
      const children = findChildInstances(layout, 1);
      expect(children).to.have.lengthOf(2);
      expect(children).to.include(child1);
      expect(children).to.include(child2);
    });

    it("returns empty array for no children", () => {
      const inst = makeTestInstance(10, "Lonely");
      const layer = makeTestLayer("L", [inst]);
      const layout = makeTestLayout([layer]);
      const children = findChildInstances(layout, 10);
      expect(children).to.deep.equal([]);
    });

    it("does not return the parent itself", () => {
      const parent = makeTestInstance(5, "Parent", { childUids: [6] });
      const child = makeTestInstance(6, "Child", { parentUid: 5 });
      const layer = makeTestLayer("L", [parent, child]);
      const layout = makeTestLayout([layer]);
      const children = findChildInstances(layout, 5);
      expect(children).to.have.lengthOf(1);
      expect(children[0]).to.equal(child);
    });
  });

  // ─── copyInstance (no children) ───

  describe("copyInstance (no children)", () => {
    function makeSourceAndTarget() {
      const inst = makeTestInstance(10, "Hero", {
        sid: 500,
        tags: "original",
        instanceVariables: { hp: 100 },
        world: { x: 50, y: 60, width: 200, height: 300, opacity: 0.8 },
        properties: { "initially-visible": true },
        instanceFolderItem: { sid: 500 },
      });
      const sourceLayer = makeTestLayer("SrcLayer", [inst]);
      const sourceLayout = makeTestLayout([sourceLayer]);

      const targetLayer = makeTestLayer("TgtLayer");
      const targetLayout = makeTestLayout([targetLayer], {
        items: [],
        subfolders: [],
      });

      return { inst, sourceLayout, targetLayout };
    }

    it("clones to target layer", () => {
      const { sourceLayout, targetLayout } = makeSourceAndTarget();
      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Hero",
        includeChildren: false,
        targetLayer: "TgtLayer",
        uidCounter: { next: 100 },
        sidGenerator: () => 999,
      });
      const tgt = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(tgt).to.have.lengthOf(1);
      expect(tgt[0].type).to.equal("Hero");
    });

    it("remaps UID with uidCounter", () => {
      const { sourceLayout, targetLayout } = makeSourceAndTarget();
      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Hero",
        includeChildren: false,
        targetLayer: "TgtLayer",
        uidCounter: { next: 42 },
        sidGenerator: () => 999,
      });
      const tgt = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(tgt[0].uid).to.equal(42);
    });

    it("generates new SID", () => {
      const { sourceLayout, targetLayout } = makeSourceAndTarget();
      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Hero",
        includeChildren: false,
        targetLayer: "TgtLayer",
        uidCounter: { next: 100 },
        sidGenerator: () => 777,
      });
      const tgt = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(tgt[0].sid).to.equal(777);
    });

    it("applies overrides (x, y, width, height, tags, opacity, initially-visible, instanceVariables)", () => {
      const { sourceLayout, targetLayout } = makeSourceAndTarget();
      const overrides: InstanceOverrides = {
        x: 10,
        y: 20,
        width: 50,
        height: 60,
        tags: "new-tag",
        opacity: 0.5,
        "initially-visible": false,
        instanceVariables: { hp: 200, mana: 50 },
      };
      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Hero",
        includeChildren: false,
        targetLayer: "TgtLayer",
        uidCounter: { next: 100 },
        sidGenerator: () => 999,
        overrides,
      });
      const copied = ((targetLayout.layers as LayerJson[])[0].instances as InstanceJson[])[0];
      const world = copied.world as Record<string, unknown>;
      expect(world.x).to.equal(10);
      expect(world.y).to.equal(20);
      expect(world.width).to.equal(50);
      expect(world.height).to.equal(60);
      expect(world.opacity).to.equal(0.5);
      expect(copied.tags).to.equal("new-tag");
      const props = copied.properties as Record<string, unknown>;
      expect(props["initially-visible"]).to.equal(false);
      const ivars = copied.instanceVariables as Record<string, unknown>;
      expect(ivars.hp).to.equal(200);
      expect(ivars.mana).to.equal(50);
    });

    it("source layout is unmodified", () => {
      const { inst, sourceLayout, targetLayout } = makeSourceAndTarget();
      const originalUid = inst.uid;
      const originalSid = inst.sid;
      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Hero",
        includeChildren: false,
        targetLayer: "TgtLayer",
        uidCounter: { next: 100 },
        sidGenerator: () => 999,
        overrides: { x: 9999 },
      });
      // Source instance should not be modified
      expect(inst.uid).to.equal(originalUid);
      expect(inst.sid).to.equal(originalSid);
      const world = inst.world as Record<string, unknown>;
      expect(world.x).to.equal(50);
    });

    it("adds SID to scene-graphs-folder-root.items", () => {
      const { sourceLayout, targetLayout } = makeSourceAndTarget();
      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Hero",
        includeChildren: false,
        targetLayer: "TgtLayer",
        uidCounter: { next: 100 },
        sidGenerator: () => 888,
      });
      const root = targetLayout["scene-graphs-folder-root"] as Record<string, unknown>;
      const items = root.items as Array<Record<string, unknown>>;
      expect(items).to.have.lengthOf(1);
      expect(items[0]).to.deep.equal({ sid: 888 });
    });
  });

  // ─── copyInstance (with children) ───

  describe("copyInstance (with children)", () => {
    function makeHierarchySource() {
      const parent = makeTestInstance(1, "Panel", {
        sid: 200,
        childUids: [2, 3],
      });
      const child1 = makeTestInstance(2, "Label", {
        sid: 201,
        parentUid: 1,
      });
      const child2 = makeTestInstance(3, "Icon", {
        sid: 202,
        parentUid: 1,
      });
      const srcLayer = makeTestLayer("Src", [parent, child1, child2]);
      const sourceLayout = makeTestLayout([srcLayer]);
      return { parent, child1, child2, sourceLayout };
    }

    it("copies parent + children", () => {
      const { sourceLayout } = makeHierarchySource();
      const tgtLayer = makeTestLayer("Tgt");
      const targetLayout = makeTestLayout([tgtLayer], {
        items: [],
        subfolders: [],
      });

      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Panel",
        includeChildren: true,
        targetLayer: "Tgt",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      // Parent + 2 children = 3 instances total on same layer
      expect(instances).to.have.lengthOf(3);
      const types = instances.map((i) => i.type);
      expect(types).to.include("Panel");
      expect(types).to.include("Label");
      expect(types).to.include("Icon");
    });

    it("remaps all UIDs (parent-uid, children[].uid)", () => {
      const { sourceLayout } = makeHierarchySource();
      const tgtLayer = makeTestLayer("Tgt");
      const targetLayout = makeTestLayout([tgtLayer], {
        items: [],
        subfolders: [],
      });

      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Panel",
        includeChildren: true,
        targetLayer: "Tgt",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      const panelCopy = instances.find((i) => i.type === "Panel")!;
      const labelCopy = instances.find((i) => i.type === "Label")!;
      const iconCopy = instances.find((i) => i.type === "Icon")!;

      // Parent gets UID 50 (first from counter)
      expect(panelCopy.uid).to.equal(50);
      // Children get UIDs 51 and 52
      expect(labelCopy.uid).to.equal(51);
      expect(iconCopy.uid).to.equal(52);

      // Children's parent-uid should point to new parent UID
      const labelSgd = labelCopy.sceneGraphData as Record<string, unknown>;
      expect(labelSgd["parent-uid"]).to.equal(50);
      const iconSgd = iconCopy.sceneGraphData as Record<string, unknown>;
      expect(iconSgd["parent-uid"]).to.equal(50);

      // Parent's children list should have new UIDs
      const panelSgd = panelCopy.sceneGraphData as Record<string, unknown>;
      const childRefs = panelSgd.children as Array<Record<string, unknown>>;
      const childRefUids = childRefs.map((c) => c.uid);
      expect(childRefUids).to.include(51);
      expect(childRefUids).to.include(52);
    });

    it("places children on childrenLayer if specified", () => {
      const { sourceLayout } = makeHierarchySource();
      const parentLayer = makeTestLayer("ParentLayer");
      const childLayer = makeTestLayer("ChildLayer");
      const targetLayout = makeTestLayout([parentLayer, childLayer], {
        items: [],
        subfolders: [],
      });

      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Panel",
        includeChildren: true,
        targetLayer: "ParentLayer",
        childrenLayer: "ChildLayer",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const parentInstances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      const childInstances = (targetLayout.layers as LayerJson[])[1].instances as InstanceJson[];
      expect(parentInstances).to.have.lengthOf(1);
      expect(parentInstances[0].type).to.equal("Panel");
      expect(childInstances).to.have.lengthOf(2);
    });

    it("places children on targetLayer if childrenLayer not specified", () => {
      const { sourceLayout } = makeHierarchySource();
      const tgtLayer = makeTestLayer("Tgt");
      const targetLayout = makeTestLayout([tgtLayer], {
        items: [],
        subfolders: [],
      });

      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Panel",
        includeChildren: true,
        targetLayer: "Tgt",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      // All 3 (parent + 2 children) on same layer
      expect(instances).to.have.lengthOf(3);
    });
  });

  // ─── copyInstance (child overrides) ───

  describe("copyInstance (child overrides)", () => {
    it("applies per-type overrides to matching children", () => {
      const parent = makeTestInstance(1, "Panel", {
        sid: 200,
        childUids: [2, 3],
      });
      const child1 = makeTestInstance(2, "Label", {
        sid: 201,
        parentUid: 1,
        world: { x: 0, y: 0, width: 100, height: 50, opacity: 1 },
      });
      const child2 = makeTestInstance(3, "Icon", {
        sid: 202,
        parentUid: 1,
        world: { x: 0, y: 0, width: 32, height: 32, opacity: 1 },
      });
      const srcLayer = makeTestLayer("Src", [parent, child1, child2]);
      const sourceLayout = makeTestLayout([srcLayer]);

      const tgtLayer = makeTestLayer("Tgt");
      const targetLayout = makeTestLayout([tgtLayer], {
        items: [],
        subfolders: [],
      });

      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Panel",
        includeChildren: true,
        targetLayer: "Tgt",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
        childOverrides: {
          Label: { x: 10, y: 20, tags: "label-tag" },
          Icon: { width: 64, height: 64, opacity: 0.5 },
        },
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      const labelCopy = instances.find((i) => i.type === "Label")!;
      const iconCopy = instances.find((i) => i.type === "Icon")!;

      const labelWorld = labelCopy.world as Record<string, unknown>;
      expect(labelWorld.x).to.equal(10);
      expect(labelWorld.y).to.equal(20);
      expect(labelCopy.tags).to.equal("label-tag");

      const iconWorld = iconCopy.world as Record<string, unknown>;
      expect(iconWorld.width).to.equal(64);
      expect(iconWorld.height).to.equal(64);
      expect(iconWorld.opacity).to.equal(0.5);
    });
  });

  // ─── copyInstance (errors) ───

  describe("copyInstance (errors)", () => {
    it("throws when instanceType not found in source layout", () => {
      const sourceLayout = makeTestLayout([makeTestLayer("L")]);
      const targetLayout = makeTestLayout([makeTestLayer("T")]);

      expect(() =>
        copyInstance({
          sourceLayout,
          targetLayout,
          instanceType: "NonExistent",
          includeChildren: false,
          targetLayer: "T",
          uidCounter: { next: 1 },
          sidGenerator: () => 1,
        }),
      ).to.throw('instance of type "NonExistent" not found in source layout');
    });

    it("throws when targetLayer not found in target layout", () => {
      const inst = makeTestInstance(1, "Sprite");
      const sourceLayout = makeTestLayout([makeTestLayer("Src", [inst])]);
      const targetLayout = makeTestLayout([makeTestLayer("Other")]);

      expect(() =>
        copyInstance({
          sourceLayout,
          targetLayout,
          instanceType: "Sprite",
          includeChildren: false,
          targetLayer: "MissingLayer",
          uidCounter: { next: 1 },
          sidGenerator: () => 1,
        }),
      ).to.throw('target layer "MissingLayer" not found in target layout');
    });
  });

  // ─── copyInstance (SID on instanceFolderItem) ───

  describe("copyInstance (instanceFolderItem SID)", () => {
    it("assigns new SID to instanceFolderItem when present", () => {
      const inst = makeTestInstance(10, "Widget", {
        sid: 500,
        instanceFolderItem: { sid: 500, name: "Widget" },
      });
      const sourceLayout = makeTestLayout([makeTestLayer("Src", [inst])]);
      const tgtLayer = makeTestLayer("Tgt");
      const targetLayout = makeTestLayout([tgtLayer], {
        items: [],
        subfolders: [],
      });

      copyInstance({
        sourceLayout,
        targetLayout,
        instanceType: "Widget",
        includeChildren: false,
        targetLayer: "Tgt",
        uidCounter: { next: 100 },
        sidGenerator: () => 555,
      });

      const copied = ((targetLayout.layers as LayerJson[])[0].instances as InstanceJson[])[0];
      const folderItem = copied.instanceFolderItem as Record<string, unknown>;
      expect(folderItem.sid).to.equal(555);
    });
  });

  // ─── buildTemplateBlock ───

  describe("buildTemplateBlock", () => {
    it("builds template block with mode='template' and templateName", () => {
      const inst = makeTestInstance(1, "Sprite", {
        properties: { "initially-visible": true },
      });
      const block = buildTemplateBlock(inst, "template", {
        templateName: "MyTemplate",
      });
      expect(block.mode).to.equal("template");
      expect(block.templateName).to.equal("MyTemplate");
      expect(block.sourceTemplateName).to.equal("");
      expect(block.replicaHierarchyInSyncWithTemplate).to.equal(false);
      expect(block.templatePropagateHierarchyChanges).to.equal(true);
      expect(block.replicaIgnoreTemplateHierarchyChanges).to.equal(false);
      expect(block.replicasUIDs).to.be.null;
    });

    it("builds template block with mode='replica' and sourceTemplateName", () => {
      const inst = makeTestInstance(1, "Sprite", {
        properties: { "initially-visible": true },
      });
      const block = buildTemplateBlock(inst, "replica", {
        sourceTemplateName: "SourceTemplate",
      });
      expect(block.mode).to.equal("replica");
      expect(block.templateName).to.equal("");
      expect(block.sourceTemplateName).to.equal("SourceTemplate");
      expect(block.replicaHierarchyInSyncWithTemplate).to.equal(true);
    });

    it("generates correct plugin component from instance properties", () => {
      const inst = makeTestInstance(1, "Sprite", {
        properties: {
          "initially-visible": true,
          "initial-animation": "idle",
          "initial-frame": 0,
        },
      });
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
      });
      const components = block.components as Array<Record<string, unknown>>;
      const plugin = components[0];
      expect(plugin.id).to.equal("plugin");
      const comp = plugin.component as Array<Record<string, unknown>>;
      expect(comp).to.have.lengthOf(1);
      expect(comp[0].key).to.equal("plugin");
      const state = comp[0].state as Array<[string, boolean]>;
      expect(state).to.deep.equal([
        ["initially-visible", true],
        ["initial-animation", true],
        ["initial-frame", true],
      ]);
    });

    it("generates correct instance-variable component", () => {
      const inst = makeTestInstance(1, "Sprite", {
        instanceVariables: { hp: 100, name: "hero" },
      });
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
      });
      const components = block.components as Array<Record<string, unknown>>;
      const iv = components[1];
      expect(iv.id).to.equal("instance-variable");
      const comp = iv.component as Array<Record<string, unknown>>;
      expect(comp).to.have.lengthOf(1);
      expect(comp[0].key).to.equal("instance-variable");
      const state = comp[0].state as Array<{ iv: string; state: boolean }>;
      expect(state).to.deep.equal([
        { iv: "hp", state: true },
        { iv: "name", state: true },
      ]);
    });

    it("generates correct behavior component with multiple behaviors", () => {
      const inst: InstanceJson = {
        ...makeTestInstance(1, "Sprite"),
        behaviors: {
          Timer: { properties: {} },
          Solid: { properties: { enabled: true, tags: "" } },
        },
      };
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
      });
      const components = block.components as Array<Record<string, unknown>>;
      const behavior = components[2];
      expect(behavior.id).to.equal("behavior");
      const comp = behavior.component as Array<Record<string, unknown>>;
      expect(comp).to.have.lengthOf(2);
      expect(comp[0].key).to.equal("Timer");
      expect(comp[0].state).to.deep.equal([]);
      expect(comp[1].key).to.equal("Solid");
      expect(comp[1].state).to.deep.equal([
        ["enabled", true],
        ["tags", true],
      ]);
    });

    it("generates correct effect component with parameters", () => {
      const inst: InstanceJson = {
        ...makeTestInstance(1, "Sprite"),
        effects: {
          Pixellate: {
            isEnabled: true,
            parameters: { size: 16 },
          },
        },
      };
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
      });
      const components = block.components as Array<Record<string, unknown>>;
      const effect = components[3];
      expect(effect.id).to.equal("effect");
      const comp = effect.component as Array<Record<string, unknown>>;
      expect(comp).to.have.lengthOf(1);
      expect(comp[0].key).to.equal("Pixellate");
      expect(comp[0].state).to.deep.equal([
        ["size", true],
        ["<<effect-template-enable>>", true],
      ]);
    });

    it("generates correct world-instance component with default inheritance", () => {
      const inst = makeTestInstance(1, "Sprite");
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
      });
      const components = block.components as Array<Record<string, unknown>>;
      const world = components[4];
      expect(world.id).to.equal("world-instance");
      const comp = world.component as Array<Record<string, unknown>>;
      expect(comp).to.have.lengthOf(1);
      expect(comp[0].key).to.equal("world-instance");
      const state = comp[0].state as Array<[string, boolean]>;
      // x and y default to false, everything else to true
      expect(state[0]).to.deep.equal(["x", false]);
      expect(state[1]).to.deep.equal(["y", false]);
      expect(state[2]).to.deep.equal(["z", true]);
      expect(state).to.have.lengthOf(19);
      // Verify all remaining keys are true
      for (let i = 2; i < state.length; i++) {
        expect(state[i][1]).to.equal(true, `expected ${state[i][0]} to be true`);
      }
    });

    it("applies inheritOverrides to world-instance keys", () => {
      const inst = makeTestInstance(1, "Sprite");
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
        inheritOverrides: { x: true, y: true, z: false },
      });
      const components = block.components as Array<Record<string, unknown>>;
      const world = components[4];
      const comp = world.component as Array<Record<string, unknown>>;
      const state = comp[0].state as Array<[string, boolean]>;
      expect(state[0]).to.deep.equal(["x", true]);
      expect(state[1]).to.deep.equal(["y", true]);
      expect(state[2]).to.deep.equal(["z", false]);
    });

    it("handles empty properties/instanceVariables/behaviors gracefully", () => {
      const inst: InstanceJson = {
        uid: 1,
        type: "Sprite",
        sid: 101,
        tags: "",
        properties: {},
        instanceVariables: {},
        world: { x: 0, y: 0, width: 100, height: 100, opacity: 1 },
        sceneGraphData: { uid: 1, "parent-uid": -1, children: [] },
      };
      const block = buildTemplateBlock(inst, "template", {
        templateName: "default",
      });
      const components = block.components as Array<Record<string, unknown>>;

      // Plugin: empty state array
      const plugin = components[0];
      const pluginComp = plugin.component as Array<Record<string, unknown>>;
      expect(pluginComp[0].state).to.deep.equal([]);

      // Instance-variable: empty state array
      const iv = components[1];
      const ivComp = iv.component as Array<Record<string, unknown>>;
      expect(ivComp[0].state).to.deep.equal([]);

      // Behavior: empty component array
      const behavior = components[2];
      expect(behavior.component).to.deep.equal([]);

      // Effect: empty component array
      const effect = components[3];
      expect(effect.component).to.deep.equal([]);

      // World-instance: always has 19 keys
      const world = components[4];
      const worldComp = world.component as Array<Record<string, unknown>>;
      expect((worldComp[0].state as unknown[]).length).to.equal(19);
    });
  });

  // ─── removeInstance ───

  describe("removeInstance", () => {
    it("removes root instance from its layer", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const other = makeTestInstance(2, "Text", { sid: 501 });
      const layer = makeTestLayer("UI", [inst, other]);
      const layout = makeTestLayout([layer], {
        items: [{ sid: 500 }, { sid: 501 }],
        subfolders: [],
      });

      removeInstance(layout, "Sprite");

      const instances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(instances).to.have.lengthOf(1);
      expect(instances[0].type).to.equal("Text");
    });

    it("removes root + children from different layers", () => {
      const parent = makeTestInstance(1, "Panel", {
        sid: 600,
        childUids: [2, 3],
      });
      const child1 = makeTestInstance(2, "Label", {
        sid: 601,
        parentUid: 1,
      });
      const child2 = makeTestInstance(3, "Icon", {
        sid: 602,
        parentUid: 1,
      });
      const layer1 = makeTestLayer("L1", [parent]);
      const layer2 = makeTestLayer("L2", [child1, child2]);
      const layout = makeTestLayout([layer1, layer2], {
        items: [{ sid: 600 }],
        subfolders: [],
      });

      removeInstance(layout, "Panel");

      const l1Instances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      const l2Instances = (layout.layers as LayerJson[])[1].instances as InstanceJson[];
      expect(l1Instances).to.have.lengthOf(0);
      expect(l2Instances).to.have.lengthOf(0);
    });

    it("removes SID from scene-graphs-folder-root.items", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 700 });
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer], {
        items: [{ sid: 700 }, { sid: 800 }],
        subfolders: [],
      });

      removeInstance(layout, "Sprite");

      const root = layout["scene-graphs-folder-root"] as Record<string, unknown>;
      const items = root.items as Array<Record<string, unknown>>;
      expect(items).to.have.lengthOf(1);
      expect(items[0].sid).to.equal(800);
    });

    it("throws when instance type not found", () => {
      const layout = makeTestLayout([makeTestLayer("UI")]);
      expect(() => removeInstance(layout, "NonExistent")).to.throw(
        'instance of type "NonExistent" not found in layout',
      );
    });

    it("does not affect other instances in the layout", () => {
      const inst1 = makeTestInstance(1, "Sprite", { sid: 500 });
      const inst2 = makeTestInstance(2, "Text", { sid: 501 });
      const inst3 = makeTestInstance(3, "Button", { sid: 502 });
      const layer = makeTestLayer("UI", [inst1, inst2, inst3]);
      const layout = makeTestLayout([layer], {
        items: [{ sid: 500 }, { sid: 501 }, { sid: 502 }],
        subfolders: [],
      });

      removeInstance(layout, "Text");

      const instances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(instances).to.have.lengthOf(2);
      expect(instances[0].type).to.equal("Sprite");
      expect(instances[1].type).to.equal("Button");

      const root = layout["scene-graphs-folder-root"] as Record<string, unknown>;
      const items = root.items as Array<Record<string, unknown>>;
      expect(items).to.have.lengthOf(2);
      expect(items[0].sid).to.equal(500);
      expect(items[1].sid).to.equal(502);
    });
  });

  // ─── removeInstance with layer filter ───

  describe("removeInstance with layer filter", () => {
    it("removes instance when on the specified layer", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const layer1 = makeTestLayer("Layer1", [inst]);
      const layer2 = makeTestLayer("Layer2");
      const layout = makeTestLayout([layer1, layer2], {
        items: [{ sid: 500 }],
        subfolders: [],
      });

      removeInstance(layout, "Sprite", "Layer1");

      const instances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(instances).to.have.lengthOf(0);
    });

    it("throws when instance is not on the specified layer", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const layer1 = makeTestLayer("Layer1", [inst]);
      const layer2 = makeTestLayer("Layer2");
      const layout = makeTestLayout([layer1, layer2], {
        items: [{ sid: 500 }],
        subfolders: [],
      });

      expect(() => removeInstance(layout, "Sprite", "Layer2")).to.throw(
        'instance of type "Sprite" is not on layer "Layer2"',
      );
    });

    it("throws when specified layer does not exist", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const layer1 = makeTestLayer("Layer1", [inst]);
      const layout = makeTestLayout([layer1], {
        items: [{ sid: 500 }],
        subfolders: [],
      });

      expect(() => removeInstance(layout, "Sprite", "Missing")).to.throw('layer "Missing" not found in layout');
    });

    it("still works without layer filter (backward compatible)", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer], {
        items: [{ sid: 500 }],
        subfolders: [],
      });

      removeInstance(layout, "Sprite");

      const instances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(instances).to.have.lengthOf(0);
    });
  });

  // ─── moveInstance ───

  describe("moveInstance", () => {
    it("moves instance to a different layer", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const layer1 = makeTestLayer("Source", [inst]);
      const layer2 = makeTestLayer("Target");
      const layout = makeTestLayout([layer1, layer2], {
        items: [{ sid: 500 }],
        subfolders: [],
      });

      moveInstance({
        layout,
        typeName: "Sprite",
        targetLayer: "Target",
        uidCounter: { next: 100 },
        sidGenerator: () => 999,
      });

      const srcInstances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      const tgtInstances = (layout.layers as LayerJson[])[1].instances as InstanceJson[];
      expect(srcInstances).to.have.lengthOf(0);
      expect(tgtInstances).to.have.lengthOf(1);
      expect(tgtInstances[0].type).to.equal("Sprite");
    });

    it("correctly removes original when target layer precedes source", () => {
      // This tests the critical bug: if targetLayer comes first in layer order,
      // a naive type-based removal would remove the copy instead of the original.
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const targetLayer = makeTestLayer("Target"); // first in array
      const sourceLayer = makeTestLayer("Source", [inst]); // second in array
      const layout = makeTestLayout([targetLayer, sourceLayer], {
        items: [{ sid: 500 }],
        subfolders: [],
      });

      moveInstance({
        layout,
        typeName: "Sprite",
        targetLayer: "Target",
        uidCounter: { next: 100 },
        sidGenerator: () => 999,
      });

      const tgtInstances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      const srcInstances = (layout.layers as LayerJson[])[1].instances as InstanceJson[];
      expect(srcInstances).to.have.lengthOf(0);
      expect(tgtInstances).to.have.lengthOf(1);
      expect(tgtInstances[0].type).to.equal("Sprite");
      expect(tgtInstances[0].uid).to.equal(100); // new UID from copy
    });

    it("moves instance with children", () => {
      const parent = makeTestInstance(1, "Panel", {
        sid: 600,
        childUids: [2],
      });
      const child = makeTestInstance(2, "Label", {
        sid: 601,
        parentUid: 1,
      });
      const layer1 = makeTestLayer("Source", [parent, child]);
      const layer2 = makeTestLayer("Target");
      const layout = makeTestLayout([layer1, layer2], {
        items: [{ sid: 600 }],
        subfolders: [],
      });

      moveInstance({
        layout,
        typeName: "Panel",
        targetLayer: "Target",
        uidCounter: { next: 100 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const srcInstances = (layout.layers as LayerJson[])[0].instances as InstanceJson[];
      const tgtInstances = (layout.layers as LayerJson[])[1].instances as InstanceJson[];
      expect(srcInstances).to.have.lengthOf(0);
      expect(tgtInstances).to.have.lengthOf(2);
    });

    it("removes original SID from scene-graphs-folder-root", () => {
      const inst = makeTestInstance(1, "Sprite", { sid: 500 });
      const layer1 = makeTestLayer("Source", [inst]);
      const layer2 = makeTestLayer("Target");
      const layout = makeTestLayout([layer1, layer2], {
        items: [{ sid: 500 }, { sid: 800 }],
        subfolders: [],
      });

      moveInstance({
        layout,
        typeName: "Sprite",
        targetLayer: "Target",
        uidCounter: { next: 100 },
        sidGenerator: () => 999,
      });

      const root = layout["scene-graphs-folder-root"] as Record<string, unknown>;
      const items = root.items as Array<Record<string, unknown>>;
      // Original SID 500 removed, new SID 999 added by copyInstance
      expect(items).to.have.lengthOf(2);
      expect(items.find((i) => i.sid === 500)).to.be.undefined;
      expect(items.find((i) => i.sid === 999)).to.not.be.undefined;
      expect(items.find((i) => i.sid === 800)).to.not.be.undefined;
    });

    it("throws when instance not found", () => {
      const layout = makeTestLayout([makeTestLayer("L")]);
      expect(() =>
        moveInstance({
          layout,
          typeName: "NonExistent",
          targetLayer: "L",
          uidCounter: { next: 1 },
          sidGenerator: () => 1,
        }),
      ).to.throw('instance of type "NonExistent" not found in layout');
    });
  });

  // ─── templatize ───

  describe("templatize", () => {
    it("adds template block to existing instance", () => {
      const inst = makeTestInstance(1, "MySprite", {
        properties: { "initially-visible": true },
        instanceVariables: { hp: 100 },
      });
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer]);

      templatize(layout, "MySprite", "MyTemplate");

      expect(inst.template).to.not.be.undefined;
      const tmpl = inst.template as Record<string, unknown>;
      expect(tmpl.mode).to.equal("template");
      expect(tmpl.templateName).to.equal("MyTemplate");
      expect(tmpl.sourceTemplateName).to.equal("");
    });

    it("passes inheritOverrides to buildTemplateBlock", () => {
      const inst = makeTestInstance(1, "MySprite");
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer]);

      templatize(layout, "MySprite", "MyTemplate", { x: true, y: true });

      const tmpl = inst.template as Record<string, unknown>;
      const components = tmpl.components as Array<Record<string, unknown>>;
      const world = components[4];
      const comp = world.component as Array<Record<string, unknown>>;
      const state = comp[0].state as Array<[string, boolean]>;
      expect(state[0]).to.deep.equal(["x", true]);
      expect(state[1]).to.deep.equal(["y", true]);
    });

    it("throws when instance not found", () => {
      const layout = makeTestLayout([makeTestLayer("UI")]);
      expect(() => templatize(layout, "NonExistent", "T")).to.throw(
        'instance of type "NonExistent" not found in layout',
      );
    });
  });

  // ─── replicify ───

  describe("replicify", () => {
    it("adds replica template block to existing instance", () => {
      const inst = makeTestInstance(1, "MySprite", {
        properties: { "initially-visible": true },
        instanceVariables: { hp: 100 },
      });
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer]);

      replicify(layout, "MySprite", "SourceTemplate");

      expect(inst.template).to.not.be.undefined;
      const tmpl = inst.template as Record<string, unknown>;
      expect(tmpl.mode).to.equal("replica");
      expect(tmpl.templateName).to.equal("");
      expect(tmpl.sourceTemplateName).to.equal("SourceTemplate");
      expect(tmpl.replicaHierarchyInSyncWithTemplate).to.equal(true);
    });

    it("passes inheritOverrides", () => {
      const inst = makeTestInstance(1, "MySprite");
      const layer = makeTestLayer("UI", [inst]);
      const layout = makeTestLayout([layer]);

      replicify(layout, "MySprite", "SourceTemplate", { x: true, y: true });

      const tmpl = inst.template as Record<string, unknown>;
      const components = tmpl.components as Array<Record<string, unknown>>;
      const world = components[4];
      const comp = world.component as Array<Record<string, unknown>>;
      const state = comp[0].state as Array<[string, boolean]>;
      expect(state[0]).to.deep.equal(["x", true]);
      expect(state[1]).to.deep.equal(["y", true]);
    });

    it("throws when instance not found", () => {
      const layout = makeTestLayout([makeTestLayer("UI")]);
      expect(() => replicify(layout, "NonExistent", "T")).to.throw(
        'instance of type "NonExistent" not found in layout',
      );
    });
  });

  // ─── renameLayer ───

  describe("renameLayer", () => {
    it("renames a top-level layer", () => {
      const layer = makeTestLayer("OldName");
      const layout = makeTestLayout([layer]);

      renameLayer(layout, "OldName", "NewName");

      expect(layer.name).to.equal("NewName");
    });

    it("renames a sublayer", () => {
      const sub = makeTestLayer("OldSub");
      const parent = makeTestLayer("Parent", [], [sub]);
      const layout = makeTestLayout([parent]);

      renameLayer(layout, "OldSub", "NewSub");

      expect(sub.name).to.equal("NewSub");
    });

    it("throws when layer not found", () => {
      const layout = makeTestLayout([makeTestLayer("UI")]);
      expect(() => renameLayer(layout, "NonExistent", "New")).to.throw('layer "NonExistent" not found in layout');
    });
  });

  // ─── addReplica ───

  describe("addReplica", () => {
    function makeTemplateSource() {
      const root = makeTestInstance(1, "UI_Button", {
        sid: 300,
        childUids: [2],
        properties: { "initially-visible": true },
        instanceVariables: { label: "Click" },
      });
      // Add template block to root
      root.template = {
        mode: "template",
        templateName: "UI_Button",
        sourceTemplateName: "",
        replicaHierarchyInSyncWithTemplate: false,
        templatePropagateHierarchyChanges: true,
        replicaIgnoreTemplateHierarchyChanges: false,
        components: [],
        replicasUIDs: null,
      };
      const child = makeTestInstance(2, "UI_ButtonText", {
        sid: 301,
        parentUid: 1,
      });
      const layer = makeTestLayer("Templates", [root, child]);
      return makeTestLayout([layer], { items: [{ sid: 300 }], subfolders: [] });
    }

    it("copies template hierarchy as a replica", () => {
      const sourceLayout = makeTemplateSource();
      const tgtLayer = makeTestLayer("UI");
      const targetLayout = makeTestLayout([tgtLayer], { items: [], subfolders: [] });

      addReplica({
        sourceLayout,
        sourceTemplateName: "UI_Button",
        targetLayout,
        targetLayer: "UI",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      expect(instances).to.have.lengthOf(2); // root + child
      const rootCopy = instances.find((i) => i.type === "UI_Button")!;
      expect(rootCopy).to.not.be.undefined;
      expect(rootCopy.uid).to.equal(50);
    });

    it("sets replica template block on copied root", () => {
      const sourceLayout = makeTemplateSource();
      const tgtLayer = makeTestLayer("UI");
      const targetLayout = makeTestLayout([tgtLayer], { items: [], subfolders: [] });

      addReplica({
        sourceLayout,
        sourceTemplateName: "UI_Button",
        targetLayout,
        targetLayer: "UI",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      const rootCopy = instances.find((i) => i.type === "UI_Button")!;
      const tmpl = rootCopy.template as Record<string, unknown>;
      expect(tmpl.mode).to.equal("replica");
      expect(tmpl.sourceTemplateName).to.equal("UI_Button");
      expect(tmpl.templateName).to.equal("");
    });

    it("throws when template not found in source", () => {
      const sourceLayout = makeTestLayout([makeTestLayer("L")]);
      const targetLayout = makeTestLayout([makeTestLayer("T")], { items: [], subfolders: [] });

      expect(() =>
        addReplica({
          sourceLayout,
          sourceTemplateName: "NonExistent",
          targetLayout,
          targetLayer: "T",
          uidCounter: { next: 1 },
          sidGenerator: () => 1,
        }),
      ).to.throw('template "NonExistent" not found in source layout');
    });

    it("applies overrides to the replica root", () => {
      const sourceLayout = makeTemplateSource();
      const tgtLayer = makeTestLayer("UI");
      const targetLayout = makeTestLayout([tgtLayer], { items: [], subfolders: [] });

      addReplica({
        sourceLayout,
        sourceTemplateName: "UI_Button",
        targetLayout,
        targetLayer: "UI",
        uidCounter: { next: 50 },
        sidGenerator: (() => {
          let n = 900;
          return () => n++;
        })(),
        overrides: { x: 100, y: 200 },
      });

      const instances = (targetLayout.layers as LayerJson[])[0].instances as InstanceJson[];
      const rootCopy = instances.find((i) => i.type === "UI_Button")!;
      const world = rootCopy.world as Record<string, unknown>;
      expect(world.x).to.equal(100);
      expect(world.y).to.equal(200);
    });
  });

  describe("removeLayer", () => {
    it("removes an empty root layer", () => {
      const layout = {
        layers: [makeTestLayer("Layer1"), makeTestLayer("Layer2")],
      };
      removeLayer(layout as LayoutJson, "Layer1");
      expect(layout.layers).to.have.length(1);
      expect((layout.layers[0] as LayerJson).name).to.equal("Layer2");
    });

    it("removes an empty sublayer", () => {
      const layout = {
        layers: [makeTestLayer("Parent", [], [makeTestLayer("Child")])],
      };
      removeLayer(layout as LayoutJson, "Child");
      expect((layout.layers[0] as LayerJson).subLayers as unknown[]).to.have.length(0);
    });

    it("throws if layer not found", () => {
      const layout = { layers: [makeTestLayer("Layer1")] };
      expect(() => removeLayer(layout as LayoutJson, "Missing")).to.throw("not found");
    });

    it("throws if layer has instances", () => {
      const layout = {
        layers: [makeTestLayer("Layer1", [{ uid: 1 }])],
      };
      expect(() => removeLayer(layout as LayoutJson, "Layer1")).to.throw("has 1 instance(s)");
    });

    it("throws if layer has sublayers", () => {
      const layout = {
        layers: [makeTestLayer("Layer1", [], [makeTestLayer("Sub")])],
      };
      expect(() => removeLayer(layout as LayoutJson, "Layer1")).to.throw("has 1 sublayer(s)");
    });
  });
});
