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
 *    change lines from `DiskTree.dirs` (:311-:344). A flat, files-only primitive
 *    structurally CANNOT report an empty disk directory that must nonetheless
 *    become a manifest subfolder.
 *
 * 2. IT MUST BE PER-LEVEL, NOT RECURSIVE. `syncFileFolder` owns the recursion so
 *    it can descend in lockstep with the manifest folder object it mutates
 *    (:346-:374), and it deliberately DROPS the root-level `ignorePaths` /
 *    `ignoreDirs` at depth >= 1 (:356, :367). A self-recursing walk owns the
 *    traversal, so it can neither be stepped alongside the manifest tree nor
 *    vary its filter by depth.
 *
 * 3. THE IGNORE RULES ARE NOT ALL EDITOR-LOCAL CLASSIFICATION. `ignorePaths:
 *    ["tsconfig.json"]` (:84) and `ignoreDirs: ["ts-defs"]` (:85) ARE covered
 *    by c3source's `EDITOR_LOCAL_EXCLUSIONS`, but the `extensions` filters
 *    (`.ts` / `.webm` / `.ttf` / `.png`, :83 and :87-:90) encode
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

export function syncFileFolder(
  folder: FileFolder,
  diskPath: string,
  relativePath: string,
  config: FileSectionConfig,
  existingSids: Set<number>,
  changes: Change[],
  dryRun: boolean,
): void {
  const disk = readDiskDir(diskPath, config.extensions, config.ignorePaths, config.ignoreDirs);

  // Build lookup of existing items by name
  const existingItemMap = new Map<string, FileItem>();
  for (const item of folder.items) {
    existingItemMap.set(item.name, item);
  }

  // Build lookup of existing subfolders by name
  const existingSubfolderMap = new Map<string, FileFolder>();
  for (const sub of folder.subfolders) {
    if (sub.name !== undefined) {
      existingSubfolderMap.set(sub.name, sub);
    }
  }

  // Files on disk but not in project -> ADD
  const toAdd: string[] = [];
  for (const file of disk.files) {
    if (!existingItemMap.has(file)) {
      toAdd.push(file);
    }
  }

  // Files in project but not on disk -> REMOVE
  const diskFileSet = new Set(disk.files);
  const toRemove: string[] = [];
  for (const item of folder.items) {
    if (!diskFileSet.has(item.name)) {
      toRemove.push(item.name);
    }
  }

  // Apply file removals
  if (toRemove.length > 0) {
    for (const name of toRemove) {
      const display = relativePath ? `${relativePath}/${name}` : name;
      changes.push({ section: config.key, action: "-", detail: display });
    }
    if (!dryRun) {
      const removeSet = new Set(toRemove);
      folder.items = folder.items.filter((item) => !removeSet.has(item.name));
    }
  }

  // Apply file additions
  for (const name of toAdd) {
    const sid = generateSid(existingSids);
    const display = relativePath ? `${relativePath}/${name}` : name;
    changes.push({ section: config.key, action: "+", detail: `${display} (new, sid=${sid})` });
    if (!dryRun) {
      const newItem: FileItem = {
        name,
        type: inferMimeType(name),
        sid,
        [config.infoKey]: { purpose: "none" },
      };
      folder.items.push(newItem);
    }
  }

  // Folders on disk but not in project -> ADD
  const diskDirSet = new Set(disk.dirs);
  const existingNamedSubfolderNames = new Set<string>();
  for (const sub of folder.subfolders) {
    if (sub.name !== undefined) {
      existingNamedSubfolderNames.add(sub.name);
    }
  }

  for (const dirName of disk.dirs) {
    if (!existingNamedSubfolderNames.has(dirName)) {
      const display = relativePath ? `${relativePath}/${dirName}/` : `${dirName}/`;
      changes.push({ section: config.key, action: "+", detail: `${display} (new folder)` });
      if (!dryRun) {
        const newSubfolder: FileFolder = { items: [], subfolders: [], name: dirName };
        folder.subfolders.push(newSubfolder);
        existingSubfolderMap.set(dirName, newSubfolder);
      }
    }
  }

  // Folders in project but not on disk -> REMOVE
  const subfoldersToRemove: string[] = [];
  for (const sub of folder.subfolders) {
    if (sub.name !== undefined && !diskDirSet.has(sub.name)) {
      subfoldersToRemove.push(sub.name);
      const display = relativePath ? `${relativePath}/${sub.name}/` : `${sub.name}/`;
      changes.push({ section: config.key, action: "-", detail: display });
    }
  }
  if (subfoldersToRemove.length > 0 && !dryRun) {
    const removeSet = new Set(subfoldersToRemove);
    folder.subfolders = folder.subfolders.filter((sub) => sub.name === undefined || !removeSet.has(sub.name));
  }

  // Recurse into existing and newly added subfolders
  for (const dirName of disk.dirs) {
    const sub = dryRun ? existingSubfolderMap.get(dirName) : folder.subfolders.find((s) => s.name === dirName);
    if (!sub) {
      // In dry-run mode, we may not have added it to the folder, so create a temp one for recursion
      const tempSub: FileFolder = { items: [], subfolders: [], name: dirName };
      syncFileFolder(
        tempSub,
        path.join(diskPath, dirName),
        relativePath ? `${relativePath}/${dirName}` : dirName,
        // For subdirectories, don't apply root-level ignorePaths/ignoreDirs
        { ...config, ignorePaths: undefined, ignoreDirs: undefined },
        existingSids,
        changes,
        dryRun,
      );
    } else {
      syncFileFolder(
        sub,
        path.join(diskPath, dirName),
        relativePath ? `${relativePath}/${dirName}` : dirName,
        // For subdirectories, don't apply root-level ignorePaths/ignoreDirs
        { ...config, ignorePaths: undefined, ignoreDirs: undefined },
        existingSids,
        changes,
        dryRun,
      );
    }
  }
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
): void {
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
        if (!dryRun) target.items = target.items.filter((n) => n !== entry.name);
        changes.push({ section: sectionKey, action: "-", detail: itemDisplay(entry.manifestPath ?? [], entry.name) });
        if (entry.kind === "moved") {
          if (!dryRun) ensureFolder(folder, entry.diskPath ?? [], sectionKey).items.push(entry.name);
          changes.push({ section: sectionKey, action: "+", detail: itemDisplay(entry.diskPath ?? [], entry.name) });
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
        if (!dryRun) parent.subfolders = parent.subfolders.filter((s) => s !== child);
        changes.push({ section: sectionKey, action: "-", detail: folderDisplay(pathSegs) });
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

// Temporary bridge for construct3-chef#310, pending
// https://github.com/GenvidTechnologies/c3source/issues/97: C3 saves the nameless
// timelines container on every save even when there is no transitions/ dir, so its
// absence on disk is not drift, yet upstream detectManifestDrift reports it as
// folder-missing. Fires whatever the container holds.
// Retire it: delete this function, its call in runSync, and the `I310-T1:` tripwire,
// then revert-confirm the I310 convergence tests -- when I310-T1 goes red after a
// c3source bump.
function isTransitionsContainerFolderMissing(folder: NameFolder, entry: DriftEntry, sectionKey: string): boolean {
  if (sectionKey !== "timelines" || entry.kind !== "folder-missing") return false;
  const manifestPath = entry.manifestPath ?? [];
  if (manifestPath.length !== 1 || manifestPath[0] !== TIMELINE_TRANSITIONS_FOLDER) return false;
  return folder.subfolders.some((s) => s.name === undefined);
}

export function runSync(
  rootDir: string,
  dryRun: boolean,
  log: Logger = console.log,
  section?: string,
  opts?: { beforeWrite?: (manifestPath: string) => void },
): SyncResult {
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
    syncFileFolder(folder, diskPath, "", config, existingSids, allChanges, dryRun);
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
    // Drop at most one container-absence entry (see isTransitionsContainerFolderMissing).
    const bridgeIdx = s.entries.findIndex((e) => isTransitionsContainerFolderMissing(folder, e, s.section));
    const entries = bridgeIdx < 0 ? s.entries : s.entries.filter((_, i) => i !== bridgeIdx);
    applyNameDrift(folder, entries, s.section, allChanges, dryRun);
  }

  // Print results
  const sectionKeys = [...fileSections.map((s) => s.key), ...nameSections.map((s) => s.key)];
  for (const key of sectionKeys) {
    const sectionChanges = allChanges.filter((c) => c.section === key);
    if (sectionChanges.length === 0) {
      log(`[${key}]`.padEnd(16) + "(no changes)");
    } else {
      for (const change of sectionChanges) {
        log(`[${change.section}]`.padEnd(16) + `${change.action} ${change.detail}`);
      }
    }
  }

  const totalChanges = allChanges.length;

  if (totalChanges === 0) {
    log("\nAll sections in sync.");
  } else {
    log(`\n${totalChanges} change(s) found.`);
  }

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
