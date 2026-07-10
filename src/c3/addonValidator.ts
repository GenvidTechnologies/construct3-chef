import * as fs from "node:fs";
import * as path from "node:path";
import { toPosixPath } from "@genvidtech/mcp-utils";
import { unzipSync } from "fflate";
import { ADDON_DIRS, discoverAddons, type DiscoveredAddon } from "./addonDiscovery.js";
import { readAddonMetadata } from "./addonReader.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AddonFinding {
  package?: string; // path relative to projectRoot, POSIX separators (absent for "missing")
  packages?: string[]; // duplicate only: every resolving path, POSIX-relative, sorted
  addonId?: string; // resolved addon id when known (from addon.json)
  kind:
    | "metadata-mismatch"
    | "integrity"
    | "orphan"
    | "missing"
    | "duplicate"
    | "lang-missing-ace"
    | "lang-missing-param"
    | "lang-missing-property";
  field?: "id" | "name" | "author" | "version"; // metadata-mismatch only
  packageValue?: string; // metadata-mismatch: addon.json value
  manifestValue?: string; // metadata-mismatch / missing: usedAddons value
  problem?: string; // human-readable problem string (all kinds but metadata-mismatch)
  lang?: string; // lang-missing-*: the lang entry name, e.g. "lang/en-US.json"
  aceId?: string; // lang-missing-ace / lang-missing-param: the ACE id
  paramId?: string; // lang-missing-param: the param id
  propId?: string; // lang-missing-property: the property id
  itemId?: string; // lang-missing-property: the combo item id (item-variant findings only)
  context?: string; // lang-missing-*: dotted path mirroring Construct's lang-file addressing
}

export interface AddonValidationResult {
  checked: number;
  findings: AddonFinding[];
}

interface UsedAddonEntry {
  type?: string;
  id?: string;
  name?: string;
  author?: string;
  version?: string;
  bundled?: boolean;
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read and parse `project.c3proj`'s `usedAddons` array into a `Map` keyed by
 * addon id. Never throws: a missing/unparseable manifest, or a `usedAddons`
 * that isn't an array, yields an empty map (integrity checks still run; only
 * metadata comparisons are skipped).
 */
function readUsedAddons(projectRoot: string): Map<string, UsedAddonEntry> {
  const usedById = new Map<string, UsedAddonEntry>();
  const manifestPath = path.join(projectRoot, "project.c3proj");

  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    return usedById;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return usedById;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return usedById;
  const usedAddons = (parsed as Record<string, unknown>).usedAddons;
  if (!Array.isArray(usedAddons)) return usedById;

  for (const raw of usedAddons) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string") continue;
    const used: UsedAddonEntry = { id: entry.id };
    if (typeof entry.type === "string") used.type = entry.type;
    if (typeof entry.name === "string") used.name = entry.name;
    if (typeof entry.author === "string") used.author = entry.author;
    if (typeof entry.version === "string") used.version = entry.version;
    if (typeof entry.bundled === "boolean") used.bundled = entry.bundled;
    usedById.set(entry.id, used);
  }

  return usedById;
}

/**
 * Run the integrity checks for a single addon package. Returns the parsed
 * addon.json `id` (when the zip parses and it's present) so the caller can
 * decide whether to also run the metadata-mismatch comparison, plus whatever
 * findings were raised. Never throws.
 */
function checkIntegrity(addon: DiscoveredAddon, pkg: string): { findings: AddonFinding[]; zipOk: boolean } {
  const findings: AddonFinding[] = [];

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(addon.archivePath);
  } catch {
    findings.push({ package: pkg, kind: "integrity", problem: "unreadable archive file" });
    return { findings, zipOk: false };
  }

  // ── LFS pointer: an un-materialized git-lfs-tracked archive ───────────────
  const head = bytes.subarray(0, LFS_POINTER_PREFIX.length).toString("utf-8");
  if (head === LFS_POINTER_PREFIX) {
    findings.push({
      package: pkg,
      kind: "integrity",
      problem: "un-materialized LFS pointer (git-lfs not fetched)",
    });
    return { findings, zipOk: false };
  }

  // ── Zip parse ───────────────────────────────────────────────────────────
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    findings.push({
      package: pkg,
      kind: "integrity",
      problem: "malformed zip (not a valid .c3addon archive)",
    });
    return { findings, zipOk: false };
  }

  // ── Required entries ───────────────────────────────────────────────────
  // c3runtime is deliberately NOT required here: plugin/effect layouts vary
  // enough (some ship no runtime script at all) that requiring it would
  // cause false positives.
  for (const required of ["addon.json", "aces.json"]) {
    if (entries[required] === undefined) {
      findings.push({ package: pkg, kind: "integrity", problem: `missing required entry: ${required}` });
    }
  }

  // ── id/filename consistency ─────────────────────────────────────────────
  const addonJsonBytes = entries["addon.json"];
  if (addonJsonBytes !== undefined) {
    try {
      const parsed = JSON.parse(Buffer.from(addonJsonBytes).toString("utf-8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const id = (parsed as Record<string, unknown>).id;
        if (typeof id === "string" && id !== addon.name) {
          findings.push({
            package: pkg,
            addonId: id,
            kind: "integrity",
            problem: `addon id '${id}' does not match package filename '${addon.name}'`,
          });
        }
      }
    } catch {
      // Malformed addon.json JSON isn't separately flagged here — the
      // metadata-mismatch pass (via readAddonMetadata) tolerates it too.
    }
  }

  return { findings, zipOk: true };
}

/**
 * Compare a discovered addon's `addon.json` metadata against its matching
 * `usedAddons` entry (matched by id), flagging any of `id`/`name`/`author`/
 * `version` that are present on both sides but differ. Orphan addons (no
 * matching `usedAddons` entry) are out of scope here — see #108. Never
 * throws.
 */
function checkMetadataMismatch(
  addon: DiscoveredAddon,
  pkg: string,
  usedById: Map<string, UsedAddonEntry>,
): AddonFinding[] {
  const findings: AddonFinding[] = [];

  const metaResult = readAddonMetadata(addon);
  if (metaResult === null) return findings;
  const { metadata } = metaResult;

  const used = usedById.get(metadata.id ?? addon.name);
  if (used === undefined) return findings; // orphan — out of scope (#108)

  const addonId = metadata.id;

  const fieldChecks: Array<{
    field: "id" | "name" | "author" | "version";
    packageValue?: string;
    manifestValue?: string;
  }> = [
    { field: "id", packageValue: metadata.id, manifestValue: used.id },
    { field: "name", packageValue: metadata.name, manifestValue: used.name },
    { field: "author", packageValue: metadata.author, manifestValue: used.author },
    { field: "version", packageValue: metadata.version, manifestValue: used.version },
  ];

  for (const { field, packageValue, manifestValue } of fieldChecks) {
    if (packageValue === undefined || manifestValue === undefined) continue;
    if (packageValue !== manifestValue) {
      findings.push({ package: pkg, addonId, kind: "metadata-mismatch", field, packageValue, manifestValue });
    }
  }

  return findings;
}

/**
 * Resolve an addon's id: `addon.json`'s `id` field when readable, else the
 * package's basename (archive filename without `.c3addon`). Never throws.
 */
function resolveAddonId(addon: DiscoveredAddon): string {
  return readAddonMetadata(addon)?.metadata.id ?? addon.name;
}

interface RawAddonArchive {
  archivePath: string; // absolute path to the .c3addon file
  name: string; // archive basename without .c3addon
  kind: "plugin" | "effect";
}

/**
 * Enumerate every `.c3addon` file under both `ADDON_DIRS`, recursively (unlike
 * `discoverAddons`, which is flat). Used only for duplicate-id detection, so a
 * package nested under a subfolder of `addons/plugin`/`addons/effect` is still
 * caught. Never throws: a per-dir read failure is skipped rather than
 * aborting the whole scan.
 */
function findAllAddonArchives(projectRoot: string): RawAddonArchive[] {
  const results: RawAddonArchive[] = [];
  for (const addonDir of ADDON_DIRS) {
    const kind: "plugin" | "effect" = addonDir === "addons/plugin" ? "plugin" : "effect";
    const fullDir = path.join(projectRoot, addonDir);
    if (!fs.existsSync(fullDir)) continue;
    try {
      const entries = fs.readdirSync(fullDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".c3addon")) continue;
        const parentDir = entry.parentPath ?? entry.path;
        results.push({
          archivePath: path.join(parentDir, entry.name),
          name: entry.name.replace(/\.c3addon$/, ""),
          kind,
        });
      }
    } catch {
      continue;
    }
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate every bundled addon (`addons/plugin` + `addons/effect`) under
 * `projectRoot`: integrity checks (LFS-pointer / malformed-zip / missing
 * required entries / id-filename mismatch) run on every package, and
 * metadata comparisons against `project.c3proj`'s `usedAddons` run for
 * packages that parsed cleanly and have a matching entry. Three further,
 * additive passes then run: orphan (a *clean* discovered package — zip
 * parsed, zero integrity findings — with no matching `usedAddons` entry; a
 * package that already has an integrity failure is reported via that finding
 * instead, not also as an orphan off an unreliable id), missing (a
 * `bundled: true` `usedAddons` entry with no discovered package on disk), and
 * duplicate (2+ discovered packages, enumerated recursively, resolving to the
 * same addon id). Never throws — a problem with one package is reported as a
 * finding, not an exception.
 */
export function validateAddons(projectRoot: string): AddonValidationResult {
  const addons = discoverAddons(projectRoot);
  const usedById = readUsedAddons(projectRoot);
  const findings: AddonFinding[] = [];

  // discoveredIds covers every discovered package (even ones that failed
  // integrity checks) so the missing pass below doesn't misreport a package
  // that exists on disk, just broken, as absent. cleanPackages is the
  // narrower subset (zipOk && zero integrity findings) the orphan pass draws
  // from.
  const discoveredIds = new Set<string>();
  const cleanPackages: { pkg: string; addonId: string }[] = [];

  for (const addon of addons) {
    try {
      const pkg = toPosixPath(path.relative(projectRoot, addon.archivePath));

      const { findings: integrityFindings, zipOk } = checkIntegrity(addon, pkg);
      findings.push(...integrityFindings);

      const addonId = resolveAddonId(addon);
      discoveredIds.add(addonId);
      if (zipOk && integrityFindings.length === 0) {
        cleanPackages.push({ pkg, addonId });
      }

      if (!zipOk) continue;

      findings.push(...checkMetadataMismatch(addon, pkg, usedById));
    } catch {
      // A single bad package must never abort the whole scan.
      continue;
    }
  }

  // ── Orphan pass (clean packages only) ────────────────────────────────────
  for (const { pkg, addonId } of cleanPackages) {
    if (!usedById.has(addonId)) {
      findings.push({
        package: pkg,
        addonId,
        kind: "orphan",
        problem: "on disk but not in project.c3proj usedAddons",
      });
    }
  }

  // ── Missing pass (bundled usedAddons entries absent from disk) ──────────
  for (const [addonId, used] of usedById) {
    if (used.bundled !== true || discoveredIds.has(addonId)) continue;
    const finding: AddonFinding = {
      addonId,
      kind: "missing",
      problem: "declared bundled in project.c3proj but no package file on disk",
    };
    if (used.version !== undefined) finding.manifestValue = used.version;
    findings.push(finding);
  }

  // ── Duplicate pass (recursive archive set) ───────────────────────────────
  const packagesById = new Map<string, string[]>();
  for (const archive of findAllAddonArchives(projectRoot)) {
    try {
      const discovered: DiscoveredAddon = {
        name: archive.name,
        kind: archive.kind,
        archivePath: archive.archivePath,
        extractedDir: null,
      };
      const addonId = resolveAddonId(discovered);
      const pkg = toPosixPath(path.relative(projectRoot, archive.archivePath));
      const list = packagesById.get(addonId);
      if (list === undefined) packagesById.set(addonId, [pkg]);
      else list.push(pkg);
    } catch {
      continue;
    }
  }
  for (const [addonId, packages] of packagesById) {
    if (packages.length < 2) continue;
    const sorted = [...packages].sort();
    findings.push({
      addonId,
      kind: "duplicate",
      packages: sorted,
      problem: `${sorted.length} packages resolve to the same addon id`,
    });
  }

  return { checked: addons.length, findings };
}

/**
 * Render an `AddonValidationResult` to plain text. Shared by the CLI and MCP
 * surfaces so output stays byte-identical.
 */
export function formatAddonValidation(result: AddonValidationResult): string {
  const { checked, findings } = result;

  if (findings.length === 0) {
    return `Checked ${checked} bundled addon(s): all consistent.`;
  }

  const lines: string[] = [`Checked ${checked} bundled addon(s), ${findings.length} issue(s):`];
  for (const finding of findings) {
    if (finding.kind === "metadata-mismatch") {
      lines.push(
        `  ${finding.package}: ${finding.field} mismatch — package '${finding.packageValue}' vs project.c3proj '${finding.manifestValue}'`,
      );
    } else if (finding.kind === "orphan") {
      lines.push(`  ${finding.package}: orphan — ${finding.problem} (id '${finding.addonId}')`);
    } else if (finding.kind === "missing") {
      const versionSuffix = finding.manifestValue !== undefined ? ` (version ${finding.manifestValue})` : "";
      lines.push(`  ${finding.addonId}: missing — ${finding.problem}${versionSuffix}`);
    } else if (finding.kind === "duplicate") {
      lines.push(`  ${finding.addonId}: duplicate — ${finding.problem}: ${(finding.packages ?? []).join(", ")}`);
    } else if (
      finding.kind === "lang-missing-ace" ||
      finding.kind === "lang-missing-param" ||
      finding.kind === "lang-missing-property"
    ) {
      lines.push(`  ${finding.addonId} [${finding.lang}]: ${finding.problem}`);
    } else {
      lines.push(`  ${finding.package}: ${finding.problem}`);
    }
  }

  return lines.join("\n");
}
