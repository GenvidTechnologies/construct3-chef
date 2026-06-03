import { describe, it } from "mocha";
import { expect } from "chai";

import { expandWorkflows, type LoadLayout } from "../../src/c3/workflowExpansion.js";
import type { LayoutJson, LayerJson, InstanceJson } from "../../src/c3/layoutMutator.js";
import type { Recipe } from "../../src/c3/recipeInterpreter.js";
import { makeTestInstance, makeTestLayer, makeTestLayout } from "./helpers/layoutFixtures.js";

// Local aliases keep call sites concise; the shared helpers do the heavy lifting.
const makeInstance = (uid: number, type: string, opts?: { world?: Record<string, unknown> }): InstanceJson =>
  makeTestInstance(uid, type, opts);
const makeLayer = (name: string, instances?: InstanceJson[]): LayerJson => makeTestLayer(name, instances);
const makeLayout = (layers: LayerJson[]): LayoutJson => makeTestLayout(layers, { items: [] });

const neverLoad: LoadLayout = (p) => {
  throw new Error(`unexpected loadLayout call for "${p}"`);
};

describe("expandWorkflows", () => {
  it("passes primitive ops through unchanged", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/Game.json": [
          { op: "add-layer", name: "Top" },
          { op: "remove-layer", layer: "Old" },
        ],
      },
    } as unknown as Recipe;
    const map = expandWorkflows(recipe, neverLoad);
    expect([...map.keys()]).to.deep.equal(["layouts/Game.json"]);
    expect(map.get("layouts/Game.json")).to.deep.equal([
      { op: "add-layer", name: "Top" },
      { op: "remove-layer", layer: "Old" },
    ]);
  });

  it("returns an empty map for a recipe with no layouts section", () => {
    const recipe: Recipe = {} as unknown as Recipe;
    const map = expandWorkflows(recipe, neverLoad);
    expect(map.size).to.equal(0);
  });

  describe("extract-template", () => {
    it("emits copy-instance + templatize on templatesLayout and replicify on sourceLayout", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/UI/Templates.json": [
            {
              op: "extract-template",
              sourceLayout: "layouts/Shop.json",
              sourceType: "IconContainerWithAmount",
              templateName: "IconContainerWithAmount",
              templatesLayer: "Layer 0",
            },
          ],
        },
      } as unknown as Recipe;
      const map = expandWorkflows(recipe, neverLoad);

      // Both layout keys are present.
      expect([...map.keys()].sort()).to.deep.equal(["layouts/Shop.json", "layouts/UI/Templates.json"].sort());

      const onTemplates = map.get("layouts/UI/Templates.json")!;
      expect(onTemplates).to.have.lengthOf(2);
      expect(onTemplates[0]).to.deep.equal({
        op: "copy-instance",
        from: "layouts/Shop.json",
        type: "IconContainerWithAmount",
        includeChildren: true, // default
        targetLayer: "Layer 0",
        childrenLayer: undefined,
      });
      expect(onTemplates[1]).to.deep.equal({
        op: "templatize",
        type: "IconContainerWithAmount",
        templateName: "IconContainerWithAmount",
        inheritOverrides: undefined,
      });

      const onSource = map.get("layouts/Shop.json")!;
      expect(onSource).to.deep.equal([
        {
          op: "replicify",
          type: "IconContainerWithAmount",
          sourceTemplateName: "IconContainerWithAmount",
          inheritOverrides: undefined,
        },
      ]);
    });

    it("honors includeChildren=false and forwards childrenLayer + inheritOverrides", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "extract-template",
              sourceLayout: "layouts/Game.json",
              sourceType: "Hero",
              templateName: "Hero",
              templatesLayer: "Tpl",
              includeChildren: false,
              childrenLayer: "TplChildren",
              inheritOverrides: { x: false, y: false },
            },
          ],
        },
      } as unknown as Recipe;
      const map = expandWorkflows(recipe, neverLoad);
      const onTemplates = map.get("layouts/Templates.json")!;
      expect((onTemplates[0] as { includeChildren: boolean }).includeChildren).to.equal(false);
      expect((onTemplates[0] as { childrenLayer: string }).childrenLayer).to.equal("TplChildren");
      expect((onTemplates[1] as { inheritOverrides: unknown }).inheritOverrides).to.deep.equal({
        x: false,
        y: false,
      });
      const onSource = map.get("layouts/Game.json")!;
      expect((onSource[0] as { inheritOverrides: unknown }).inheritOverrides).to.deep.equal({
        x: false,
        y: false,
      });
    });

    it("does not call loadLayout", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "extract-template",
              sourceLayout: "layouts/Shop.json",
              sourceType: "X",
              templateName: "X",
              templatesLayer: "L",
            },
          ],
        },
      } as unknown as Recipe;
      // neverLoad throws if called; if expansion succeeds, loadLayout was not used.
      expandWorkflows(recipe, neverLoad);
    });
  });

  describe("templatize-in-place", () => {
    it("expands to a single templatize op on the same layout", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "templatize-in-place",
              type: "Hero",
              templateName: "Hero",
              inheritOverrides: { x: true },
            },
          ],
        },
      } as unknown as Recipe;
      const map = expandWorkflows(recipe, neverLoad);
      expect([...map.keys()]).to.deep.equal(["layouts/Game.json"]);
      expect(map.get("layouts/Game.json")).to.deep.equal([
        {
          op: "templatize",
          type: "Hero",
          templateName: "Hero",
          inheritOverrides: { x: true },
        },
      ]);
    });
  });

  describe("clone-replica-to-layouts", () => {
    it("fans out one add-replica per target; the templates layout key is omitted when it gets no primitives", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "clone-replica-to-layouts",
              templateName: "Icon",
              sourceType: "Icon",
              targets: [
                { layout: "layouts/A.json", layer: "L1" },
                { layout: "layouts/B.json", layer: "L2", childrenLayer: "BChildren", overrides: { x: 10 } },
              ],
            },
          ],
        },
      } as unknown as Recipe;
      const map = expandWorkflows(recipe, neverLoad);
      // Templates layout is NOT in the map — no primitives target it, so the
      // applier won't pointlessly read+write an unchanged file.
      expect([...map.keys()].sort()).to.deep.equal(["layouts/A.json", "layouts/B.json"]);
      expect(map.has("layouts/Templates.json")).to.equal(false);
      expect(map.get("layouts/A.json")).to.deep.equal([
        {
          op: "add-replica",
          from: "layouts/Templates.json",
          sourceTemplateName: "Icon",
          targetLayer: "L1",
          childrenLayer: undefined,
          overrides: undefined,
          childOverrides: undefined,
          inheritOverrides: undefined,
        },
      ]);
      expect(map.get("layouts/B.json")).to.deep.equal([
        {
          op: "add-replica",
          from: "layouts/Templates.json",
          sourceTemplateName: "Icon",
          targetLayer: "L2",
          childrenLayer: "BChildren",
          overrides: { x: 10 },
          childOverrides: undefined,
          inheritOverrides: undefined,
        },
      ]);
    });

    it("allows a target whose layout equals the templates layout (same-layout replica)", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Templates.json": [
            {
              op: "clone-replica-to-layouts",
              templateName: "T",
              sourceType: "T",
              targets: [{ layout: "layouts/Templates.json", layer: "L" }],
            },
          ],
        },
      } as unknown as Recipe;
      const map = expandWorkflows(recipe, neverLoad);
      // Single key — pre-seeded as empty, then the add-replica appended.
      expect([...map.keys()]).to.deep.equal(["layouts/Templates.json"]);
      expect(map.get("layouts/Templates.json")).to.have.lengthOf(1);
    });
  });

  describe("replace-instance-with-replica", () => {
    function fakeSourceLayout(): LayoutJson {
      const inst = makeInstance(7, "Hero", { world: { x: 42, y: 96, width: 64, height: 64, opacity: 0.75 } });
      return makeLayout([makeLayer("Gameplay", [inst])]);
    }

    it("captures world props from the source instance and emits remove + add-replica", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "Hero",
              templatesLayout: "layouts/Templates.json",
              templateName: "Hero",
            },
          ],
        },
      } as unknown as Recipe;

      const loaded: string[] = [];
      const loadLayout: LoadLayout = (p) => {
        loaded.push(p);
        return fakeSourceLayout();
      };

      const map = expandWorkflows(recipe, loadLayout);
      expect(loaded).to.deep.equal(["layouts/Game.json"]);
      expect([...map.keys()]).to.deep.equal(["layouts/Game.json"]);

      const ops = map.get("layouts/Game.json")!;
      expect(ops).to.have.lengthOf(2);
      expect(ops[0]).to.deep.equal({ op: "remove-instance", type: "Hero", layer: undefined });
      expect(ops[1]).to.deep.equal({
        op: "add-replica",
        from: "layouts/Templates.json",
        sourceTemplateName: "Hero",
        targetLayer: "Gameplay", // pulled from the captured layerName, not provided in the op
        // No children in the fixture, so childrenLayer is undefined and addReplica's "children share root layer" default applies.
        childrenLayer: undefined,
        overrides: { x: 42, y: 96, width: 64, height: 64, opacity: 0.75 },
        inheritOverrides: undefined,
      });
    });

    it("forwards childrenLayerName to add-replica so the replica's children land on the original children-layer", () => {
      // Original layout: Hero root on "Gameplay", with two children on "HUD".
      function layoutWithChildrenOnDifferentLayer(): LayoutJson {
        const root = makeInstance(20, "Hero", { world: { x: 1, y: 2, width: 3, height: 4, opacity: 1 } });
        (root.sceneGraphData as Record<string, unknown>).children = [{ uid: 21 }, { uid: 22 }];
        const c1 = makeInstance(21, "HpBar");
        (c1.sceneGraphData as Record<string, unknown>)["parent-uid"] = 20;
        const c2 = makeInstance(22, "Shadow");
        (c2.sceneGraphData as Record<string, unknown>)["parent-uid"] = 20;
        return makeLayout([makeLayer("Gameplay", [root]), makeLayer("HUD", [c1, c2])]);
      }
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "Hero",
              templatesLayout: "layouts/Templates.json",
              templateName: "Hero",
            },
          ],
        },
      } as unknown as Recipe;
      const ops = expandWorkflows(recipe, () => layoutWithChildrenOnDifferentLayer()).get("layouts/Game.json")!;
      expect((ops[1] as { targetLayer: string }).targetLayer).to.equal("Gameplay");
      expect((ops[1] as { childrenLayer: string | undefined }).childrenLayer).to.equal("HUD");
    });

    it("forwards the explicit layer to remove-instance and uses the captured layerName for add-replica", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "Hero",
              templatesLayout: "layouts/Templates.json",
              templateName: "Hero",
              layer: "Gameplay",
            },
          ],
        },
      } as unknown as Recipe;
      const loadLayout: LoadLayout = () => fakeSourceLayout();
      const ops = expandWorkflows(recipe, loadLayout).get("layouts/Game.json")!;
      expect((ops[0] as { layer: string }).layer).to.equal("Gameplay");
      expect((ops[1] as { targetLayer: string }).targetLayer).to.equal("Gameplay");
    });

    it("throws when the source instance is not found", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "Ghost",
              templatesLayout: "layouts/Templates.json",
              templateName: "Ghost",
            },
          ],
        },
      } as unknown as Recipe;
      const loadLayout: LoadLayout = () => fakeSourceLayout();
      expect(() => expandWorkflows(recipe, loadLayout)).to.throw(/instance of type "Ghost".*not found/);
    });

    it("throws when the layer filter excludes the instance", () => {
      const recipe: Recipe = {
        layouts: {
          "layouts/Game.json": [
            {
              op: "replace-instance-with-replica",
              type: "Hero",
              templatesLayout: "layouts/Templates.json",
              templateName: "Hero",
              layer: "WrongLayer",
            },
          ],
        },
      } as unknown as Recipe;
      const loadLayout: LoadLayout = () => fakeSourceLayout();
      expect(() => expandWorkflows(recipe, loadLayout)).to.throw(/on layer "WrongLayer".*not found/);
    });
  });

  it("preserves declaration order across mixed primitive + workflow ops within a single layout", () => {
    const recipe: Recipe = {
      layouts: {
        "layouts/UI/Templates.json": [
          { op: "add-layer", name: "First" },
          {
            op: "extract-template",
            sourceLayout: "layouts/Shop.json",
            sourceType: "X",
            templateName: "X",
            templatesLayer: "L",
          },
          { op: "add-layer", name: "Last" },
        ],
      },
    } as unknown as Recipe;
    const map = expandWorkflows(recipe, neverLoad);
    const onTemplates = map.get("layouts/UI/Templates.json")!;
    expect(onTemplates.map((o) => o.op)).to.deep.equal(["add-layer", "copy-instance", "templatize", "add-layer"]);
    // The source-layout replicify lives on its own key.
    expect(map.get("layouts/Shop.json")).to.have.lengthOf(1);
    expect(map.get("layouts/Shop.json")![0].op).to.equal("replicify");
  });
});
