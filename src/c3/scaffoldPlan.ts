/**
 * Shared plan/write split for both scaffold surfaces (`scaffold-layout` and
 * `scaffold-sprite`, CLI and MCP), so their validation and messages are
 * byte-identical. This resolves the shared-orchestrator alternative ADR
 * `wiki/decisions/0044` deferred; see issue #259.
 *
 * The `plan*` functions are read-only: they validate, check for conflicts and
 * build the cloned JSON, but never write. The `write*` primitives perform the
 * writes for an `ok` plan.
 *
 * Off-barrel deliberately (like `scaffoldGuard.ts`): not re-exported from
 * `src/index.ts`, since a barrel export is a permanent public-API commitment.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { resolveWithin } from "@genvidtech/mcp-utils";
import { cloneLayout, collectAllUids } from "./layoutScaffold.js";
import { findLayoutScaffoldConflicts, findSpriteScaffoldConflicts, formatScaffoldRefusal } from "./scaffoldGuard.js";
import { readRegistryFile } from "./sidUtils.js";
import { writeSourceJson } from "./sourceJson.js";
import {
  cloneSprite,
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  discoverAndPlanImageCopies,
} from "./spriteScaffold.js";

export function formatScaffoldPathRejection(which: "output" | "source", raw: string): string {
  return `Invalid ${which} path '${raw}' — must stay within layouts/`;
}

export function formatScaffoldNameRejection(label: "source" | "name", raw: string): string {
  return `Invalid ${label} '${raw}' — must be a plain objectType name without path separators`;
}

export function formatScaffoldSourceNotFound(kind: "layout" | "objectType", relPosix: string): string {
  return `Source ${kind} not found: ${relPosix}`;
}

export function formatScaffoldSuccess(name: string, relPosix: string): string {
  return `Scaffolded ${name} → ${relPosix}`;
}

export interface ScaffoldRejection {
  ok: false;
  kind: "invalid-path" | "invalid-name" | "source-not-found" | "conflict";
  message: string;
}

export interface LayoutScaffoldPlan {
  ok: true;
  outPath: string;
  cloned: Record<string, unknown>;
  successLine: string;
}

export interface SpriteScaffoldPlan {
  ok: true;
  outPath: string;
  cloned: Record<string, unknown>;
  successLine: string;
  imageCopies: ReturnType<typeof discoverAndPlanImageCopies>;
}

/** POSIX path of `abs` relative to `rootDir`, on every OS. */
function relPosix(rootDir: string, abs: string): string {
  return path.relative(rootDir, abs).split(path.sep).join("/");
}

export interface LayoutScaffoldPlanOptions {
  rootDir: string;
  layoutsDir: string;
  extractedDirAbs: string;
  /** What relative `source`/`out` are relative to: `layouts/` (MCP) or the project root (CLI). */
  pathBase: "layouts" | "project-root";
  source: string;
  out: string;
  name: string;
  eventSheet: string;
}

/** Validate and build a layout scaffold. Never writes. */
export function planLayoutScaffold(opts: LayoutScaffoldPlanOptions): LayoutScaffoldPlan | ScaffoldRejection {
  const { rootDir, layoutsDir, extractedDirAbs, pathBase, source, out, name, eventSheet } = opts;
  const anchor = (p: string): string => (pathBase === "layouts" ? p : path.resolve(rootDir, p));

  const outPath = resolveWithin(layoutsDir, anchor(out));
  if (outPath === null) {
    return { ok: false, kind: "invalid-path", message: formatScaffoldPathRejection("output", out) };
  }
  const sourcePath = resolveWithin(layoutsDir, anchor(source));
  if (sourcePath === null) {
    return { ok: false, kind: "invalid-path", message: formatScaffoldPathRejection("source", source) };
  }
  if (!existsSync(sourcePath)) {
    return {
      ok: false,
      kind: "source-not-found",
      message: formatScaffoldSourceNotFound("layout", relPosix(rootDir, sourcePath)),
    };
  }

  const conflicts = findLayoutScaffoldConflicts(rootDir, layoutsDir, outPath);
  if (conflicts.length > 0) {
    return { ok: false, kind: "conflict", message: formatScaffoldRefusal("scaffold-layout", conflicts) };
  }

  const sourceLayout = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;

  // Seeding existingSids from the project registry prevents cloned SIDs from colliding with
  // anything in eventSheets/, layouts/, or objectTypes/.
  const existingUids = collectAllUids(layoutsDir);
  const sidRegistryPath = path.join(extractedDirAbs, "sid-registry.txt");
  const existingSids = existsSync(sidRegistryPath) ? readRegistryFile(sidRegistryPath) : new Set<number>();
  const cloned = cloneLayout(sourceLayout, { name, eventSheet, existingUids, existingSids });

  return { ok: true, outPath, cloned, successLine: formatScaffoldSuccess(name, relPosix(rootDir, outPath)) };
}

export interface SpriteScaffoldPlanOptions {
  rootDir: string;
  objectTypesDir: string;
  imagesDir: string;
  source: string;
  name: string;
}

/** Validate and build a sprite scaffold. Never writes. */
export function planSpriteScaffold(opts: SpriteScaffoldPlanOptions): SpriteScaffoldPlan | ScaffoldRejection {
  const { rootDir, objectTypesDir, imagesDir, source, name } = opts;

  for (const [label, val] of [
    ["source", source],
    ["name", name],
  ] as const) {
    if (val.includes("/") || val.includes("\\") || val.includes("..")) {
      return { ok: false, kind: "invalid-name", message: formatScaffoldNameRejection(label, val) };
    }
  }

  const sourceFile = path.join(objectTypesDir, `${source}.json`);
  if (!existsSync(sourceFile)) {
    return {
      ok: false,
      kind: "source-not-found",
      message: formatScaffoldSourceNotFound("objectType", relPosix(rootDir, sourceFile)),
    };
  }

  const conflicts = findSpriteScaffoldConflicts(rootDir, objectTypesDir, imagesDir, source, name);
  if (conflicts.length > 0) {
    return { ok: false, kind: "conflict", message: formatScaffoldRefusal("scaffold-sprite", conflicts) };
  }

  const sourceObj = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;
  const existingSids = collectAllObjectTypeSids(objectTypesDir);
  const maxImageSpriteId = collectMaxImageSpriteId(objectTypesDir);
  const cloned = cloneSprite(sourceObj, { name, existingSids, nextImageSpriteId: maxImageSpriteId + 1 });

  const outPath = path.join(objectTypesDir, `${name}.json`);
  return {
    ok: true,
    outPath,
    cloned,
    successLine: formatScaffoldSuccess(name, relPosix(rootDir, outPath)),
    imageCopies: existsSync(imagesDir) ? discoverAndPlanImageCopies(imagesDir, source, name) : [],
  };
}

/** Write a layout plan: creates missing parent directories, writes the JSON, logs the success line. */
export function writeLayoutScaffold(plan: LayoutScaffoldPlan, log: (line: string) => void): void {
  mkdirSync(path.dirname(plan.outPath), { recursive: true });
  writeSourceJson(plan.outPath, plan.cloned);
  log(plan.successLine);
}

/** Write a sprite plan: the objectType JSON, then each planned image copy, logging as it goes. */
export function writeSpriteScaffold(plan: SpriteScaffoldPlan, log: (line: string) => void): void {
  writeSourceJson(plan.outPath, plan.cloned);
  log(plan.successLine);
  for (const { sourcePath, targetPath, sourceBasename, targetBasename } of plan.imageCopies) {
    copyFileSync(sourcePath, targetPath);
    log(`Copied images/${sourceBasename} → images/${targetBasename}`);
  }
}
