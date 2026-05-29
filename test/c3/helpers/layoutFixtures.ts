// Shared test fixtures for layout-related tests.
//
// Three test files (layoutMutator, workflowExpansion, extractTemplateIntegration)
// were each carrying their own makeInstance/makeLayer/makeLayout helpers with
// slightly different signatures. This module unifies them on the
// options-object form so a schema change touches one place.

import type { LayoutJson, LayerJson, InstanceJson } from "../../../src/c3/layoutMutator.js";

export function makeTestLayer(name: string, instances?: unknown[], subLayers?: unknown[]): LayerJson {
  return {
    name,
    instances: instances ?? [],
    subLayers: subLayers ?? [],
    sid: 0,
  } as LayerJson;
}

export function makeTestLayout(layers: LayerJson[], sceneGraphRoot?: unknown): LayoutJson {
  const layout: LayoutJson = { layers };
  if (sceneGraphRoot !== undefined) {
    layout["scene-graphs-folder-root"] = sceneGraphRoot;
  }
  return layout;
}

export function makeTestInstance(
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
