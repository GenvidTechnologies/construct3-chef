import path from "node:path";
import type { Logger } from "@genvidtech/mcp-utils";
import { find_all_layouts_path, openProject } from "@genvidtech/c3source";
import type { ObjectTypeCreate, AddInstVarsEntry } from "./recipeInterpreter.js";
import type { SidGenerator } from "./sidUtils.js";
import { serializeSourceJson } from "./sourceJson.js";
import { OverlayIo, type SourceIo } from "./sourceIo.js";
import { lookupObjectTypeByName } from "./objectTypeIdentity.js";
import {
  addInstVarsToObjectType,
  addInstVarsToLayout,
  addInstVarsToTypesDts,
  type InstVarDef,
} from "./instVarMutator.js";

/**
 * The `SourceIo`-parameterised bodies of `recipeApplier.ts`'s objectType /
 * addInstVars helpers. `recipeApplier.ts` keeps the public wrappers (bound to
 * `diskIo`) so the published signatures are unchanged.
 *
 * Off-barrel deliberately: NOT re-exported from `src/index.ts`. Anything
 * exported from `recipeApplier.ts` is public API via the barrel's `export *`,
 * so the io-taking internals live here instead.
 */

export const PLUGIN_BASE_CLASS: Record<string, string> = {
  Json: "IJSONInstance",
  Dictionary: "IDictionaryInstance",
  Arr: "IArrayInstance",
};

export function getObjectTypePath(objectType: ObjectTypeCreate): string {
  return objectType.folder
    ? `objectTypes/${objectType.folder}/${objectType.name}.json`
    : `objectTypes/${objectType.name}.json`;
}

/**
 * `dryRun` in these helpers selects the log tense only; every helper writes to the `io` it is given. A dry-run
 * must therefore compute against an in-memory overlay, or it would write for real.
 */
function assertDryRunOverlay(io: SourceIo, dryRun: boolean): void {
  if (dryRun && !(io instanceof OverlayIo)) throw new Error("dry-run must compute against an OverlayIo, never diskIo");
}

export function createObjectTypeIo(
  io: SourceIo,
  sidGen: SidGenerator,
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger,
): boolean {
  assertDryRunOverlay(io, dryRun);
  const relPath = getObjectTypePath(objectType);
  const fullPath = path.join(rootDir, relPath);

  // Respect the SKIP-if-exists fast path before validating the plugin so a
  // recipe that re-declares an already-existing objectType (a benign no-op)
  // stays a no-op even if the recipe carries a stale or typoed plugin name.
  // For new objectTypes we still reject unknown plugins up-front — otherwise
  // updateInstanceTypes would silently write `class X extends undefined`.
  if (io.exists(fullPath)) {
    log(`  SKIP ${relPath} (already exists)`);
    return false;
  }

  if (!(objectType.plugin in PLUGIN_BASE_CLASS)) {
    throw new Error(
      `createObjectType: unknown plugin "${objectType.plugin}" for objectType "${objectType.name}". ` +
        `Valid plugins: ${Object.keys(PLUGIN_BASE_CLASS).join(", ")}.`,
    );
  }

  const ivars = (objectType.instanceVariables ?? []).map((v) => ({
    name: v.name,
    type: v.type,
    desc: "",
    show: true,
    sid: sidGen(),
  }));

  const json = {
    name: objectType.name,
    "plugin-id": objectType.plugin,
    sid: sidGen(),
    isGlobal: true,
    editorNewInstanceIsReplica: true,
    instanceVariables: ivars,
  };

  io.writeText(fullPath, serializeSourceJson(json), { mkdir: true });
  log(dryRun ? `  CREATE ${relPath} (plugin: ${objectType.plugin})` : `  CREATED ${relPath}`);
  return true;
}

/**
 * Read through `io`, returning `null` only when the file does not exist (ENOENT).
 * Any other failure rethrows. ts-defs are written by the C3 editor, so a project
 * without them is skipped, never given one.
 */
function readTextIfPresent(io: SourceIo, abs: string): string | null {
  try {
    return io.readText(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const SKIP_INSTANCE_TYPES =
  "  SKIP scripts/ts-defs/instanceTypes.d.ts (not present; ts-defs are written by the C3 editor)";
const SKIP_OBJECTS = "  SKIP scripts/ts-defs/objects.d.ts (not present; ts-defs are written by the C3 editor)";

export function updateInstanceTypesIo(
  io: SourceIo,
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger,
): void {
  assertDryRunOverlay(io, dryRun);
  const filePath = path.join(openProject(rootDir).scriptsDir, "ts-defs/instanceTypes.d.ts");
  const content = readTextIfPresent(io, filePath);
  if (content === null) {
    log(SKIP_INSTANCE_TYPES);
    return;
  }

  const baseClass = PLUGIN_BASE_CLASS[objectType.plugin];
  const ivars = objectType.instanceVariables ?? [];

  let classBody: string;
  if (ivars.length === 0) {
    classBody = `\tclass ${objectType.name} extends ${baseClass} {\n\t}`;
  } else {
    const fields = ivars.map((v) => `\t\t\t${v.name}: ${v.type},`).join("\n");
    classBody = `\tclass ${objectType.name} extends ${baseClass} {\n\t\tinstVars: {\n${fields}\n\t\t};\n\t}`;
  }

  // Insert before the closing `}` of the namespace (last line `}`)
  const lastBrace = content.lastIndexOf("\n}");
  const updated = content.slice(0, lastBrace) + "\n" + classBody + "\n" + content.slice(lastBrace);

  io.writeText(filePath, updated);
  log(dryRun ? `  UPDATE scripts/ts-defs/instanceTypes.d.ts` : `  UPDATED scripts/ts-defs/instanceTypes.d.ts`);
}

export function updateObjectsIo(
  io: SourceIo,
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger,
): void {
  assertDryRunOverlay(io, dryRun);
  const filePath = path.join(openProject(rootDir).scriptsDir, "ts-defs/objects.d.ts");
  const content = readTextIfPresent(io, filePath);
  if (content === null) {
    log(SKIP_OBJECTS);
    return;
  }

  const line = `\treadonly ${objectType.name}: IObjectType<InstanceType.${objectType.name}>;`;

  // Insert before the closing `}` of the class (last line `}`)
  const lastBrace = content.lastIndexOf("\n}");
  const updated = content.slice(0, lastBrace) + "\n" + line + "\n" + content.slice(lastBrace);

  io.writeText(filePath, updated);
  log(dryRun ? `  UPDATE scripts/ts-defs/objects.d.ts` : `  UPDATED scripts/ts-defs/objects.d.ts`);
}

export function findObjectTypeFileIo(io: SourceIo, rootDir: string, typeName: string): string | null {
  const objectTypesDir = openProject(rootDir).objectTypesDir;
  const allPaths = io.listObjectTypeFiles(objectTypesDir);
  for (const p of allPaths) {
    const basename = path.basename(p, ".json");
    if (basename === typeName) return p;
  }
  return null;
}

function caseMismatchMessage(type: string, relPath: string): string {
  return (
    `addInstVars: objectType "${type}" matches ${relPath} only when letter case is ignored; ` +
    `a type must use the on-disk spelling, since letter case is ignored for identity (ADR 0046)`
  );
}

export function processAddInstVarsIo(
  io: SourceIo,
  sidGen: SidGenerator,
  rootDir: string,
  entries: AddInstVarsEntry[],
  dryRun: boolean,
  log: Logger,
): void {
  assertDryRunOverlay(io, dryRun);
  for (const entry of entries) {
    const newVars: InstVarDef[] = entry.instanceVariables;

    // 1. Update objectType JSON
    const rel = (p: string) => path.relative(rootDir, p).replace(/\\/g, "/");
    const lookup = lookupObjectTypeByName(io.listObjectTypeFiles(openProject(rootDir).objectTypesDir), entry.type);
    if (lookup.kind === "not-found") {
      throw new Error(`addInstVars: objectType "${entry.type}" not found under objectTypes/`);
    }
    if (lookup.kind === "case-mismatch") {
      throw new Error(caseMismatchMessage(entry.type, rel(lookup.onDisk)));
    }
    if (lookup.kind === "ambiguous") {
      throw new Error(
        `addInstVars: objectType "${entry.type}" is ambiguous, ${lookup.matches.length} files match: ` +
          `${lookup.matches.map(rel).join(", ")}`,
      );
    }
    const objectTypeFile = lookup.path;
    const relOtPath = path.relative(rootDir, objectTypeFile).replace(/\\/g, "/");

    const objectType = JSON.parse(io.readText(objectTypeFile));
    if (!objectType.instanceVariables) {
      objectType.instanceVariables = [];
    }
    const added = addInstVarsToObjectType(sidGen, objectType, newVars);
    if (added.length === 0) {
      log(`  SKIP ${relOtPath} (all instVars already exist)`);
    } else {
      io.writeText(objectTypeFile, serializeSourceJson(objectType));
      log(`  ${dryRun ? "UPDATE" : "UPDATED"} ${relOtPath} (+${added.join(", ")})`);
    }

    // 2. Update layout instances (layouts listing stays on disk: recipes never create layouts)
    const layoutsDir = openProject(rootDir).layoutsDir;
    const allLayouts = find_all_layouts_path(layoutsDir);
    let totalInstances = 0;
    for (const layoutPath of allLayouts) {
      const layout = JSON.parse(io.readText(layoutPath));
      const count = addInstVarsToLayout(layout, entry.type, newVars);
      if (count > 0) {
        totalInstances += count;
        const relPath = path.relative(rootDir, layoutPath).replace(/\\/g, "/");
        io.writeText(layoutPath, serializeSourceJson(layout));
        log(`  ${dryRun ? "UPDATE" : "UPDATED"} ${relPath} (${count} instance(s))`);
      }
    }
    if (totalInstances === 0) {
      log(`  No layout instances found for ${entry.type}`);
    }

    // 3. Update instanceTypes.d.ts
    if (added.length > 0) {
      const typesFile = path.join(openProject(rootDir).scriptsDir, "ts-defs/instanceTypes.d.ts");
      const typesContent = readTextIfPresent(io, typesFile);
      if (typesContent === null) {
        log(SKIP_INSTANCE_TYPES);
        continue;
      }
      const updatedTypes = addInstVarsToTypesDts(typesContent, entry.type, newVars);
      if (updatedTypes === null) {
        log(`  WARN: class "${entry.type}" not found in instanceTypes.d.ts — manual update needed`);
      } else if (updatedTypes === typesContent) {
        log(`  SKIP instanceTypes.d.ts (instVars already declared)`);
      } else {
        io.writeText(typesFile, updatedTypes);
        log(`  ${dryRun ? "UPDATE" : "UPDATED"} scripts/ts-defs/instanceTypes.d.ts (+${added.join(", ")})`);
      }
    }
  }
}
