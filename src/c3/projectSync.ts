import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "@genvidtech/mcp-utils";
import {
  readProjectManifest,
  serializeProjectManifest,
  writeProjectManifest,
  detectImageDrift,
  detectManifestDrift,
  detectStrayFiles,
  diffNameMaps,
  EXTENSION_FILE_TYPES,
  fileTypeForName,
  type DriftEntry,
  type StrayFile,
  TIMELINE_TRANSITIONS_FOLDER,
} from "@genvidtech/c3source";
import { mintUniqueSid } from "./sidUtils.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FileItem {
  name: string;
  type: string;
  sid: number;
  [infoKey: string]: any; // "script-info", "file-info", or "icon-info"
}

export interface FileFolder {
  items: FileItem[];
  subfolders: FileFolder[];
  name?: string;
}

export interface NameFolder {
  items: string[];
  subfolders: NameFolder[];
  name?: string;
}

export interface FileSectionConfig {
  key: string;
  diskDir: string;
  infoKey: string;
  extensions?: string[];
  ignorePaths?: string[];
  ignoreDirs?: string[];
}

export interface NameSectionConfig {
  key: string;
  diskDir: string;
  /**
   * @deprecated Dead since #47. Declared here and set `true` on all six
   * NAME_SECTIONS but READ NOWHERE in src/ or test/: name-section sync was
   * rerouted through c3source's `detectManifestDrift` + the local
   * `applyNameDrift`, and `detectManifestDrift` already delegates to
   * `isEditorLocalPath` internally — so the editor-local skip this flag once
   * controlled is now upstream's, unconditionally.
   *
   * Retained (not deleted) because `NameSectionConfig` is barrel-exported
   * (src/index.ts:7) and the repo is at 1.0.0; removal is a MAJOR bump.
   * Delete at the next major. #146.
   */
  ignoreUistate: boolean;
}

export interface Change {
  section: string;
  action: "+" | "-";
  detail: string;
  /** The change was reported but not applied to the manifest. */
  withheld?: true;
  /** On a move's `-` half: the destination display path. */
  movedTo?: string;
  /** On a move's `+` half: the source display path. */
  movedFrom?: string;
}

export interface SectionSummary {
  added: number;
  removed: number;
}

export interface SyncResult {
  changes: Change[];
  clean: boolean;
  sections: Record<string, SectionSummary>;
  /** true iff this call wrote project.c3proj. */
  wrote: boolean;
}

// ---------------------------------------------------------------------------
// Section configs
// ---------------------------------------------------------------------------

export const FILE_SECTIONS: FileSectionConfig[] = [
  {
    key: "script",
    diskDir: "scripts",
    infoKey: "script-info",
    extensions: [".ts"],
    ignorePaths: ["tsconfig.json"],
    ignoreDirs: ["ts-defs"],
  },
  { key: "sound", diskDir: "sounds", infoKey: "file-info", extensions: [".webm"] },
  { key: "music", diskDir: "music", infoKey: "file-info", extensions: [".webm"] },
  { key: "font", diskDir: "fonts", infoKey: "file-info", extensions: [".ttf"] },
  { key: "icon", diskDir: "icons", infoKey: "icon-info", extensions: [".png"] },
  { key: "general", diskDir: "files", infoKey: "file-info" }, // no extension filter — mixed types
];

export const NAME_SECTIONS: NameSectionConfig[] = [
  { key: "layouts", diskDir: "layouts", ignoreUistate: true },
  { key: "eventSheets", diskDir: "eventSheets", ignoreUistate: true },
  { key: "families", diskDir: "families", ignoreUistate: true },
  { key: "objectTypes", diskDir: "objectTypes", ignoreUistate: true },
  { key: "timelines", diskDir: "timelines", ignoreUistate: true },
  { key: "flowcharts", diskDir: "flowcharts", ignoreUistate: true },
];

export const ALL_SECTION_KEYS = [...FILE_SECTIONS.map((s) => s.key), ...NAME_SECTIONS.map((s) => s.key)];

// ---------------------------------------------------------------------------
// MIME type inference
// ---------------------------------------------------------------------------

/**
 * Dotted, lowercase file extension → the `type` c3source records for a C3 file entry.
 * The table is observed rather than specified, tiered AUDITED / UNVALIDATED, and known
 * to be incomplete; see `EXTENSION_FILE_TYPES` for which tier each entry is in.
 *
 * @deprecated Use `EXTENSION_FILE_TYPES` / `fileTypeForName` from `@genvidtech/c3source`,
 * which owns this fact (#236). Kept because it is public API through the barrel. It is
 * the upstream table itself, not a copy, so writing an entry here changes what
 * {@link inferMimeType} returns. That write also changes c3source's own table for every
 * importer in the process.
 */
export const MIME_MAP: Record<string, string> = EXTENSION_FILE_TYPES;

/**
 * The `type` to record for a newly synced file entry named `filename`. Delegates to
 * c3source's `fileTypeForName`, which falls back to `application/octet-stream` for an
 * unknown or missing extension.
 */
export function inferMimeType(filename: string): string {
  return fileTypeForName(filename);
}

// ---------------------------------------------------------------------------
// SID generation
// ---------------------------------------------------------------------------

export function collectAllSids(project: any): Set<number> {
  const sids = new Set<number>();

  function collectFromFileFolder(folder: FileFolder): void {
    for (const item of folder.items) {
      sids.add(item.sid);
    }
    for (const sub of folder.subfolders) {
      collectFromFileFolder(sub);
    }
  }

  const rff = project.rootFileFolders;
  if (rff) {
    for (const key of Object.keys(rff)) {
      collectFromFileFolder(rff[key]);
    }
  }

  return sids;
}

/**
 * Deprecated thin wrapper kept for backward compatibility. Delegates to
 * `mintUniqueSid` from sidUtils — strict [1e14, 1e15) range with a 100-attempt
 * collision cap (vs. the historical unbounded `do/while` in this file).
 */
export function generateSid(existingSids: Set<number>): number {
  return mintUniqueSid(existingSids);
}

// ---------------------------------------------------------------------------
// Disk reading helpers
// ---------------------------------------------------------------------------

export interface DiskTree {
  files: string[];
  dirs: string[];
}

/**
 * Read ONE directory level: its (filtered) file names and its subdirectory names.
 *
 * NOT routed through c3source's `find_all_files_path` / `isEditorLocalPath`.
 * That delegation was proposed by #146 and DECLINED on shape-fit grounds — see
 * ADR `wiki/decisions/0016-shared-file-walk-adoption-triage.md`. Three
 * independent mismatches, any ONE of which is sufficient:
 *
 * 1. IT RETURNS DIRECTORIES. `syncFileFolder` mirrors the disk folder tree into
 *    `rootFileFolders[].subfolders[]` and emits `+ foo/ (new folder)` / `- foo/`
 *    change lines from `DiskTree.dirs` (`planFileLevel` and the emit step). A flat, files-only primitive
 *    structurally CANNOT report an empty disk directory that must nonetheless
 *    become a manifest subfolder.
 *
 * 2. IT MUST BE PER-LEVEL, NOT RECURSIVE. `syncFileFolder` owns the recursion so
 *    it can descend in lockstep with the manifest folder object it mutates
 *    (`planFileLevel`'s recursion), and it deliberately DROPS the root-level `ignorePaths` /
 *    `ignoreDirs` at depth >= 1 (the `subConfig` in `planFileLevel`). A self-recursing walk owns the
 *    traversal, so it can neither be stepped alongside the manifest tree nor
 *    vary its filter by depth.
 *
 * 3. THE IGNORE RULES ARE NOT ALL EDITOR-LOCAL CLASSIFICATION. `ignorePaths:
 *    ["tsconfig.json"]` and `ignoreDirs: ["ts-defs"]` (both on the `script` entry of
 *    `FILE_SECTIONS`) ARE covered
 *    by c3source's `EDITOR_LOCAL_EXCLUSIONS`, but the `extensions` filters
 *    (`.ts` / `.webm` / `.ttf` / `.png`, on the `script`, `sound`, `music`, `font` and `icon` entries) encode
 *    manifest-section MEMBERSHIP semantics, about which upstream has — and
 *    should have — no opinion.
 *
 * Consequence: delegating ONLY the ignore predicate would be a BEHAVIOUR CHANGE,
 * not a refactor. The exclusions would newly apply at every nesting level, and
 * `uistate` would newly be excluded from all six file sections. `sync-project`'s
 * output must not change inside a refactor PR.
 *
 * Precedent: the same "owning the fact upstream isn't sufficient — the
 * primitive's SHAPE must fit the consuming operation" call was made for #42 (the
 * flat `detectManifestDrift` that couldn't back a nested mutating sync); see ADR
 * `wiki/decisions/0006-upstream-ownership-boundary-and-adoption-posture.md`.
 */
export function readDiskDir(
  dirPath: string,
  extensions: string[] | undefined,
  ignorePaths: string[] | undefined,
  ignoreDirs: string[] | undefined,
): DiskTree {
  if (!existsSync(dirPath)) {
    return { files: [], dirs: [] };
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  const dirs: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreDirs && ignoreDirs.includes(entry.name)) continue;
      dirs.push(entry.name);
    } else if (entry.isFile()) {
      if (ignorePaths && ignorePaths.includes(entry.name)) continue;
      if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      files.push(entry.name);
    }
  }

  return { files, dirs };
}

// ---------------------------------------------------------------------------
// File-based section sync
// ---------------------------------------------------------------------------

/** A manifest-side occurrence in the plan: the item, the folder that holds it, and its section-relative folder path. */
interface PlanManifestEntry {
  name: string;
  path: string[];
  item: FileItem;
  owner: FileFolder;
}

/** One disk directory level of the plan, paired with the manifest folder that mirrors it (absent when the folder is new). */
interface PlanNode {
  segs: string[];
  /** The manifest folder at this level; set for a new folder only once the apply step creates it. */
  target: FileFolder | undefined;
  parent: PlanNode | undefined;
  name: string | undefined;
  isNew: boolean;
  disk: DiskTree;
  children: PlanNode[];
  /** Named manifest subfolders with no disk directory. */
  removedSubs: FileFolder[];
}

interface PlanContext {
  manifest: PlanManifestEntry[];
  diskList: Array<{ name: string; path: string[] }>;
}

/** Add `folder`'s whole subtree (items and nested named folders) to the manifest list. */
function collectManifestSubtree(folder: FileFolder, segs: string[], ctx: PlanContext): void {
  for (const item of folder.items) ctx.manifest.push({ name: item.name, path: segs, item, owner: folder });
  for (const sub of folder.subfolders) {
    if (sub.name !== undefined) collectManifestSubtree(sub, [...segs, sub.name], ctx);
  }
}

/**
 * The plan step of {@link syncFileFolder}: a lockstep walk of one disk directory and its manifest folder
 * (readDiskDir per level, root-only ignores, named subfolders only). A manifest subfolder with no disk
 * directory contributes its whole subtree to the manifest list.
 */
function planFileLevel(
  folder: FileFolder | undefined,
  diskPath: string,
  segs: string[],
  config: FileSectionConfig,
  ctx: PlanContext,
  parent: PlanNode | undefined,
  name: string | undefined,
): PlanNode {
  const disk = readDiskDir(diskPath, config.extensions, config.ignorePaths, config.ignoreDirs);
  const node: PlanNode = {
    segs,
    target: folder,
    parent,
    name,
    isNew: folder === undefined,
    disk,
    children: [],
    removedSubs: [],
  };
  if (folder) {
    for (const item of folder.items) ctx.manifest.push({ name: item.name, path: segs, item, owner: folder });
  }
  for (const file of disk.files) ctx.diskList.push({ name: file, path: segs });

  // For subdirectories, don't apply root-level ignorePaths/ignoreDirs
  const subConfig = { ...config, ignorePaths: undefined, ignoreDirs: undefined };
  for (const dirName of disk.dirs) {
    const existing = folder?.subfolders.find((s) => s.name === dirName);
    node.children.push(
      planFileLevel(existing, path.join(diskPath, dirName), [...segs, dirName], subConfig, ctx, node, dirName),
    );
  }
  if (folder) {
    const diskDirSet = new Set(disk.dirs);
    for (const sub of folder.subfolders) {
      if (sub.name !== undefined && !diskDirSet.has(sub.name)) {
        node.removedSubs.push(sub);
        collectManifestSubtree(sub, [...segs, sub.name], ctx);
      }
    }
  }
  return node;
}

interface SyncFileOps {
  folderAdds: PlanNode[];
  moves: Array<{ owner: FileFolder; item: FileItem; dest: PlanNode }>;
  adds: Array<{ dest: PlanNode; item: FileItem }>;
  removes: Array<{ owner: FileFolder; item: FileItem }>;
  folderRemoves: Array<{ node: PlanNode; sub: FileFolder }>;
}

/**
 * Sync one file section's folder tree to `diskPath`: mirror the disk's files and subdirectories into
 * `folder`, reporting each difference in `changes` (and applying it unless `dryRun`).
 *
 * Plan (walk both trees), classify (c3source's `diffNameMaps`, the rule name sections use: a name occurring
 * exactly once on each side at different paths is a move, so the entry keeps its sid), then emit changes in
 * walk order and, in write mode, apply them: folder adds, moves, item adds, item removes, folder removes.
 */
export function syncFileFolder(
  folder: FileFolder,
  diskPath: string,
  relativePath: string,
  config: FileSectionConfig,
  existingSids: Set<number>,
  changes: Change[],
  dryRun: boolean,
  opts?: { withhold?: boolean },
): void {
  const withhold = opts?.withhold === true;
  const ctx: PlanContext = { manifest: [], diskList: [] };
  const root = planFileLevel(folder, diskPath, [], config, ctx, undefined, undefined);

  // Classify
  const keyOf = (name: string, segs: string[]): string => JSON.stringify([segs.join("/"), name]);
  const missing = new Set<string>();
  const untracked = new Set<string>();
  const movedFrom = new Map<string, { diskPath: string[] }>();
  const movedTo = new Map<string, { manifestPath: string[]; item: FileItem; owner: FileFolder }>();
  const manifestByKey = new Map<string, PlanManifestEntry>();
  for (const m of ctx.manifest) manifestByKey.set(keyOf(m.name, m.path), m);
  for (const entry of diffNameMaps(ctx.manifest, ctx.diskList)) {
    if (entry.kind === "missing") missing.add(keyOf(entry.name, entry.manifestPath ?? []));
    else if (entry.kind === "untracked") untracked.add(keyOf(entry.name, entry.diskPath ?? []));
    else if (entry.kind === "moved") {
      const from = entry.manifestPath ?? [];
      const to = entry.diskPath ?? [];
      const src = manifestByKey.get(keyOf(entry.name, from));
      if (!src) continue;
      movedFrom.set(keyOf(entry.name, from), { diskPath: to });
      movedTo.set(keyOf(entry.name, to), { manifestPath: from, item: src.item, owner: src.owner });
    }
  }

  const display = (segs: string[], name: string): string =>
    [relativePath, ...segs, name].filter((s) => s !== "").join("/");
  const ops: SyncFileOps = { folderAdds: [], moves: [], adds: [], removes: [], folderRemoves: [] };

  /** A manifest item's `-` change: a move-from half when classified moved, else a plain removal. */
  const removalChange = (item: FileItem, segs: string[]): Change => {
    const moved = movedFrom.get(keyOf(item.name, segs));
    const change: Change = { section: config.key, action: "-", detail: display(segs, item.name) };
    if (moved) change.movedTo = display(moved.diskPath, item.name);
    if (withhold) change.withheld = true;
    return change;
  };

  const folderRemovalChange = (detail: string): Change => {
    const change: Change = { section: config.key, action: "-", detail };
    if (withhold) change.withheld = true;
    return change;
  };

  /** Everything inside a removed subfolder, depth-first: items before nested folders, each folder after its contents. */
  const emitRemovedContents = (sub: FileFolder, segs: string[]): void => {
    for (const item of sub.items) changes.push(removalChange(item, segs));
    for (const nested of sub.subfolders) {
      if (nested.name === undefined) continue;
      const nestedSegs = [...segs, nested.name];
      emitRemovedContents(nested, nestedSegs);
      changes.push(folderRemovalChange(`${display(segs, nested.name)}/`));
    }
  };

  const emit = (node: PlanNode): void => {
    // Item removals (including move-from halves)
    for (const item of node.target?.items ?? []) {
      const key = keyOf(item.name, node.segs);
      if (movedFrom.has(key) || missing.has(key)) {
        changes.push(removalChange(item, node.segs));
        if (!movedFrom.has(key) && !withhold) ops.removes.push({ owner: node.target!, item });
      }
    }
    // Item additions (including move-to halves)
    for (const file of node.disk.files) {
      const key = keyOf(file, node.segs);
      const moved = movedTo.get(key);
      if (moved) {
        // Both halves of a move are withheld as a unit: the item stays put and nothing lands at the destination.
        const addHalf: Change = {
          section: config.key,
          action: "+",
          detail: `${display(node.segs, file)} (kept sid=${moved.item.sid})`,
          movedFrom: display(moved.manifestPath, file),
        };
        if (withhold) addHalf.withheld = true;
        changes.push(addHalf);
        if (!withhold) ops.moves.push({ owner: moved.owner, item: moved.item, dest: node });
      } else if (untracked.has(key)) {
        const sid = generateSid(existingSids);
        changes.push({ section: config.key, action: "+", detail: `${display(node.segs, file)} (new, sid=${sid})` });
        ops.adds.push({
          dest: node,
          item: { name: file, type: inferMimeType(file), sid, [config.infoKey]: { purpose: "none" } },
        });
      }
    }
    // New folders
    for (const child of node.children) {
      if (child.isNew) {
        changes.push({ section: config.key, action: "+", detail: `${display(node.segs, child.name!)}/ (new folder)` });
        ops.folderAdds.push(child);
      }
    }
    // Removed folders: contained entries first, then the folder itself
    for (const sub of node.removedSubs) {
      emitRemovedContents(sub, [...node.segs, sub.name!]);
      changes.push(folderRemovalChange(`${display(node.segs, sub.name!)}/`));
      if (!withhold) ops.folderRemoves.push({ node, sub });
    }
    for (const child of node.children) emit(child);
  };
  emit(root);

  if (dryRun) return;

  // Apply: folder adds -> moves -> item adds -> item removes -> folder removes
  for (const child of ops.folderAdds) {
    const created: FileFolder = { items: [], subfolders: [], name: child.name };
    child.target = created;
    child.parent!.target!.subfolders.push(created);
  }
  for (const mv of ops.moves) {
    mv.owner.items = mv.owner.items.filter((i) => i !== mv.item);
    mv.dest.target!.items.push(mv.item);
  }
  for (const add of ops.adds) add.dest.target!.items.push(add.item);
  for (const rm of ops.removes) rm.owner.items = rm.owner.items.filter((i) => i !== rm.item);
  for (const fr of ops.folderRemoves)
    fr.node.target!.subfolders = fr.node.target!.subfolders.filter((s) => s !== fr.sub);
}

// ---------------------------------------------------------------------------
// DriftEntry-driven name-section apply engine
// ---------------------------------------------------------------------------

/**
 * The segment a subfolder contributes to a drift path, mirroring c3source's manifest walk:
 * a named folder contributes its name; the nameless direct child of the timelines root
 * contributes `TIMELINE_TRANSITIONS_FOLDER`; any other nameless folder contributes nothing
 * (it is transparent) and returns undefined.
 */
function segmentOf(sub: NameFolder, parentIsRoot: boolean, sectionKey: string): string | undefined {
  if (sub.name !== undefined) return sub.name;
  return parentIsRoot && sectionKey === "timelines" ? TIMELINE_TRANSITIONS_FOLDER : undefined;
}

/** `f` plus every folder reachable from it through transparent (segment-less) nameless links. */
function withTransparent(f: NameFolder, isRoot: boolean, sectionKey: string): NameFolder[] {
  const out: NameFolder[] = [f];
  for (const s of f.subfolders) {
    if (segmentOf(s, isRoot, sectionKey) === undefined) out.push(...withTransparent(s, false, sectionKey));
  }
  return out;
}

/**
 * Every folder whose upstream drift path equals `segments` (the inverse of c3source's
 * manifest walk). Several folders can share a path because transparent folders merge into
 * their parent's path.
 */
function foldersAt(sectionFolder: NameFolder, segments: string[], sectionKey: string): NameFolder[] {
  let level = withTransparent(sectionFolder, true, sectionKey).map((f) => ({ f, isRoot: f === sectionFolder }));
  for (const seg of segments) {
    const next: typeof level = [];
    for (const { f, isRoot } of level) {
      for (const s of f.subfolders) {
        if (segmentOf(s, isRoot, sectionKey) !== seg) continue;
        for (const e of withTransparent(s, false, sectionKey)) next.push({ f: e, isRoot: false });
      }
    }
    level = next;
  }
  return level.map((x) => x.f);
}

/**
 * Resolve `segments` to a folder, creating missing segments. At the timelines root the
 * `transitions` segment resolves to the existing nameless container; when none exists a
 * nameless one is created at index 0 (never a folder named "transitions").
 */
function ensureFolder(sectionFolder: NameFolder, segments: string[], sectionKey: string): NameFolder {
  let cur = sectionFolder;
  for (let i = 0; i < segments.length; i++) {
    const found = foldersAt(sectionFolder, segments.slice(0, i + 1), sectionKey)[0];
    if (found) {
      cur = found;
      continue;
    }
    const seg = segments[i];
    if (i === 0 && sectionKey === "timelines" && seg === TIMELINE_TRANSITIONS_FOLDER) {
      cur = { items: [], subfolders: [] };
      sectionFolder.subfolders.unshift(cur);
    } else {
      cur = { items: [], subfolders: [], name: seg };
      foldersAt(sectionFolder, segments.slice(0, i), sectionKey)[0].subfolders.push(cur);
    }
  }
  return cur;
}

function unresolvable(sectionKey: string, entry: DriftEntry): Error {
  return new Error(`sync: cannot apply ${entry.kind} drift for ${sectionKey} "${entry.name}"`);
}

function itemDisplay(pathSegs: string[], name: string): string {
  return pathSegs.length ? `${pathSegs.join("/")}/${name}` : name;
}

function folderDisplay(pathSegs: string[]): string {
  return `${pathSegs.join("/")}/`;
}

/**
 * Apply a list of DriftEntry records to a NameFolder section.
 * Handles missing (remove item), untracked (add item), moved (remove+add),
 * folder-missing (remove subfolder), folder-untracked (add subfolder).
 * dangling-ref entries are silently ignored (name sections don't produce them).
 */
export function applyNameDrift(
  folder: NameFolder,
  entries: DriftEntry[],
  sectionKey: string,
  changes: Change[],
  dryRun: boolean,
  opts?: { withhold?: boolean },
): void {
  const withhold = opts?.withhold === true;
  // A withheld removal is reported but never applied; a move is withheld as a unit (both halves).
  const mutate = !dryRun && !withhold;
  for (const entry of entries) {
    switch (entry.kind) {
      case "untracked": {
        // On disk, not in manifest → ADD
        if (!dryRun) ensureFolder(folder, entry.diskPath ?? [], sectionKey).items.push(entry.name);
        changes.push({ section: sectionKey, action: "+", detail: itemDisplay(entry.diskPath ?? [], entry.name) });
        break;
      }
      case "missing":
      case "moved": {
        // In manifest, not on disk → REMOVE (a move is remove@manifestPath + add@diskPath)
        const target = foldersAt(folder, entry.manifestPath ?? [], sectionKey).find((f) =>
          f.items.includes(entry.name),
        );
        if (!target) throw unresolvable(sectionKey, entry);
        if (mutate) target.items = target.items.filter((n) => n !== entry.name);
        const fromDisplay = itemDisplay(entry.manifestPath ?? [], entry.name);
        const removal: Change = { section: sectionKey, action: "-", detail: fromDisplay };
        if (withhold) removal.withheld = true;
        changes.push(removal);
        if (entry.kind === "moved") {
          if (mutate) ensureFolder(folder, entry.diskPath ?? [], sectionKey).items.push(entry.name);
          const toDisplay = itemDisplay(entry.diskPath ?? [], entry.name);
          removal.movedTo = toDisplay;
          const addHalf: Change = { section: sectionKey, action: "+", detail: toDisplay, movedFrom: fromDisplay };
          if (withhold) addHalf.withheld = true;
          changes.push(addHalf);
        }
        break;
      }
      case "folder-untracked": {
        // Disk subdir with no manifest subfolder → ADD
        // diskPath includes the new folder name as last segment; ensureFolder creates it
        if (!dryRun) ensureFolder(folder, entry.diskPath ?? [], sectionKey);
        changes.push({
          section: sectionKey,
          action: "+",
          detail: `${folderDisplay(entry.diskPath ?? [])} (new folder)`,
        });
        break;
      }
      case "folder-missing": {
        // Manifest subfolder with no disk dir → REMOVE
        const pathSegs = entry.manifestPath ?? [];
        const leaf = pathSegs.at(-1);
        if (!leaf) throw unresolvable(sectionKey, entry);
        let hit: { parent: NameFolder; child: NameFolder } | undefined;
        for (const parent of foldersAt(folder, pathSegs.slice(0, -1), sectionKey)) {
          const isRoot = parent === folder;
          const matches = parent.subfolders.filter((s) => segmentOf(s, isRoot, sectionKey) === leaf);
          // Prefer a named folder over the nameless timelines container.
          const child = matches.find((s) => s.name !== undefined) ?? matches[0];
          if (child) {
            hit = { parent, child };
            break;
          }
        }
        if (!hit) throw unresolvable(sectionKey, entry);
        const { parent, child } = hit;
        if (mutate) parent.subfolders = parent.subfolders.filter((s) => s !== child);
        const folderRemoval: Change = { section: sectionKey, action: "-", detail: folderDisplay(pathSegs) };
        if (withhold) folderRemoval.withheld = true;
        changes.push(folderRemoval);
        break;
      }
      case "dangling-ref":
        // Name sections don't produce this; ignore.
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main sync entry point
// ---------------------------------------------------------------------------

/**
 * Render a sync run's changes as the lines `runSync` logs: one line per change
 * (grouped by section, in `sectionKeys` order), a `(no changes)` line for each
 * empty section, then the summary. `Updated <path>` is not included; `runSync`
 * logs it itself after the write.
 *
 * This is the single renderer both the CLI and MCP surfaces reach through
 * `runSync`, so their output cannot drift.
 */
export function formatSyncReport(changes: Change[], sectionKeys: string[]): string[] {
  const lines: string[] = [];
  for (const key of sectionKeys) {
    const sectionChanges = changes.filter((c) => c.section === key);
    if (sectionChanges.length === 0) {
      lines.push(`[${key}]`.padEnd(16) + "(no changes)");
    } else {
      for (const change of sectionChanges) {
        let line = `[${change.section}]`.padEnd(16) + `${change.action} ${change.detail}`;
        if (change.movedTo !== undefined) line += ` (moved to ${change.movedTo})`;
        else if (change.movedFrom !== undefined) line += ` (moved from ${change.movedFrom})`;
        if (change.withheld) line += " [withheld]";
        lines.push(line);
      }
    }
  }

  if (changes.length === 0) {
    lines.push("\nAll sections in sync.");
  } else {
    const additions = changes.filter((c) => c.action === "+").length;
    const removals = changes.filter((c) => c.action === "-").length;
    lines.push(`\n${changes.length} change(s) found: ${additions} addition(s), ${removals} removal(s).`);
    const withheld = changes.filter((c) => c.action === "-" && c.withheld).length;
    if (withheld > 0) {
      lines.push(
        `${withheld} removal(s) withheld: sync-project applies a removal only with prune (CLI --prune, MCP prune: true). Restore the missing files, or sync with prune to remove the entries.`,
      );
    }
  }
  return lines;
}

export function runSync(
  rootDir: string,
  dryRun: boolean,
  log: Logger = console.log,
  section?: string,
  opts?: { beforeWrite?: (manifestPath: string) => void; prune?: boolean },
): SyncResult {
  // Task 4 of #346: prune still defaults to true here; the default flips once the callers are wired.
  const withhold = !(opts?.prune ?? true);
  const projectPath = path.join(rootDir, "project.c3proj");

  // readProjectManifest reads + parses + validates the manifest shape in one call.
  // Preserve our two-message contract by discriminating on the error type: a
  // filesystem read failure carries an errno `code` (ENOENT/EACCES/...), whereas
  // both a JSON SyntaxError and c3source's shape-violation Error do not. So a
  // coded error → "Could not read"; anything else → "Could not parse". The shape
  // check is new behavior: a valid-JSON-but-malformed manifest (missing required
  // fields) previously slipped past JSON.parse and crashed downstream — it now
  // fails fast here.
  let project: any;
  try {
    project = readProjectManifest(projectPath) as any;
  } catch (err: unknown) {
    if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string") {
      throw new Error(`Could not read ${projectPath}`);
    }
    throw new Error(`Could not parse ${projectPath} as JSON`);
  }

  // Snapshot before any section mutates `project`: the write below happens only if the
  // serialized bytes actually moved (reported changes are not necessarily mutations).
  const serializedBefore = serializeProjectManifest(project);
  const existingSids = collectAllSids(project);
  const allChanges: Change[] = [];

  // Determine which sections to sync
  const fileSections = FILE_SECTIONS.filter((s) => !section || s.key === section);
  const nameSections = NAME_SECTIONS.filter((s) => !section || s.key === section);

  // Sync file-based sections
  for (const config of fileSections) {
    const folder: FileFolder = project.rootFileFolders[config.key];
    if (!folder) {
      log(`Warning: rootFileFolders.${config.key} not found in project.c3proj`);
      continue;
    }
    const diskPath = path.join(rootDir, config.diskDir);
    syncFileFolder(folder, diskPath, "", config, existingSids, allChanges, dryRun, { withhold });
  }

  // Sync name-based sections via detectManifestDrift + applyNameDrift
  const nameKeys = new Set(nameSections.map((c) => c.key));
  const drift = detectManifestDrift(rootDir, project);
  for (const s of drift.sections) {
    if (!nameKeys.has(s.section)) continue; // exclude rootFileFolders.*, models3d, containers, images
    const folder: NameFolder = project[s.section];
    if (!folder) {
      log(`Warning: ${s.section} not found in project.c3proj`);
      continue;
    }
    applyNameDrift(folder, s.entries, s.section, allChanges, dryRun, { withhold });
  }

  // Print results
  const sectionKeys = [...fileSections.map((s) => s.key), ...nameSections.map((s) => s.key)];
  for (const line of formatSyncReport(allChanges, sectionKeys)) log(line);

  const totalChanges = allChanges.length;

  // Write updated project.c3proj
  // `project.c3proj` also has a second writer: `applyAddonMetadataSync` in
  // `addonMetadataSync.ts`. Serialization is now shared (writeProjectManifest), but byte
  // fidelity still depends on a convention nothing enforces: `project` was parsed by
  // identity (readProjectManifest, above) and every drift fix mutates it in place. Never
  // rebuild it via spread, or this write and that one will silently clobber each other's
  // unmodeled fields.
  let wrote = false;
  if (!dryRun && totalChanges > 0 && serializeProjectManifest(project) !== serializedBefore) {
    opts?.beforeWrite?.(path.resolve(projectPath));
    writeProjectManifest(projectPath, project);
    log(`Updated ${projectPath}`);
    wrote = true;
  }

  const sections: Record<string, SectionSummary> = {};
  for (const key of sectionKeys) {
    const sectionChanges = allChanges.filter((c) => c.section === key);
    sections[key] = {
      added: sectionChanges.filter((c) => c.action === "+").length,
      removed: sectionChanges.filter((c) => c.action === "-").length,
    };
  }

  return { changes: allChanges, clean: allChanges.length === 0, sections, wrote };
}

// ---------------------------------------------------------------------------
// Image drift (detection-only report)
// ---------------------------------------------------------------------------

/**
 * Report image drift (detection-only). Images are referenced inside objectType
 * JSON, not declared as manifest file entries, so this NEVER mutates and is NOT
 * a sync-project write-back target — it surfaces drift for visibility only.
 * Emits `[images]` lines via `log`; a no-op when there's no images/ dir.
 */
export function reportImageDrift(rootDir: string, log: Logger = console.log): void {
  let drift: ReturnType<typeof detectImageDrift>;
  try {
    drift = detectImageDrift(rootDir);
  } catch (err) {
    // c3source throws on an image `fileType` it cannot map to an on-disk extension (#63),
    // and upstream documents that the throw PROPAGATES through `detectImageDrift` — only
    // `detectManifestDrift` catches it, into a `degraded` entry. So guard here: report the
    // failure as a visibility line rather than crashing the whole `validate-project` run.
    // (c3source 1.9.0 / their #68 narrowed the throw to UNMAPPED fileTypes; an absent one
    // is now tolerated, since pre-r402 C3 omits the field on real images. The guard still
    // matters for unmapped MIMEs, and for a malformed objectTypes/*.json, which
    // `detectImageDrift` JSON.parses without a try/catch of its own.)
    log(`[images]`.padEnd(16) + `error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!drift || drift.entries.length === 0) {
    log(`[images]`.padEnd(16) + "(no drift)");
    return;
  }
  for (const e of drift.entries) {
    // missing = expected by an object type but absent on disk; untracked = on disk, unreferenced.
    const label =
      e.kind === "missing"
        ? "missing (expected, not on disk)"
        : e.kind === "untracked"
          ? "untracked (on disk, unreferenced)"
          : e.kind;
    log(`[images]`.padEnd(16) + `! ${e.name} — ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Stray files (detection-only report)
// ---------------------------------------------------------------------------

/**
 * Cap on the number of `! ` stray rows emitted before the `… and N more` tail.
 * Neither MCP tool that surfaces this report paginates — both return a single
 * content block — so an uncapped report on a badly misfiled project would bury
 * the drift output it sits beside.
 */
const STRAY_REPORT_LIMIT = 20;

/**
 * Report stray files (detection-only). A stray is a file under one of the seven
 * name-section roots that is neither a `.json` section item nor editor-local —
 * e.g. `layouts/notes.txt`. That gloss is for orientation only — c3source's
 * `StrayFile` owns the authoritative definition and the item/stray partition
 * guarantee. Point at it rather than growing a fuller copy here, which would
 * drift from upstream's silently.
 *
 * Emits `[strays]` lines via `log`, always at least one (`(no strays)` when the
 * project is clean), mirroring `reportImageDrift`'s shape.
 *
 * **Detection-only.** Like `reportImageDrift`, this NEVER mutates and is NOT a
 * sync-project write-back target: a stray has no manifest position and can never
 * acquire one, so there is nothing to write back. It does not influence
 * `SyncResult.clean`, nor `ManifestDrift.inSync`. It influences the CLI exit
 * code only where a caller opts in (`validate-project --fail-on-strays`, #183)
 * — that is the caller's decision; this function never exits and never fails
 * on its own.
 *
 * Returns the **full detected set, not the capped rendering**.
 * `STRAY_REPORT_LIMIT` bounds what is printed; the return carries every stray
 * so an opt-in gate fires on strays past the cap. Callers wanting only the
 * report may discard it.
 *
 * **No try/catch — deliberately, and upstream forbids adding one.** The guard on
 * `detectImageDrift` directly above exists because that detector has a
 * *domain-level* throw: an absent/unmapped image `fileType` (c3source#29 / #63)
 * makes it throw on data a `validate-project` run could otherwise survive, so
 * degrading to an `[images] error:` line is right there. That rationale does not
 * transfer. `detectStrayFiles` only classifies basenames the walk already read,
 * so it has no domain-level throw at all; any failure would be a filesystem
 * failure (`find_all_files_path` itself throwing) that the surrounding drift run
 * could not have survived either. Upstream's JSDoc is explicit: "Do not add a
 * try/catch around this call; it would silently hide a real failure rather than
 * degrade a best-effort sub-detector."
 *
 * **`ManifestDrift.strays` is knowingly left unread.** `runSync` already receives
 * it from `detectManifestDrift` and drops it on the floor; this function calls
 * `detectStrayFiles` directly instead. That duplication is deliberate — do not
 * "fix" it by routing through the drift result. Doing so would force either
 * emission inside `runSync`, whose eight call sites include the
 * scaffold-layout/scaffold-sprite paths that must stay silent, or a permanent
 * widening of the barrel-exported `SyncResult`. Calling directly also keeps the
 * report manifest-independent, which `runSync` (it parses `project.c3proj` first)
 * is not. See ADR 0023.
 *
 * **All seven upstream name sections are reported, including `models3d`**, which
 * chef's `NAME_SECTIONS` deliberately excludes from *sync* — reporting is not
 * syncing, and a misfiled file under `models3d/` is worth seeing even where chef
 * will never touch the manifest entry. Upstream's seven: layouts, eventSheets,
 * objectTypes, timelines, flowcharts, families, models3d.
 */
export function reportStrayFiles(rootDir: string, log: Logger = console.log): StrayFile[] {
  const strays = detectStrayFiles(rootDir);
  if (strays.length === 0) {
    log(`[strays]`.padEnd(16) + "(no strays)");
    return strays;
  }
  for (const s of strays.slice(0, STRAY_REPORT_LIMIT)) {
    log(`[strays]`.padEnd(16) + `! ${[s.folder, ...s.diskPath, s.name].join("/")}`);
  }
  if (strays.length > STRAY_REPORT_LIMIT) {
    log(`[strays]`.padEnd(16) + `… and ${strays.length - STRAY_REPORT_LIMIT} more (${strays.length} total)`);
  }
  return strays;
}
