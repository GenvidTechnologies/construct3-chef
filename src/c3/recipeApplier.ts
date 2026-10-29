import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GENERATORS } from "./generators.js";
import { writeSourceJson, serializeSourceJson } from "./sourceJson.js";
import { diskIo, OverlayIo } from "./sourceIo.js";
import {
  PLUGIN_BASE_CLASS,
  getObjectTypePath,
  createObjectTypeIo,
  updateInstanceTypesIo,
  updateObjectsIo,
  findObjectTypeFileIo,
  processAddInstVarsIo,
} from "./recipeApplierIo.js";
import type { Logger } from "@genvidtech/mcp-utils";
import { escapeRegExp } from "@genvidtech/mcp-utils";
import type { ApplyOptions } from "./types.js";
import type { EventSheet, EventSheetEvent, SidSlot } from "@genvidtech/c3source";
import {
  find_all_eventsheets_path,
  find_all_objectTypes_path,
  findSid,
  validateForEditor,
  openProject,
} from "@genvidtech/c3source";
import { decideObjectTypeCreate } from "./objectTypeIdentity.js";
import {
  type Recipe,
  type ObjectTypeCreate,
  type AddInstVarsEntry,
  type AddNonworldInstanceOp,
  type PrimitiveLayoutOp,
  type FileOp,
  validateRecipe,
  executeFileOps,
  isFileCreate,
  applyReplacements,
  createSheet,
  extractSheetName,
} from "./recipeInterpreter.js";
import {
  findLayer,
  addSublayer,
  addLayer,
  copyInstance,
  templatize,
  replicify,
  addReplica,
  removeInstance,
  removeLayer,
  removeLayerCascade,
  moveInstance,
  renameLayer,
  type LayoutJson as MutatorLayoutJson,
} from "./layoutMutator.js";
import { collectAllUids } from "./layoutScaffold.js";
import { seedLayoutSids } from "./layoutSidSeed.js";
import { readRegistryFile, makeSidGen, freshSidGen, type SidGenerator } from "./sidUtils.js";
import { diffScripts } from "./previewDiff.js";
import { findCaseFoldedMatch, findSpellingMismatches, type SpellingRef } from "./recipeKeys.js";
import { expandWorkflows, type LoadLayout } from "./workflowExpansion.js";
import { applyNarration, dryRunNarration, type RecipeNarration } from "./recipeNarration.js";
import { buildCustomAceIndex, validateInsertedCustomActions, type CustomAceIndex } from "./customAceIndex.js";

// ─── Constants ───

export { PLUGIN_BASE_CLASS, getObjectTypePath };

// ─── Types ───

interface NonworldInstance {
  type: string;
  properties: Record<string, unknown>;
  uid: number;
  sid: number;
  tags: string;
  instanceVariables: Record<string, unknown>;
}

interface LayoutJson {
  "nonworld-instances"?: NonworldInstance[];
  [key: string]: unknown;
}

// ─── Helper functions ───

/**
 * Max value of a numeric Set. Avoids `Math.max(...set, 0)` because spreading
 * a large Set onto the argument list hits V8's argument-count limit (~100k+)
 * with `RangeError: Maximum call stack size exceeded`. For typical C3 projects
 * the Set is small, but `validate-recipe` runs on this path too and shouldn't
 * inherit a scaling cliff. Returns 0 when the Set is empty.
 */
function maxFromSet(set: Set<number>): number {
  let max = 0;
  for (const v of set) {
    if (v > max) max = v;
  }
  return max;
}

export function loadSheet(rootDir: string, filePath: string): EventSheet {
  const fullPath = path.join(rootDir, filePath);
  const content = readFileSync(fullPath, "utf-8");
  return JSON.parse(content) as EventSheet;
}

function assertEditorValid(label: string, sheet: EventSheet): void {
  const issues = validateForEditor(sheet);
  if (issues.length > 0) {
    const lines = issues.map((i) => `  - ${i.path} [${i.rule}]: ${i.message}`).join("\n");
    throw new Error(`Editor-validation failed for ${label}:\n${lines}`);
  }
}

/**
 * Validate custom-actions inserted by the recipe against the project's
 * custom-ACE index. Mirrors `assertEditorValid`'s throw-on-error shape.
 * `index` is null when no file ops are present (index was not built).
 */
function assertCustomActionsValid(
  index: CustomAceIndex | null,
  label: string,
  original: EventSheet,
  modified: EventSheet,
): void {
  if (!index) return;
  const errors = validateInsertedCustomActions(index, original, modified);
  if (errors.length > 0) {
    throw new Error(`Custom-action validation failed for ${label}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

/**
 * Regenerate `extracted/` in place by running every entry of `GENERATORS`: the same full inventory the MCP
 * path and `construct3-chef generate` run (#256, ADR 0049).
 *
 * @param withLayouts @deprecated Ignored since #256: every generator always runs. Kept so the published
 *   signature is unchanged.
 */
export function regenerateExtracted(
  rootDir: string,
  withLayouts = false,
  extractedDir = "extracted",
  log: Logger = console.log,
) {
  void withLayouts;
  const outDir = path.join(rootDir, extractedDir);

  log("\n--- Regenerating extracted files ---\n");

  GENERATORS.forEach((g, i) => {
    log(`${i > 0 ? "\n" : ""}${g.label}...`);
    g.run(rootDir, outDir, log);
  });
}

/**
 * Regenerate after the source write has landed (#256 D2). A failure here is raised with the written-source
 * count and the recovery command, so the caller knows source changed while `extracted/` did not. Wraps ONLY
 * the regeneration; errors raised before the write are untouched.
 */
function regenerateAfterWrite(rootDir: string, extractedDir: string, written: number, log: Logger): void {
  try {
    regenerateExtracted(rootDir, true, extractedDir, log);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Regenerating ${extractedDir}/ failed after writing ${written} source file(s): ${cause}. Run \`construct3-chef generate\` once the cause is fixed.`,
      { cause: e },
    );
  }
}

// ─── objectTypes helpers ───

export function createObjectType(
  sidGen: SidGenerator,
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): boolean {
  return createObjectTypeIo(dryRun ? new OverlayIo() : diskIo, sidGen, rootDir, objectType, dryRun, log);
}

export function updateInstanceTypes(
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): void {
  updateInstanceTypesIo(dryRun ? new OverlayIo() : diskIo, rootDir, objectType, dryRun, log);
}

export function updateObjects(
  rootDir: string,
  objectType: ObjectTypeCreate,
  dryRun: boolean,
  log: Logger = console.log,
): void {
  updateObjectsIo(dryRun ? new OverlayIo() : diskIo, rootDir, objectType, dryRun, log);
}

// ─── addInstVars helpers ───

export function findObjectTypeFile(rootDir: string, typeName: string): string | null {
  return findObjectTypeFileIo(diskIo, rootDir, typeName);
}

/**
 * @param pendingObjectTypes @deprecated Still honoured, but no longer needed: dry-run now computes against an
 *   in-memory overlay, so this function emulates the pending types itself (creating each one in the overlay,
 *   silently, as the recipe's objectTypes step would). Use `applyRecipeInner`/`applyParsed` with `dryRun` instead.
 *   Ignored when `dryRun` is false, where the objectTypes are already on disk.
 */
export function processAddInstVars(
  sidGen: SidGenerator,
  rootDir: string,
  entries: AddInstVarsEntry[],
  dryRun: boolean,
  log: Logger = console.log,
  pendingObjectTypes?: ObjectTypeCreate[],
): void {
  if (!dryRun) {
    processAddInstVarsIo(diskIo, sidGen, rootDir, entries, false, log);
    return;
  }
  const io = new OverlayIo();
  const quiet: Logger = () => {};
  for (const ot of pendingObjectTypes ?? []) {
    if (createObjectTypeIo(io, sidGen, rootDir, ot, true, quiet)) {
      updateInstanceTypesIo(io, rootDir, ot, true, quiet);
      updateObjectsIo(io, rootDir, ot, true, quiet);
    }
  }
  processAddInstVarsIo(io, sidGen, rootDir, entries, true, log);
}

// ─── Layout mutation helpers ───

export function buildDefaultValue(type: "string" | "number" | "boolean"): string | number | boolean {
  if (type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

export function applyNonworldInstance(
  sidGen: SidGenerator,
  layout: LayoutJson,
  op: AddNonworldInstanceOp,
  uid: number,
  objectTypes: ObjectTypeCreate[],
): void {
  // Resolve default properties based on plugin
  const ot = objectTypes.find((o) => o.name === op.type);
  let defaultProps: Record<string, unknown> = {};
  if (ot?.plugin === "Arr") {
    defaultProps = { width: 1, height: 1, depth: 1 };
  }

  // Resolve instance variables: use provided values, fallback to defaults from objectType definition
  const resolvedIVars: Record<string, string | number | boolean> = {};
  if (ot?.instanceVariables) {
    for (const ivar of ot.instanceVariables) {
      resolvedIVars[ivar.name] = op.instanceVariables?.[ivar.name] ?? buildDefaultValue(ivar.type);
    }
  }
  // Also apply any extra values from op.instanceVariables
  if (op.instanceVariables) {
    for (const [k, v] of Object.entries(op.instanceVariables)) {
      resolvedIVars[k] = v;
    }
  }

  const newInstance: NonworldInstance = {
    type: op.type,
    properties: op.properties ?? defaultProps,
    uid,
    sid: sidGen(),
    tags: op.tags ?? "",
    instanceVariables: resolvedIVars,
  };

  if (!layout["nonworld-instances"]) {
    layout["nonworld-instances"] = [];
  }
  layout["nonworld-instances"].push(newInstance);
}

// ─── Main apply function ───

/** Resolve a `"sid:X"` variable ref to its name in the given sheet, or null. */
function findVariableNameBySidRef(sheet: EventSheet, ref: string): string | null {
  const sid = Number(ref.slice("sid:".length));
  if (!Number.isFinite(sid)) return null;
  let found: string | null = null;
  function walk(nodes: EventSheetEvent[]): void {
    for (const ev of nodes) {
      if (found) return;
      if (ev.eventType === "variable" && ev.sid === sid) {
        found = ev.name;
        return;
      }
      const children = (ev as { children?: EventSheetEvent[] }).children;
      if (Array.isArray(children)) walk(children);
    }
  }
  walk(sheet.events);
  return found;
}

/**
 * Refuse a files CREATE whose target already exists on disk (#249). A CREATE only
 * makes new sheets; editing an existing one is an ops array's job. Runs before any
 * dry-run output or write, so validate-recipe / --preview report the same refusal
 * as apply, and no objectType/layout write from Steps 1–2 can land first. Resolves
 * each target exactly as Step 3's write does: path.join(rootDir, <normalized key>).
 */
function checkCreateTargets(rootDir: string, files: NonNullable<Recipe["files"]>, getListing: () => string[]): void {
  const creates = Object.entries(files)
    .filter(([, entry]) => isFileCreate(entry))
    .map(([filePath]) => filePath);
  if (creates.length === 0) return;
  // existsSync covers any existing path the listing does not (it lists event sheets and layouts only); the listing
  // decides the case-folded matches, which existsSync alone misses where the filesystem is case-sensitive (Linux).
  const listing = getListing();
  const lines: string[] = [];
  for (const filePath of creates) {
    const folded = findCaseFoldedMatch(filePath, listing);
    if (!existsSync(path.join(rootDir, filePath)) && folded.length === 0) continue;
    lines.push(folded.length > 0 ? `  - ${filePath} (on disk: ${folded.join(" | ")})` : `  - ${filePath}`);
  }
  if (lines.length === 0) return;
  throw new Error(
    `files CREATE refused: ${lines.length} target(s) already exist on disk, and { "create": true } never overwrites an existing event sheet. Nothing was written.\n` +
      lines.join("\n") +
      `\nTo edit an existing sheet, give its files entry an ops array instead, e.g. [{ "op": "insert-event", ... }].`,
  );
}

/**
 * Refuse a recipe objectType whose name already exists on disk under a different spelling or folder (#274, ADR 0046).
 * An exact re-declaration (same folder, same letter case) is left for createObjectTypeIo to SKIP. Runs before any
 * dry-run output or write, so validate-recipe / --preview refuse exactly like apply.
 */
function checkObjectTypeCreateTargets(rootDir: string, objectTypes: readonly ObjectTypeCreate[]): void {
  const objectTypesDir = openProject(rootDir).objectTypesDir;
  const listing = existsSync(objectTypesDir)
    ? find_all_objectTypes_path(objectTypesDir).map((p) => path.relative(rootDir, p).split(path.sep).join("/"))
    : [];
  const lines: string[] = [];
  for (const entry of objectTypes) {
    const target = path.posix.normalize(getObjectTypePath(entry));
    const decision = decideObjectTypeCreate(listing, target, entry.name);
    if (decision.kind === "refuse") lines.push(`  - ${target} (on disk: ${decision.onDisk.join(" | ")})`);
  }
  if (lines.length === 0) return;
  throw new Error(
    `objectTypes refused: ${lines.length} entr${lines.length === 1 ? "y names" : "ies name"} an objectType that already exists on disk under another spelling or folder. An objectType's identity is its name in any objectTypes/ folder, letter case ignored (ADR 0046). Nothing was written.\n` +
      lines.join("\n") +
      `\nRe-declare it with the exact on-disk name and folder (a SKIP when only one objectType file has that name), or choose a different name. When several files share the name, rename or remove the extras first.`,
  );
}

/** Event-sheet and layout paths on disk, root-relative with "/" separators: the corpus spelling checks compare against. */
function listSpellingCorpus(rootDir: string): string[] {
  const project = openProject(rootDir);
  return [...project.findAllEventSheets(), ...project.findAllLayouts()].map((p) =>
    path.relative(rootDir, p).split(path.sep).join("/"),
  );
}

/**
 * Refuse a recipe path whose letter case differs from what is on disk (#253). Runs on the canonical
 * (post-validateRecipe) keys: `files` keys (a CREATE checks folders only), `layouts` keys, and the cross-layout op
 * fields (`from`, `sourceLayout`, `templatesLayout`, `targets[].layout`). Fires before expandWorkflows and before
 * any write, in dry-run too, so a miscased `templatesLayout` is refused rather than read.
 */
function checkKeySpelling(recipe: Recipe, getListing: () => string[]): void {
  const refs: SpellingRef[] = [];
  const addLayoutRef = (p: unknown): void => {
    if (typeof p === "string") refs.push({ path: p, kind: "file" });
  };
  for (const [filePath, entry] of Object.entries(recipe.files ?? {})) {
    refs.push({ path: filePath, kind: isFileCreate(entry) ? "create" : "file" });
  }
  for (const [layoutPath, ops] of Object.entries(recipe.layouts ?? {})) {
    addLayoutRef(layoutPath);
    for (const op of ops as unknown[]) {
      if (typeof op !== "object" || op === null) continue;
      const o = op as Record<string, unknown>;
      addLayoutRef(o.from);
      addLayoutRef(o.sourceLayout);
      addLayoutRef(o.templatesLayout);
      if (Array.isArray(o.targets)) {
        for (const t of o.targets) addLayoutRef((t as { layout?: unknown } | null)?.layout);
      }
    }
  }
  if (refs.length === 0) return;

  const listing = getListing();
  const mismatches = findSpellingMismatches(refs, listing);
  if (mismatches.length === 0) return;

  // Show the whole path in its on-disk spelling: a listed file that equals the ref ignoring case wins, else the
  // matched on-disk prefix followed by the ref's remaining segments as written (a new tail).
  const fullSpellings = (m: (typeof mismatches)[number]): string[] => {
    const lowerRef = m.path.toLowerCase();
    const exactFold = listing.filter((p) => p.toLowerCase() === lowerRef);
    if (exactFold.length > 0) return exactFold.sort();
    const tail = m.path.slice(m.prefix.length);
    return m.onDisk.map((d) => `${d}${tail}`);
  };
  const lines = [...new Set(mismatches.map((m) => `  - ${m.path} → on disk: ${fullSpellings(m).join(" | ")}`))].sort();
  throw new Error(
    `recipe path refused: ${lines.length} path(s) match an existing file or folder only when letter case is ignored, ` +
      "and a recipe path must use the on-disk spelling so it behaves the same on every filesystem. Nothing was written.\n" +
      lines.join("\n"),
  );
}

/**
 * Refuse a global → local demotion when the variable is referenced from other
 * event sheets — a project-wide global cannot be confined to a single local
 * scope. The check is conservative: it matches the variable name as a whole
 * word in each other sheet's raw JSON (covering both `runtime.globalVars.NAME`
 * script refs and bare-name C3 expression params), so it may over-refuse on a
 * coincidental match; resolve by replacing the external usages or relocating
 * the global first. `$symbol` refs are skipped (they name an in-recipe variable
 * that cannot have pre-existing external references).
 */
function checkMoveVariableDemotions(rootDir: string, files: NonNullable<Recipe["files"]>, log: Logger): void {
  const demotions: Array<{ filePath: string; varName: string }> = [];
  for (const [filePath, entry] of Object.entries(files)) {
    if (isFileCreate(entry)) continue;
    for (const op of entry) {
      if (op.op !== "move-variable" || op.to === "root") continue;
      if (!op.variable.startsWith("sid:")) continue;
      const varName = findVariableNameBySidRef(loadSheet(rootDir, filePath), op.variable);
      if (varName !== null) demotions.push({ filePath, varName });
    }
  }
  if (demotions.length === 0) return;

  const allFiles = find_all_eventsheets_path(openProject(rootDir).eventSheetsDir);
  for (const { filePath, varName } of demotions) {
    const targetResolved = path.resolve(rootDir, filePath);
    const wordRe = new RegExp(`\\b${escapeRegExp(varName)}\\b`);
    const offending: string[] = [];
    for (const fullPath of allFiles) {
      if (path.resolve(fullPath) === targetResolved) continue;
      if (wordRe.test(readFileSync(fullPath, "utf-8"))) {
        offending.push(path.relative(rootDir, fullPath));
      }
    }
    if (offending.length > 0) {
      throw new Error(
        `move-variable: cannot demote global variable "${varName}" to local — it is referenced in ` +
          `${offending.length} other event sheet(s): ${offending.join(", ")}. ` +
          `Replace those usages (e.g. via shared getter/setter functions) or relocate the global first.`,
      );
    }
  }
  log(`move-variable: demotion safety check passed for ${demotions.map((d) => `"${d.varName}"`).join(", ")}`);
}

// ─── SID location lookup (apply-time hinting) ───

/**
 * Reports which slot the given `sid` lives in (event / condition / action /
 * function-parameter), or `null` when truly absent. Thin wrapper over
 * c3source's `findSid`, which owns the schema knowledge of which slots carry
 * sids. Used to enrich the "SID not found in event sheet" / "does not support
 * actions" errors when the SID actually exists on a non-event slot — the
 * canonical trap behind "agents grab a non-event SID surfaced by
 * read-dsl-index". `buildSidIndex` only indexes top-level events, so the
 * SID-resolution path can't otherwise distinguish "totally missing" from
 * "present on a non-event slot".
 */
function findSidLocation(sheet: EventSheet, sid: number): SidSlot | null {
  return findSid(sheet, sid)?.slot ?? null;
}

/**
 * Locate `sid` in either the pre-batch `original` sheet or the post-mutation
 * `clone`, preferring whichever finds a more specific slot. Callers don't know
 * whether the failure is "SID never existed" vs "SID was just inserted by an
 * earlier op" vs "SID was just removed" — checking both views catches all three.
 */
function findSidLocationEither(original: EventSheet, clone: EventSheet, sid: number): SidSlot | null {
  // Try clone first — reflects in-batch insertions and most current state.
  return findSidLocation(clone, sid) ?? findSidLocation(original, sid);
}

/** Build the human-readable "did you mean the parent block?" guidance. */
function sidLocationHint(filePath: string, sid: number, location: SidSlot): string {
  if (location === "event") {
    // The op tried to do something the event kind doesn't support (e.g.
    // insert-actions into a group). Point the user at the parent block.
    return (
      ` (in ${filePath}). ` +
      `Hint: SID ${sid} exists on an event that doesn't support this op kind. ` +
      `Recipe ops like insert-actions / replace-action / patch-action-param target a ` +
      `block (or function-block / custom-ace-block); walk into a child block.sid.`
    );
  }
  return (
    ` (in ${filePath}). ` +
    `Hint: SID ${sid} exists on a ${location}, not on an event. ` +
    `Recipe \`in:\`/\`after:\`/\`before:\` targets must address an event block — ` +
    `walk up to the enclosing block.sid (not block.conditions[].sid, block.actions[].sid, ` +
    `or function-block.functionParameters[].sid).`
  );
}

/**
 * Runs `executeFileOps` against a clone of the original sheet, catching SID
 * resolution and SID kind-mismatch errors to add a location hint when the SID
 * actually lives on a condition / action / function-parameter — or on an event
 * of the wrong kind. Used by both the dry-run pass and the apply pass so
 * validate-recipe and apply-recipe surface the same diagnostics.
 *
 * Preserves the original error's stack/cause when wrapping (Node's
 * `{ cause }` option).
 */
function executeFileOpsWithHints(
  sidGen: SidGenerator,
  filePath: string,
  original: EventSheet,
  clone: EventSheet,
  ops: FileOp[],
  options?: { autoAdjust?: boolean },
): void {
  try {
    executeFileOps(sidGen, clone, ops, options);
  } catch (e) {
    if (!(e instanceof Error)) throw e;

    // (1) "SID not found in event sheet" — the SID didn't resolve at all.
    //     Common cause: the SID lives on a condition / action / function param.
    const notFoundMatch = /^SID (\d+) not found in event sheet/.exec(e.message);
    if (notFoundMatch) {
      const sid = Number(notFoundMatch[1]);
      const location = findSidLocationEither(original, clone, sid);
      if (location && location !== "event") {
        throw new Error(e.message + sidLocationHint(filePath, sid, location), { cause: e });
      }
      throw e;
    }

    // (2) "<op>: target "sid:X" (eventType: "Y") does not support …" — the
    //     SID resolves to an event, but the wrong kind. Point the user at a
    //     child block when the SID names a group / function-block / etc.
    const kindMatch = /target "sid:(\d+)" \(eventType: "[^"]+"\) does not support/.exec(e.message);
    if (kindMatch) {
      const sid = Number(kindMatch[1]);
      throw new Error(e.message + sidLocationHint(filePath, sid, "event"), { cause: e });
    }

    throw e;
  }
}

// ─── Layout op dispatch ───

interface LayoutOpContext {
  rootDir: string;
  uidCounter: { next: number };
  sourceLayoutCache: Map<string, MutatorLayoutJson>;
  sidGen: SidGenerator;
  objectTypes: ObjectTypeCreate[];
  /** Reads a source layout on a `sourceLayoutCache` miss. */
  readText: (abs: string) => string;
}

/**
 * Mutates `layout` by applying a single layout op. Logs the per-op `MODIFIED`
 * line via `log`; for a dry-run validation pass, pass a no-op logger so the
 * caller's own summary log is the only output.
 *
 * Throws (via the underlying layoutMutator) when the op references a missing
 * layer, missing instance type, etc. — that's the apply-time error we want
 * dry-run to surface.
 */
function applyLayoutOp(
  layout: LayoutJson,
  layoutPath: string,
  op: PrimitiveLayoutOp,
  ctx: LayoutOpContext,
  log: Logger,
): void {
  switch (op.op) {
    case "add-nonworld-instance": {
      const uid = ctx.uidCounter.next;
      applyNonworldInstance(ctx.sidGen, layout, op, ctx.uidCounter.next++, ctx.objectTypes);
      log(`  MODIFIED ${layoutPath} (+nonworld ${op.type} uid=${uid})`);
      break;
    }

    case "add-sublayer": {
      const parentLayer = findLayer(layout as MutatorLayoutJson, op.parent);
      if (!parentLayer) {
        throw new Error(`add-sublayer: parent layer "${op.parent}" not found in ${layoutPath}`);
      }
      addSublayer(parentLayer, op.name, op.after ? { after: op.after } : undefined);
      log(`  MODIFIED ${layoutPath} (+sublayer "${op.name}" under "${op.parent}")`);
      break;
    }

    case "add-layer":
      addLayer(layout as MutatorLayoutJson, op.name, op.after ? { after: op.after } : undefined);
      log(`  MODIFIED ${layoutPath} (+layer "${op.name}")`);
      break;

    case "copy-instance": {
      let sourceLayout = ctx.sourceLayoutCache.get(op.from);
      if (!sourceLayout) {
        const sourceFullPath = path.join(ctx.rootDir, op.from);
        sourceLayout = JSON.parse(ctx.readText(sourceFullPath)) as MutatorLayoutJson;
        ctx.sourceLayoutCache.set(op.from, sourceLayout);
      }
      copyInstance({
        sourceLayout,
        targetLayout: layout as MutatorLayoutJson,
        instanceType: op.type,
        includeChildren: op.includeChildren ?? false,
        targetLayer: op.targetLayer,
        childrenLayer: op.childrenLayer,
        uidCounter: ctx.uidCounter,
        sidGenerator: ctx.sidGen,
        overrides: op.overrides,
        childOverrides: op.childOverrides,
      });
      log(`  MODIFIED ${layoutPath} (+copy ${op.type} from ${op.from})`);
      break;
    }

    case "templatize":
      templatize(layout as MutatorLayoutJson, op.type, op.templateName, op.inheritOverrides);
      log(`  MODIFIED ${layoutPath} (templatize ${op.type} as "${op.templateName}")`);
      break;

    case "replicify":
      replicify(layout as MutatorLayoutJson, op.type, op.sourceTemplateName, op.inheritOverrides);
      log(`  MODIFIED ${layoutPath} (replicify ${op.type} as replica of "${op.sourceTemplateName}")`);
      break;

    case "add-replica": {
      let sourceLayout = ctx.sourceLayoutCache.get(op.from);
      if (!sourceLayout) {
        const sourceFullPath = path.join(ctx.rootDir, op.from);
        sourceLayout = JSON.parse(ctx.readText(sourceFullPath)) as MutatorLayoutJson;
        ctx.sourceLayoutCache.set(op.from, sourceLayout);
      }
      addReplica({
        sourceLayout,
        sourceTemplateName: op.sourceTemplateName,
        targetLayout: layout as MutatorLayoutJson,
        targetLayer: op.targetLayer,
        childrenLayer: op.childrenLayer,
        uidCounter: ctx.uidCounter,
        sidGenerator: ctx.sidGen,
        overrides: op.overrides,
        childOverrides: op.childOverrides,
        inheritOverrides: op.inheritOverrides,
      });
      log(`  MODIFIED ${layoutPath} (+replica "${op.sourceTemplateName}" from ${op.from})`);
      break;
    }

    case "remove-instance":
      removeInstance(layout as MutatorLayoutJson, op.type, op.layer);
      log(`  MODIFIED ${layoutPath} (-instance ${op.type}${op.layer ? ` from layer ${op.layer}` : ""})`);
      break;

    case "remove-layer":
      if (op.cascade === true) {
        removeLayerCascade(layout as MutatorLayoutJson, op.layer, { removeInstances: op.removeInstances });
      } else {
        removeLayer(layout as MutatorLayoutJson, op.layer);
      }
      log(`  MODIFIED ${layoutPath} (-layer ${op.layer})`);
      break;

    case "move-instance":
      moveInstance({
        layout: layout as MutatorLayoutJson,
        typeName: op.type,
        targetLayer: op.targetLayer,
        childrenLayer: op.childrenLayer,
        uidCounter: ctx.uidCounter,
        sidGenerator: ctx.sidGen,
      });
      log(`  MODIFIED ${layoutPath} (move ${op.type} → "${op.targetLayer}")`);
      break;

    case "rename-layer":
      renameLayer(layout as MutatorLayoutJson, op.currentName, op.newName);
      log(`  MODIFIED ${layoutPath} (rename layer "${op.currentName}" → "${op.newName}")`);
      break;

    default: {
      // Exhaustiveness check: adding a new PrimitiveLayoutOp variant in
      // recipeInterpreter.ts is a compile error here until this switch is
      // updated. Without this, a new op would silently no-op through both
      // dry-run validation and apply.
      const exhaustive: never = op;
      throw new Error(`applyLayoutOp: unsupported op ${(exhaustive as { op: string }).op}`);
    }
  }
}

/** One `--preview` entry, in recipe.files order, so creates and modifies interleave as the user wrote them. */
type PreviewEntry =
  | { filePath: string; kind: "create"; eventCount: number }
  | { filePath: string; kind: "diff"; diffs: string[] };

/**
 * The compute pass shared by dry-run and apply: Steps 1-3 against the in-memory overlay `io`, narrating through
 * `n`. Dry-run and apply differ only in `n` and in what the caller does with the journal afterwards.
 * Returns whether a file was created that sync-project must register in project.c3proj (#245), and the preview
 * entries (collected only when `preview` is set).
 */
function computeRecipe(
  io: OverlayIo,
  sidGen: SidGenerator,
  rootDir: string,
  recipe: Recipe,
  layoutsForLoop: Map<string, PrimitiveLayoutOp[]>,
  customAceIndex: ReturnType<typeof buildCustomAceIndex> | null,
  n: RecipeNarration,
  preview: boolean,
): { createdNewFile: boolean; previewEntries: PreviewEntry[] } {
  let createdNewFile = false;
  const previewEntries: PreviewEntry[] = [];

  // ─── Step 1: Process objectTypes ───
  if (recipe.objectTypes && recipe.objectTypes.length > 0) {
    n.section("objectTypes");
    for (const ot of recipe.objectTypes) {
      const created = createObjectTypeIo(io, sidGen, rootDir, ot, n.dryRun, n.log);
      if (created) {
        createdNewFile = true;
        updateInstanceTypesIo(io, rootDir, ot, n.dryRun, n.log);
        updateObjectsIo(io, rootDir, ot, n.dryRun, n.log);
      }
    }
    n.sectionEnd();
  }

  // ─── Step 1b: Process addInstVars ───
  if (recipe.addInstVars && recipe.addInstVars.length > 0) {
    n.section("addInstVars");
    // The objectType files Step 1 created are already in the overlay, in both modes, so the lookup finds them.
    processAddInstVarsIo(io, sidGen, rootDir, recipe.addInstVars, n.dryRun, n.log);
    n.sectionEnd();
  }

  // ─── Step 2: Process layouts ───
  // Iterates `layoutsForLoop` (workflow-expanded), so a workflow's fan-out
  // across multiple layout keys is applied as a sequence of primitives —
  // each layout is loaded once, all its ops run, then it's written back.
  if (layoutsForLoop.size > 0) {
    n.section("layouts");
    const layoutsDir = openProject(rootDir).layoutsDir;
    // Reads layouts from disk, not the overlay: valid only because addInstVars (Step 1b) never changes UIDs
    // (see addInstVarsToLayout), so the overlay's layout edits cannot alter the UID set.
    const allUids = collectAllUids(layoutsDir);
    const uidCounter = { next: maxFromSet(allUids) + 1 };
    const sourceLayoutCache = new Map<string, MutatorLayoutJson>();

    for (const [layoutPath, ops] of layoutsForLoop) {
      // Defensive skip: workflowExpansion no longer pre-seeds empty arrays,
      // but a future workflow that conditionally fans out could still emit
      // zero primitives to a key. Skipping prevents a load+write of an
      // unchanged file (which would bump mtime and produce a misleading
      // "MODIFIED" log line).
      if (ops.length === 0) continue;
      n.layout(layoutPath, ops);

      const fullPath = path.join(rootDir, layoutPath);
      const layout = JSON.parse(io.readText(fullPath)) as LayoutJson;
      const ctx: LayoutOpContext = {
        rootDir,
        uidCounter,
        sourceLayoutCache,
        sidGen,
        objectTypes: recipe.objectTypes ?? [],
        readText: io.readText.bind(io),
      };

      for (const op of ops) {
        applyLayoutOp(layout, layoutPath, op, ctx, n.opLog);
      }

      io.writeText(fullPath, serializeSourceJson(layout));
      // A layout cached as a `from:` source before this loop mutated it would be served stale to later layouts.
      sourceLayoutCache.set(layoutPath, layout as MutatorLayoutJson);
    }
    n.sectionEnd();
  }

  // ─── Step 3: Process files ───
  // We do the load → clone → executeFileOps loop ourselves (instead of calling
  // executeRecipe) so the same `executeFileOpsWithHints` wrapper covers both
  // apply and dry-run paths — that gives the SID kind / function-parameter
  // hints to operators running `apply-recipe` directly without a prior
  // `validate-recipe`.
  if (recipe.files && Object.keys(recipe.files).length > 0) {
    n.section("files");
    for (const [filePath, entry] of Object.entries(recipe.files)) {
      const fullPath = path.join(rootDir, filePath);
      if (isFileCreate(entry)) {
        n.fileCreating(filePath, entry.events.length);
        const sheet = createSheet(sidGen, extractSheetName(filePath), entry.events);
        // checkCreateTargets refused any CREATE over an existing path before Step 1 (#249),
        // so every CREATE reaching here writes a file sync-project must register.
        createdNewFile = true;
        assertEditorValid(filePath, sheet);
        // Brand-new sheet: original is empty (no pre-existing events).
        assertCustomActionsValid(customAceIndex, filePath, { ...sheet, events: [] }, sheet);
        io.writeText(fullPath, serializeSourceJson(sheet), { mkdir: true });
        n.fileCreated(filePath);
        if (preview) previewEntries.push({ filePath, kind: "create", eventCount: entry.events.length });
      } else {
        n.fileModifying(filePath, entry);
        // Event sheets are never written by Steps 1-2, so the overlay holds nothing for them; reading through
        // io is equivalent to loadSheet's disk read.
        const original = JSON.parse(io.readText(fullPath)) as EventSheet;
        const clone = JSON.parse(JSON.stringify(original)) as EventSheet;
        const opsClone = JSON.parse(JSON.stringify(entry)) as FileOp[];
        executeFileOpsWithHints(sidGen, filePath, original, clone, opsClone, {
          autoAdjust: recipe.autoAdjust,
        });
        assertEditorValid(filePath, clone);
        assertCustomActionsValid(customAceIndex, filePath, original, clone);
        io.writeText(fullPath, serializeSourceJson(clone));
        n.fileModified(filePath);
        if (preview) previewEntries.push({ filePath, kind: "diff", diffs: diffScripts(filePath, original, clone) });
      }
    }
    n.sectionEnd();
  }

  return { createdNewFile, previewEntries };
}

export function applyRecipeInner(sidGen: SidGenerator, rootDir: string, recipe: Recipe, opts: ApplyOptions = {}) {
  const {
    dryRun = false,
    preview = false,
    regenerate = true,
    log = console.log,
    extractedDir = "extracted",
    beforeSourceWrite,
  } = opts;
  // Validate recipe structure
  const errors = validateRecipe(recipe);
  if (errors.length > 0) {
    throw new Error("Recipe validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  }

  // Letter-case spelling check against the on-disk listing (#253): before expandWorkflows (which reads layouts)
  // and before any write, in dry-run too.
  // The listing is built at most once per apply and shared by checkKeySpelling and checkCreateTargets.
  let spellingListing: string[] | undefined;
  const getSpellingListing = (): string[] => (spellingListing ??= listSpellingCorpus(rootDir));
  checkKeySpelling(recipe, getSpellingListing);

  // Composite workflow ops (extract-template, templatize-in-place,
  // clone-replica-to-layouts, replace-instance-with-replica) expand into
  // primitive layout ops here so dry-run and apply share one expansion and
  // any expansion-time errors (e.g. instance-not-found for
  // replace-instance-with-replica's snapshot) surface in validate-recipe too.
  // The expansion's `loadLayout` cache is separate from the apply loop's
  // `sourceLayoutCache` — the expansion only reads from disk; apply reads
  // and writes its own copies. For typical recipes (one or two workflows)
  // the duplicate disk reads are negligible.
  const expansionCache = new Map<string, MutatorLayoutJson>();
  const loadLayout: LoadLayout = (layoutPath) => {
    let cached = expansionCache.get(layoutPath);
    if (!cached) {
      const fullPath = path.join(rootDir, layoutPath);
      cached = JSON.parse(readFileSync(fullPath, "utf-8")) as MutatorLayoutJson;
      expansionCache.set(layoutPath, cached);
    }
    return cached;
  };
  const layoutsForLoop: Map<string, PrimitiveLayoutOp[]> =
    recipe.layouts && Object.keys(recipe.layouts).length > 0 ? expandWorkflows(recipe, loadLayout) : new Map();

  const objectTypeCount = recipe.objectTypes?.length ?? 0;
  const addInstVarsCount = recipe.addInstVars?.length ?? 0;
  const fileCount = recipe.files ? Object.keys(recipe.files).length : 0;
  // Summary counts mirror what the user wrote, not the post-expansion view —
  // an agent diffing the summary against their recipe JSON should see the
  // same shape. The per-layout `MODIFY ... (N ops)` lines in dry-run output
  // are where the expansion fan-out becomes visible.
  const layoutFileCount = recipe.layouts ? Object.keys(recipe.layouts).length : 0;
  const layoutOpCount = recipe.layouts ? Object.values(recipe.layouts).reduce((sum, ops) => sum + ops.length, 0) : 0;
  const fileOpCount = recipe.files
    ? Object.entries(recipe.files).reduce((sum, [, entry]) => sum + (Array.isArray(entry) ? entry.length : 1), 0)
    : 0;
  const totalOpCount = fileOpCount + layoutOpCount;

  const summaryParts: string[] = [];
  if (objectTypeCount > 0) summaryParts.push(`${objectTypeCount} objectType(s)`);
  if (addInstVarsCount > 0) summaryParts.push(`${addInstVarsCount} addInstVars type(s)`);
  if (fileCount > 0) summaryParts.push(`${fileCount} eventSheet file(s)`);
  if (layoutFileCount > 0) summaryParts.push(`${layoutFileCount} layout file(s)`);
  summaryParts.push(`${totalOpCount} operation(s)`);
  log(`Recipe: ${summaryParts.join(", ")}`);

  // Disk-aware safety checks. Both run before any dry-run output or write, so
  // validate-recipe / --preview surface them too and a refusal lands before
  // Steps 1–2 write anything. (a) a files CREATE must not target an existing
  // sheet (#249); (b) a move-variable global → local demotion is only valid when
  // the global is not referenced from other event sheets.
  if (recipe.objectTypes && recipe.objectTypes.length > 0) checkObjectTypeCreateTargets(rootDir, recipe.objectTypes);
  if (recipe.files && Object.keys(recipe.files).length > 0) {
    checkCreateTargets(rootDir, recipe.files, getSpellingListing);
    checkMoveVariableDemotions(rootDir, recipe.files, log);
  }

  // Build the custom-ACE index once, for the compute pass both modes share.
  // Custom-ACE definitions come from the existing on-disk project (not from
  // the recipe's own inserts), so building it here — after structural
  // validation but before any write — is correct for both paths.
  // Skipped entirely when the recipe has no file ops (no custom-actions to
  // validate, and no eventSheets dir is required to exist).
  const customAceIndex = recipe.files && Object.keys(recipe.files).length > 0 ? buildCustomAceIndex(rootDir) : null;

  // Dry-run and apply run the same compute pass against an in-memory overlay (#280); they differ only in how it
  // is narrated and in what happens to the journal afterwards. Dry-run discards it: no replay, no mkdir, no
  // beforeSourceWrite. Apply replays it. Apply's atomicity (#278, #279) is the same property: nothing reaches
  // disk or the caller's logger until every step has succeeded; only dry-run narrates live, so a refusal still
  // prints the lines before it.
  const io = new OverlayIo();
  if (dryRun) {
    log("\n--- Dry run (no files written) ---\n");
    const { previewEntries } = computeRecipe(
      io,
      sidGen,
      rootDir,
      recipe,
      layoutsForLoop,
      customAceIndex,
      dryRunNarration(log),
      preview,
    );

    if (preview && previewEntries.length > 0) {
      log("--- Preview (script diffs) ---\n");
      for (const entry of previewEntries) {
        if (entry.kind === "create") {
          log(`  CREATE ${entry.filePath} — new file with ${entry.eventCount} event(s)`);
        } else if (entry.diffs.length === 0) {
          log(`  ${entry.filePath} — no script changes`);
        } else {
          log(`  ${entry.filePath}:`);
          for (const d of entry.diffs) {
            log(d);
          }
        }
      }
    }

    log("\nValidation passed. Run without --dry-run to apply.");
    return;
  }

  const { createdNewFile } = computeRecipe(
    io,
    sidGen,
    rootDir,
    recipe,
    layoutsForLoop,
    customAceIndex,
    applyNarration(io.logger()),
    false,
  );

  // Replay. Nothing can refuse after compute, so this loop is the only place apply writes to disk,
  // and therefore the only place `beforeSourceWrite` fires (once per write entry, before it lands).
  for (const entry of io.journal) {
    if (entry.kind === "log") {
      log(...entry.args);
    } else {
      beforeSourceWrite?.(path.resolve(entry.abs));
      if (entry.mkdir) mkdirSync(path.dirname(entry.abs), { recursive: true });
      writeFileSync(entry.abs, entry.text);
    }
  }

  log("\nDone.");
  if (createdNewFile) {
    log(
      "\nReminder: run sync-project (CLI: `construct3-chef sync-project`, or the `sync-project` MCP tool) to register new files with Construct 3.",
    );
  }

  if (regenerate) {
    const written = new Set(io.journal.flatMap((j) => (j.kind === "write" ? [j.abs] : []))).size;
    regenerateAfterWrite(rootDir, extractedDir, written, log);
  }
}

export function applyParsed(rootDir: string, recipe: Recipe, opts: ApplyOptions = {}): void {
  const resolved: ApplyOptions = { ...opts };
  if (resolved.preview) resolved.dryRun = true;

  // Seed the SID generator from the full sid-registry.txt (eventSheets/ + layouts/ + objectTypes/).
  // The closure mutates `used` as SIDs are minted, so every builder call in this recipe shares
  // one cumulative used-SID Set — no init/reset lifecycle needed.
  const registryPath = path.join(rootDir, opts.extractedDir ?? "extracted", "sid-registry.txt");
  const used = readRegistryFile(registryPath);

  // Defence-in-depth against a stale registry: for every layout this recipe touches,
  // union the on-disk SIDs into `used` so layout ops can't mint a SID already present
  // in the file. The registry covers layouts/ but may lag behind a prior apply with
  // `regenerate: false` or a watcher-missed external edit.
  // The keys are canonicalized by `seedLayoutSids` (a bare `Gameplay/Main Layout` is read from `layouts/…json`):
  // this runs before `normalizeRecipePaths`, so a raw join would miss every bare key (#253).
  seedLayoutSids(rootDir, recipe.layouts, used);

  const sidGen = makeSidGen(used);
  applyRecipeInner(sidGen, rootDir, recipe, resolved);
}

// ─── Rename symbols function ───

export function renameSymbols(
  rootDir: string,
  replacements: Array<{ from: string; to: string }>,
  dryRun: boolean,
  preview: boolean,
  regenerate: boolean,
  extractedDir = "extracted",
  log: Logger = console.log,
) {
  if (preview) dryRun = true;

  // Validate replacements
  for (const r of replacements) {
    if (!r.from) {
      throw new Error("replacement 'from' field must be non-empty");
    }
  }

  log(`Replacements (${replacements.length}):`);
  for (const r of replacements) {
    log(`  ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
  }

  // Discover all eventSheet files
  const allFiles = find_all_eventsheets_path(openProject(rootDir).eventSheetsDir);
  log(`\nScanning ${allFiles.length} eventSheet file(s)...\n`);

  // Apply replacements to each file
  const matched: Array<{ filePath: string; count: number; original: EventSheet; modified: EventSheet }> = [];

  for (const fullPath of allFiles) {
    const relPath = path.relative(rootDir, fullPath);
    const original = loadSheet(rootDir, relPath);
    const clone = JSON.parse(JSON.stringify(original)) as EventSheet;
    const count = applyReplacements(clone, replacements);
    if (count > 0) {
      matched.push({ filePath: relPath, count, original, modified: clone });
    }
  }

  if (matched.length === 0) {
    const fromList = replacements.map((r) => `"${r.from}"`).join(", ");
    throw new Error(`No matches found in any eventSheet. Searched for: ${fromList}`);
  }

  const totalActions = matched.reduce((sum, m) => sum + m.count, 0);
  log(`Found ${totalActions} modified script action(s) across ${matched.length} file(s):`);
  for (const m of matched) {
    log(`  ${m.filePath} (${m.count} action(s))`);
  }

  // Validate every sheet before anything is written or previewed, so a refusal writes nothing and
  // dry-run, preview and apply refuse alike (#283).
  for (const m of matched) assertEditorValid(m.filePath, m.modified);

  if (preview) {
    log("\n--- Preview (script diffs) ---\n");
    for (const m of matched) {
      const diffs = diffScripts(m.filePath, m.original, m.modified);
      if (diffs.length === 0) {
        log(`  ${m.filePath} — no script changes`);
      } else {
        log(`  ${m.filePath}:`);
        for (const d of diffs) {
          log(d);
        }
      }
    }
  }

  if (dryRun) {
    log("\nDry run complete. Run without --dry-run to apply.");
    return;
  }

  // Write modified files
  for (const m of matched) {
    const fullPath = path.join(rootDir, m.filePath);
    writeSourceJson(fullPath, m.modified);
    log(`  MODIFIED ${m.filePath}`);
  }

  log(`\nDone. ${matched.length} file(s) modified, ${totalActions} script action(s) updated.`);

  if (regenerate) {
    regenerateAfterWrite(rootDir, extractedDir, matched.length, log);
  }
}
