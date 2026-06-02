import { writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "@genvid/mcp-utils";
import { isEditorLocalPath, readProjectManifest, detectImageDrift, detectManifestDrift, type DriftEntry } from "@genvid/c3source";
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

export const MIME_MAP: Record<string, string> = {
	".ts": "application/typescript",
	".webm": "audio/webm; codecs=opus",
	".ttf": "application/font-sfnt",
	".png": "image/png",
	".json": "application/json",
	".html": "text/html",
	".css": "text/css",
	".xml": "text/xml",
	".plist": "text/xml",
	".txt": "text/plain",
};

export function inferMimeType(filename: string): string {
	const ext = path.extname(filename).toLowerCase();
	return MIME_MAP[ext] ?? "application/octet-stream";
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

export function readDiskDirNames(dirPath: string, ignoreUistate: boolean): DiskTree {
	if (!existsSync(dirPath)) {
		return { files: [], dirs: [] };
	}

	const entries = readdirSync(dirPath, { withFileTypes: true });
	const files: string[] = [];
	const dirs: string[] = [];

	for (const entry of entries) {
		if (entry.isDirectory()) {
			// Editor-local membership (the `uistate/` subfolder, *.uistate.json files)
			// is owned by c3source's isEditorLocalPath / EDITOR_LOCAL_EXCLUSIONS.
			if (ignoreUistate && isEditorLocalPath(entry.name)) continue;
			dirs.push(entry.name);
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			if (ignoreUistate && isEditorLocalPath(entry.name)) continue;
			// Strip .json extension to get the name
			files.push(entry.name.replace(/\.json$/, ""));
		}
	}

	return { files, dirs };
}

// ---------------------------------------------------------------------------
// Nameless subfolder handling
//
// Some sections (e.g., timelines) have subfolders without a `name` field in
// project.c3proj.  We cannot sync these because there is no name to match
// against a disk directory.  To avoid falsely detecting the corresponding
// disk directory as "new", we collect the set of disk directory names that
// are claimed by nameless subfolders.  We do this by matching: for each
// nameless subfolder, find the disk directory whose item names match.
// ---------------------------------------------------------------------------

function findNamelessDiskDirs(
	folder: NameFolder,
	diskPath: string,
	ignoreUistate: boolean,
): Set<string> {
	const claimed = new Set<string>();

	const namelessSubs = folder.subfolders.filter((sub) => sub.name === undefined);
	if (namelessSubs.length === 0) return claimed;

	// Read disk directories
	const disk = readDiskDirNames(diskPath, ignoreUistate);

	// For each nameless subfolder, try to match a disk directory by comparing items
	for (const nameless of namelessSubs) {
		const namelessItems = new Set(nameless.items);
		for (const dirName of disk.dirs) {
			// Read disk dir contents
			const subDisk = readDiskDirNames(path.join(diskPath, dirName), ignoreUistate);
			const diskItems = new Set(subDisk.files);

			// Check if all items in the nameless subfolder exist on disk
			if (namelessItems.size > 0 && [...namelessItems].every((item) => diskItems.has(item))) {
				claimed.add(dirName);
				break; // Each nameless subfolder maps to at most one disk dir
			}
		}
	}

	return claimed;
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
// Name-based section sync
// ---------------------------------------------------------------------------

export function syncNameFolder(
	folder: NameFolder,
	diskPath: string,
	relativePath: string,
	config: NameSectionConfig,
	changes: Change[],
	dryRun: boolean,
	namelessDiskDirs?: Set<string>,
): void {
	const disk = readDiskDirNames(diskPath, config.ignoreUistate);

	// On the first call (root level), compute which disk dirs are claimed by nameless subfolders
	if (namelessDiskDirs === undefined) {
		namelessDiskDirs = findNamelessDiskDirs(folder, diskPath, config.ignoreUistate);
	}

	// Build lookup of existing items
	const existingItemSet = new Set(folder.items);

	// Build lookup of existing subfolders by name
	const existingSubfolderMap = new Map<string, NameFolder>();
	for (const sub of folder.subfolders) {
		if (sub.name !== undefined) {
			existingSubfolderMap.set(sub.name, sub);
		}
	}

	// Items on disk but not in project -> ADD
	const toAdd: string[] = [];
	for (const name of disk.files) {
		if (!existingItemSet.has(name)) {
			toAdd.push(name);
		}
	}

	// Items in project but not on disk -> REMOVE
	const diskFileSet = new Set(disk.files);
	const toRemove: string[] = [];
	for (const name of folder.items) {
		if (!diskFileSet.has(name)) {
			toRemove.push(name);
		}
	}

	// Apply item removals
	if (toRemove.length > 0) {
		for (const name of toRemove) {
			const display = relativePath ? `${relativePath}/${name}` : name;
			changes.push({ section: config.key, action: "-", detail: display });
		}
		if (!dryRun) {
			const removeSet = new Set(toRemove);
			folder.items = folder.items.filter((item) => !removeSet.has(item));
		}
	}

	// Apply item additions
	for (const name of toAdd) {
		const display = relativePath ? `${relativePath}/${name}` : name;
		changes.push({ section: config.key, action: "+", detail: display });
		if (!dryRun) {
			folder.items.push(name);
		}
	}

	// Folders on disk but not in project -> ADD (skip nameless-claimed dirs)
	const diskDirSet = new Set(disk.dirs);
	const existingNamedSubfolderNames = new Set<string>();
	for (const sub of folder.subfolders) {
		if (sub.name !== undefined) {
			existingNamedSubfolderNames.add(sub.name);
		}
	}

	for (const dirName of disk.dirs) {
		if (namelessDiskDirs.has(dirName)) continue; // Claimed by a nameless subfolder
		if (!existingNamedSubfolderNames.has(dirName)) {
			const display = relativePath ? `${relativePath}/${dirName}/` : `${dirName}/`;
			changes.push({ section: config.key, action: "+", detail: `${display} (new folder)` });
			if (!dryRun) {
				const newSubfolder: NameFolder = { items: [], subfolders: [], name: dirName };
				folder.subfolders.push(newSubfolder);
				existingSubfolderMap.set(dirName, newSubfolder);
			}
		}
	}

	// Folders in project (with name) but not on disk -> REMOVE
	// Skip subfolders without a name field (timelines edge case)
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

	// Recurse into existing and newly added subfolders (only those with names, skip nameless-claimed)
	for (const dirName of disk.dirs) {
		if (namelessDiskDirs.has(dirName)) continue; // Skip nameless-claimed dirs
		const sub = dryRun ? existingSubfolderMap.get(dirName) : folder.subfolders.find((s) => s.name === dirName);
		if (!sub) {
			// In dry-run mode for new folders
			const tempSub: NameFolder = { items: [], subfolders: [], name: dirName };
			syncNameFolder(
				tempSub,
				path.join(diskPath, dirName),
				relativePath ? `${relativePath}/${dirName}` : dirName,
				config,
				changes,
				dryRun,
				new Set(), // No nameless dirs in sub-levels
			);
		} else {
			syncNameFolder(
				sub,
				path.join(diskPath, dirName),
				relativePath ? `${relativePath}/${dirName}` : dirName,
				config,
				changes,
				dryRun,
				new Set(), // No nameless dirs in sub-levels
			);
		}
	}
}

// ---------------------------------------------------------------------------
// DriftEntry-driven name-section apply engine
// ---------------------------------------------------------------------------

/**
 * Navigate from the section root to the subfolder described by `segments`.
 * Returns the target NameFolder, or undefined if a segment is missing.
 */
function navigateFolder(folder: NameFolder, segments: string[]): NameFolder | undefined {
	let cur: NameFolder = folder;
	for (const seg of segments) {
		const found = cur.subfolders.find((s) => s.name === seg);
		if (!found) return undefined;
		cur = found;
	}
	return cur;
}

/**
 * Navigate from the section root to the subfolder described by `segments`,
 * creating any missing segments along the way.
 */
function ensureFolder(folder: NameFolder, segments: string[]): NameFolder {
	let cur: NameFolder = folder;
	for (const seg of segments) {
		let found = cur.subfolders.find((s) => s.name === seg);
		if (!found) {
			found = { items: [], subfolders: [], name: seg };
			cur.subfolders.push(found);
		}
		cur = found;
	}
	return cur;
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
				const target = dryRun ? null : ensureFolder(folder, entry.diskPath ?? []);
				if (!dryRun && target) {
					target.items.push(entry.name);
				}
				changes.push({ section: sectionKey, action: "+", detail: itemDisplay(entry.diskPath ?? [], entry.name) });
				break;
			}
			case "missing": {
				// In manifest, not on disk → REMOVE
				const target = navigateFolder(folder, entry.manifestPath ?? []);
				if (!target) break; // shouldn't happen; skip gracefully
				if (!dryRun) {
					target.items = target.items.filter((n) => n !== entry.name);
				}
				changes.push({ section: sectionKey, action: "-", detail: itemDisplay(entry.manifestPath ?? [], entry.name) });
				break;
			}
			case "moved": {
				// Same name, different path → decompose as remove@manifestPath + add@diskPath
				const removeTarget = navigateFolder(folder, entry.manifestPath ?? []);
				if (!dryRun && removeTarget) {
					removeTarget.items = removeTarget.items.filter((n) => n !== entry.name);
				}
				changes.push({ section: sectionKey, action: "-", detail: itemDisplay(entry.manifestPath ?? [], entry.name) });

				const addTarget = dryRun ? null : ensureFolder(folder, entry.diskPath ?? []);
				if (!dryRun && addTarget) {
					addTarget.items.push(entry.name);
				}
				changes.push({ section: sectionKey, action: "+", detail: itemDisplay(entry.diskPath ?? [], entry.name) });
				break;
			}
			case "folder-untracked": {
				// Disk subdir with no manifest subfolder → ADD
				// diskPath includes the new folder name as last segment; ensureFolder creates it
				if (!dryRun) {
					ensureFolder(folder, entry.diskPath ?? []);
				}
				changes.push({ section: sectionKey, action: "+", detail: `${folderDisplay(entry.diskPath ?? [])} (new folder)` });
				break;
			}
			case "folder-missing": {
				// Manifest subfolder with no disk dir → REMOVE
				const pathSegs = entry.manifestPath ?? [];
				const parentSegs = pathSegs.slice(0, -1);
				const folderName = pathSegs.at(-1);
				if (!folderName) break; // shouldn't happen
				const parent = navigateFolder(folder, parentSegs);
				if (!dryRun && parent) {
					parent.subfolders = parent.subfolders.filter((s) => s.name !== folderName);
				}
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

export function runSync(
	rootDir: string,
	dryRun: boolean,
	log: Logger = console.log,
	section?: string,
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
		applyNameDrift(folder, s.entries, s.section, allChanges, dryRun);
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
	if (!dryRun && totalChanges > 0) {
		writeFileSync(projectPath, JSON.stringify(project, null, "\t"));
		log(`Updated ${projectPath}`);
	}

	const sections: Record<string, SectionSummary> = {};
	for (const key of sectionKeys) {
		const sectionChanges = allChanges.filter((c) => c.section === key);
		sections[key] = {
			added: sectionChanges.filter((c) => c.action === "+").length,
			removed: sectionChanges.filter((c) => c.action === "-").length,
		};
	}

	return { changes: allChanges, clean: allChanges.length === 0, sections };
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
	const drift = detectImageDrift(rootDir);
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
