// Composite workflow op expansion.
//
// Workflow ops (extract-template, templatize-in-place, clone-replica-to-layouts,
// replace-instance-with-replica) bundle a common multi-step template pattern
// into a single declarative entry. Some fan out across multiple layout keys
// (e.g. extract-template emits copy-instance + templatize on the templates
// layout AND replicify on the source layout). This module performs that fan-out
// once, before the applyRecipeInner layout-file loop runs, producing a
// `Map<layoutPath, LayoutOp[]>` that the loop iterates instead of
// `recipe.layouts` directly.
//
// Primitive layout ops pass through unchanged. The only stateful concern is
// `replace-instance-with-replica`, which must snapshot the existing instance's
// world props before the apply loop removes it — that's what `loadLayout` is
// for. The applier wires it to the same `sourceLayoutCache` the primitive
// `copy-instance` / `add-replica` ops already share.

import type {
  PrimitiveLayoutOp,
  Recipe,
  ExtractTemplateOp,
  TemplatizeInPlaceOp,
  CloneReplicaToLayoutsOp,
  ReplaceInstanceWithReplicaOp,
} from "./recipeInterpreter.js";
import type { LayoutJson, InstanceOverrides } from "./layoutMutator.js";
import { readInstanceWorld } from "./layoutMutator.js";

/**
 * Read a layout JSON from a path relative to the recipe's project root. The
 * applier wires this to its `sourceLayoutCache` so expander reads share the
 * cache with the primitive `copy-instance` / `add-replica` reads.
 */
export type LoadLayout = (layoutPath: string) => LayoutJson;

/**
 * Expand composite workflow ops into primitive layout ops, fanning out across
 * layout keys as needed. The returned Map is keyed by layout path with
 * insertion order preserved (so the applier processes layouts in
 * workflow-declaration order). Primitive ops in the input pass through.
 *
 * `loadLayout` is only called for workflows that need to read source-layout
 * state at expansion time — currently just `replace-instance-with-replica`.
 *
 * Throws when a workflow's expansion can't be completed (e.g. the source
 * instance for `replace-instance-with-replica` is not found). Validation
 * (required fields, duplicate target layouts, etc.) is done earlier by
 * `validateRecipe()`; the errors thrown here are apply-time runtime errors
 * surfaced eagerly so dry-run sees them too.
 */
export function expandWorkflows(recipe: Recipe, loadLayout: LoadLayout): Map<string, PrimitiveLayoutOp[]> {
  const result = new Map<string, PrimitiveLayoutOp[]>();

  function emit(layoutPath: string, op: PrimitiveLayoutOp): void {
    let list = result.get(layoutPath);
    if (!list) {
      list = [];
      result.set(layoutPath, list);
    }
    list.push(op);
  }

  if (!recipe.layouts) return result;

  for (const [layoutPath, ops] of Object.entries(recipe.layouts)) {
    for (const op of ops) {
      switch (op.op) {
        case "extract-template":
          expandExtractTemplate(op, layoutPath, emit);
          break;
        case "templatize-in-place":
          expandTemplatizeInPlace(op, layoutPath, emit);
          break;
        case "clone-replica-to-layouts":
          expandCloneReplicaToLayouts(op, layoutPath, emit);
          break;
        case "replace-instance-with-replica":
          expandReplaceInstanceWithReplica(op, layoutPath, emit, loadLayout);
          break;
        default:
          // Primitive op — pass through unchanged.
          emit(layoutPath, op);
      }
    }
  }

  return result;
}

function expandExtractTemplate(
  op: ExtractTemplateOp,
  templatesLayout: string,
  emit: (layoutPath: string, op: PrimitiveLayoutOp) => void,
): void {
  const includeChildren = op.includeChildren ?? true;
  // 1. Clone the source instance + children into the templates layout.
  emit(templatesLayout, {
    op: "copy-instance",
    from: op.sourceLayout,
    type: op.sourceType,
    includeChildren,
    targetLayer: op.templatesLayer,
    childrenLayer: op.childrenLayer,
  });
  // 2. Convert the just-copied instance into a master template.
  emit(templatesLayout, {
    op: "templatize",
    type: op.sourceType,
    templateName: op.templateName,
    inheritOverrides: op.inheritOverrides,
  });
  // 3. Convert the original on the source layout into a replica of (2).
  emit(op.sourceLayout, {
    op: "replicify",
    type: op.sourceType,
    sourceTemplateName: op.templateName,
    inheritOverrides: op.inheritOverrides,
  });
}

function expandTemplatizeInPlace(
  op: TemplatizeInPlaceOp,
  layoutPath: string,
  emit: (layoutPath: string, op: PrimitiveLayoutOp) => void,
): void {
  // One-to-one expansion. The workflow exists as a named entry point so the
  // "convert this instance into the master template for runtime-spawned
  // replicas" use case is discoverable from list-tools and recipe-reference.md
  // without an agent having to guess that templatize alone does the job.
  emit(layoutPath, {
    op: "templatize",
    type: op.type,
    templateName: op.templateName,
    inheritOverrides: op.inheritOverrides,
  });
}

function expandCloneReplicaToLayouts(
  op: CloneReplicaToLayoutsOp,
  templatesLayout: string,
  emit: (layoutPath: string, op: PrimitiveLayoutOp) => void,
): void {
  // One add-replica per target. The workflow's primary key (templatesLayout)
  // receives zero new ops — it's the source. validateRecipe already rejected
  // duplicate target layouts, so each emit lands on a distinct key.
  for (const target of op.targets) {
    emit(target.layout, {
      op: "add-replica",
      from: templatesLayout,
      sourceTemplateName: op.templateName,
      targetLayer: target.layer,
      childrenLayer: target.childrenLayer,
      overrides: target.overrides,
      childOverrides: target.childOverrides,
      inheritOverrides: target.inheritOverrides,
    });
  }
}

function expandReplaceInstanceWithReplica(
  op: ReplaceInstanceWithReplicaOp,
  layoutPath: string,
  emit: (layoutPath: string, op: PrimitiveLayoutOp) => void,
  loadLayout: LoadLayout,
): void {
  // Snapshot the existing instance's layer + world props before remove so the
  // new replica lands in the same spot. instanceVariables and tags are NOT
  // carried over — a replica is a fresh instance of the template (see
  // initiative plan: open items).
  const layout = loadLayout(layoutPath);
  const snap = readInstanceWorld(layout, op.type, op.layer);
  if (!snap) {
    throw new Error(
      `replace-instance-with-replica: instance of type "${op.type}" ` +
        (op.layer ? `on layer "${op.layer}" ` : "") +
        `not found in ${layoutPath}`,
    );
  }
  const overrides: InstanceOverrides = {};
  const world = snap.world;
  if (typeof world.x === "number") overrides.x = world.x;
  if (typeof world.y === "number") overrides.y = world.y;
  if (typeof world.width === "number") overrides.width = world.width;
  if (typeof world.height === "number") overrides.height = world.height;
  if (typeof world.opacity === "number") overrides.opacity = world.opacity;

  emit(layoutPath, { op: "remove-instance", type: op.type, layer: op.layer });
  emit(layoutPath, {
    op: "add-replica",
    from: op.templatesLayout,
    sourceTemplateName: op.templateName,
    targetLayer: snap.layerName,
    // Preserve the original children-layer placement. When children spanned
    // multiple layers (rare) snap.childrenLayerName is undefined and
    // addReplica falls back to placing children on targetLayer — same as the
    // pre-fix behavior.
    childrenLayer: snap.childrenLayerName,
    overrides,
    inheritOverrides: op.inheritOverrides,
  });
}
