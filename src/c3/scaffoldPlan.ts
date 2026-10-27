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

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { find_all_objectTypes_path, isSectionItemName } from "@genvidtech/c3source";
import { resolveWithin } from "@genvidtech/mcp-utils";
import { cloneLayout, collectAllUids } from "./layoutScaffold.js";
import { lookupObjectTypeByName } from "./objectTypeIdentity.js";
import { findLayoutScaffoldConflicts, findSpriteScaffoldConflicts, formatScaffoldRefusal } from "./scaffoldGuard.js";
import { objectTypeNameIssue, type ObjectTypeNameIssue } from "./recipeKeys.js";
import { readRegistryFile } from "./sidUtils.js";
import { writeSourceJson } from "./sourceJson.js";
import {
  cloneSprite,
  collectAllObjectTypeSids,
  collectMaxImageSpriteId,
  planSpriteImageCopies,
  type ImageCopyPlan,
} from "./spriteScaffold.js";

export function formatScaffoldPathRejection(which: "output" | "source", raw: string): string {
  return `Invalid ${which} path '${raw}' — must stay within layouts/`;
}

function scaffoldNameReason(issue: ObjectTypeNameIssue | undefined): string {
  switch (issue?.kind) {
    case "empty":
      return "must not be empty";
    case "separator":
      return "must not contain '/' or '\\'";
    case "dot":
      return `must not be '${issue.name}'`;
    case "colon":
      return "must not contain ':' (host-dependent on Windows)";
    case "dots-and-spaces":
      return "must not be only dots and spaces";
    default:
      return "must be a plain objectType name";
  }
}

/** The reason is derived from `raw` by the shared rule, so every caller renders the same text. */
export function formatScaffoldNameRejection(label: "source" | "name", raw: string): string {
  return `Invalid ${label} '${raw}' — ${scaffoldNameReason(objectTypeNameIssue(raw))}`;
}

export function formatScaffoldSourceNotFound(kind: "layout" | "objectType", relPosix: string): string {
  return `Source ${kind} not found: ${relPosix}`;
}

export function formatScaffoldEmptyInput(label: "name" | "event sheet"): string {
  return `Invalid ${label} '' — must not be empty`;
}

export function formatScaffoldOutputNotJson(raw: string): string {
  return `Invalid output path '${raw}' — the output must be a .json file`;
}

export function formatScaffoldSourceNotFile(relPosix: string): string {
  return `Source layout is not a file: ${relPosix}`;
}

export function formatScaffoldSourceCaseMismatch(source: string, onDiskRel: string): string {
  return `Source objectType '${source}' matches ${onDiskRel} only when letter case is ignored. Use the on-disk spelling '${path.posix.basename(onDiskRel, ".json")}', so the result is the same on every filesystem.`;
}

export function formatScaffoldSourceAmbiguous(source: string, matchRels: readonly string[]): string {
  const sorted = [...matchRels].sort(); // sort POSIX-relative strings: `\` vs `/` order differs by host
  return `Source objectType '${source}' is ambiguous: ${sorted.length} objectTypes have this name (letter case is ignored): ${sorted.join(", ")}. Rename all but one before cloning.`;
}

export function formatScaffoldSuccess(name: string, relPosix: string): string {
  return `Scaffolded ${name} → ${relPosix}`;
}

export interface ScaffoldRejection {
  ok: false;
  kind: "invalid-path" | "invalid-name" | "source-not-found" | "source-case-mismatch" | "source-ambiguous" | "conflict";
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
  imageCopies: ImageCopyPlan[];
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
  // Order: containment (out, source), then input shape (name, eventSheet, out extension),
  // then the source on disk (exists, is a file), then conflicts.
  if (name === "") {
    return { ok: false, kind: "invalid-name", message: formatScaffoldEmptyInput("name") };
  }
  if (eventSheet === "") {
    return { ok: false, kind: "invalid-name", message: formatScaffoldEmptyInput("event sheet") };
  }
  if (!isSectionItemName(outPath)) {
    return { ok: false, kind: "invalid-path", message: formatScaffoldOutputNotJson(out) };
  }
  if (!existsSync(sourcePath)) {
    return {
      ok: false,
      kind: "source-not-found",
      message: formatScaffoldSourceNotFound("layout", relPosix(rootDir, sourcePath)),
    };
  }
  if (!statSync(sourcePath).isFile()) {
    return {
      ok: false,
      kind: "invalid-path",
      message: formatScaffoldSourceNotFile(relPosix(rootDir, sourcePath)),
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
    if (objectTypeNameIssue(val) !== undefined) {
      return { ok: false, kind: "invalid-name", message: formatScaffoldNameRejection(label, val) };
    }
  }

  const listing = existsSync(objectTypesDir) ? find_all_objectTypes_path(objectTypesDir) : [];
  const hit = lookupObjectTypeByName(listing, source);
  if (hit.kind === "not-found") {
    return {
      ok: false,
      kind: "source-not-found",
      message: formatScaffoldSourceNotFound(
        "objectType",
        relPosix(rootDir, path.join(objectTypesDir, `${source}.json`)),
      ),
    };
  }
  if (hit.kind === "case-mismatch") {
    return {
      ok: false,
      kind: "source-case-mismatch",
      message: formatScaffoldSourceCaseMismatch(source, relPosix(rootDir, hit.onDisk)),
    };
  }
  if (hit.kind === "ambiguous") {
    return {
      ok: false,
      kind: "source-ambiguous",
      message: formatScaffoldSourceAmbiguous(
        source,
        hit.matches.map((m) => relPosix(rootDir, m)),
      ),
    };
  }
  const sourceFile = hit.path;

  const sourceObj = JSON.parse(readFileSync(sourceFile, "utf-8")) as Record<string, unknown>;

  const conflicts = findSpriteScaffoldConflicts(rootDir, objectTypesDir, imagesDir, sourceObj, name);
  if (conflicts.length > 0) {
    return { ok: false, kind: "conflict", message: formatScaffoldRefusal("scaffold-sprite", conflicts) };
  }

  const existingSids = collectAllObjectTypeSids(objectTypesDir);
  const maxImageSpriteId = collectMaxImageSpriteId(objectTypesDir);
  const cloned = cloneSprite(sourceObj, { name, existingSids, nextImageSpriteId: maxImageSpriteId + 1 });

  const outPath = path.join(objectTypesDir, `${name}.json`);
  return {
    ok: true,
    outPath,
    cloned,
    successLine: formatScaffoldSuccess(name, relPosix(rootDir, outPath)),
    imageCopies: existsSync(imagesDir) ? planSpriteImageCopies(imagesDir, sourceObj, name) : [],
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
