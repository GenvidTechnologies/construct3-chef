/**
 * Pure recipe-key identity helpers for the `files` (event sheets) and `layouts` sections.
 *
 * Off-barrel on purpose (not re-exported from `src/index.ts`): these are internal building blocks for the
 * key-identity fixes #252 and #273, not published API.
 */
import path from "node:path";

/** The two recipe sections whose keys name a JSON file under a fixed top-level project folder. */
export type RecipeKeySection = "eventSheets" | "layouts";

const DRIVE_LETTER = /^[A-Za-z]:/;
const JSON_EXT = /\.json$/i;

function toSlashes(key: string): string {
  return key.replace(/\\/g, "/");
}

function hasDotDotSegment(slashed: string): boolean {
  return slashed.split("/").includes("..");
}

function isAbsoluteOrDrive(slashed: string): boolean {
  return slashed.startsWith("/") || DRIVE_LETTER.test(slashed);
}

/**
 * Canonical spelling of a recipe key for `section` (#252/#273): backslashes become `/`, `./` and `//` collapse
 * (`path.posix.normalize`), the leading section folder is spelled exactly `section` (added when absent, re-cased
 * when present in another letter case), and the extension is exactly `.json` (added when absent, re-cased when
 * present in another letter case). Letter case of the rest of the key is preserved.
 *
 * A key that {@link keyIssue} rejects is returned with only its backslashes converted, never resolved into a
 * different (possibly valid) key: absolute and drive-letter forms are returned as-is, and any key with a `..`
 * segment is returned as-is too, so `eventSheets/../layouts/Foo` can never silently become a valid key.
 * Idempotent: `canonicalizeRecipeKey(canonicalizeRecipeKey(k, s), s) === canonicalizeRecipeKey(k, s)`.
 */
export function canonicalizeRecipeKey(key: string, section: RecipeKeySection): string {
  const slashed = toSlashes(key);
  if (isAbsoluteOrDrive(slashed) || hasDotDotSegment(slashed)) return slashed;
  const segments = path.posix.normalize(slashed).split("/");
  if (segments[0]!.toLowerCase() === section.toLowerCase()) segments[0] = section;
  else segments.unshift(section);
  const joined = segments.join("/");
  return JSON_EXT.test(joined) ? joined.replace(JSON_EXT, ".json") : `${joined}.json`;
}

/**
 * Why a recipe key is unusable (#252/#273), as a neutral message fragment the caller prefixes with the section and
 * the original key; `undefined` when the key is acceptable. Checked against the ORIGINAL key (backslashes
 * converted): any `..` segment, an absolute or drive-letter path, or an empty name (an empty string, or nothing
 * left once a leading `section` folder and the `.json` extension are stripped). Only `section`'s own folder is
 * stripped, so a `files` key `layouts` names a real top-level sheet and is accepted.
 */
export function keyIssue(key: string, section: RecipeKeySection): string | undefined {
  const slashed = toSlashes(key);
  if (hasDotDotSegment(slashed)) return "must not contain a '..' segment";
  if (isAbsoluteOrDrive(slashed)) return "must be a relative path, not an absolute or drive-letter path";
  // A trailing slash (an empty LAST segment) names a folder, not a file. Interior `//` is still accepted and
  // collapsed by canonicalizeRecipeKey (KI12).
  if (slashed.endsWith("/")) return "must name a file, not a folder (it ends with '/')";
  const raw = slashed.split("/");
  // ':' is an NTFS alternate data stream on Windows but a literal name elsewhere, so it is host-dependent.
  if (raw.some((s) => s.includes(":"))) return "must not contain ':' (host-dependent on Windows)";
  // Windows strips trailing spaces and dots, so `.. ` or `...` is a '.'/'..' in disguise. A bare '.' is fine.
  if (raw.some((s) => s !== "." && s !== "" && s.replace(/[ .]+$/, "") === "")) {
    return "must not contain a segment that is only dots and spaces";
  }
  const segments = path.posix
    .normalize(slashed)
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments[0]?.toLowerCase() === section.toLowerCase()) segments.shift();
  const name = segments.join("/").replace(JSON_EXT, "");
  if (name === "") return "must name a file (the name is empty)";
  return undefined;
}

/** True for a segment Windows would strip down to nothing (`.. `, `...`); a bare `.` and `` are not flagged. */
function isDotsAndSpaces(segment: string): boolean {
  return segment !== "." && segment !== "" && segment.replace(/[ .]+$/, "") === "";
}

/** Why a single objectType name is unusable; each caller renders its own wording (recipe CREATE vs scaffold-sprite). */
export type ObjectTypeNameIssue =
  | { kind: "empty" }
  | { kind: "separator" }
  | { kind: "dot"; name: "." | ".." }
  | { kind: "colon" }
  | { kind: "dots-and-spaces" };

/**
 * The label-agnostic name-only rule shared by recipe `objectTypes` CREATE and scaffold-sprite (`--source`/`--name`):
 * ONE path segment that is not empty, has no `/` or `\`, is not `.` or `..`, has no `:`, and is not only dots and
 * spaces. `a..b` is acceptable. `undefined` when the name is usable.
 */
export function objectTypeNameIssue(name: string): ObjectTypeNameIssue | undefined {
  if (name === "") return { kind: "empty" };
  if (name.includes("/") || name.includes("\\")) return { kind: "separator" };
  if (name === "." || name === "..") return { kind: "dot", name };
  if (name.includes(":")) return { kind: "colon" };
  if (isDotsAndSpaces(name)) return { kind: "dots-and-spaces" };
  return undefined;
}

/**
 * Why an `objectTypes` entry's `name` / `folder` is unusable (#274), as a neutral message fragment the caller
 * prefixes with `objectTypes[i]:`; `undefined` when both are acceptable. `name` must be ONE path segment: not empty,
 * no `/` or `\`, not `.` or `..`, no `:`, not only dots and spaces. `folder` (when not `undefined`) must be a non-empty
 * relative path: no `..` segment (backslashes count as `/`), not absolute or drive-letter, no `:`, no segment made
 * only of dots and spaces. An empty-string folder is refused (omit `folder` instead). A trailing `/` and interior
 * `//` are tolerated (they name the same folder).
 */
export function objectTypeEntryIssue(name: string, folder: string | undefined): string | undefined {
  const nameIssue = objectTypeNameIssue(name);
  if (nameIssue !== undefined) {
    switch (nameIssue.kind) {
      case "empty":
        return 'has an empty "name"';
      case "separator":
        return "\"name\" must be a single name, not contain '/' or '\\'";
      case "dot":
        return `"name" must not be '${nameIssue.name}'`;
      case "colon":
        return "\"name\" must not contain ':' (host-dependent on Windows)";
      case "dots-and-spaces":
        return '"name" must not be only dots and spaces';
    }
  }
  if (folder === undefined) return undefined;
  if (folder === "") return '"folder" must not be empty (omit it for the objectTypes root)';
  const slashed = toSlashes(folder);
  if (hasDotDotSegment(slashed)) return "\"folder\" must not contain a '..' segment";
  if (isAbsoluteOrDrive(slashed)) return '"folder" must be a relative path, not an absolute or drive-letter path';
  const raw = slashed.split("/");
  if (raw.some((s) => s.includes(":"))) return "\"folder\" must not contain ':' (host-dependent on Windows)";
  if (raw.some(isDotsAndSpaces)) return '"folder" must not contain a segment that is only dots and spaces';
  return undefined;
}

/**
 * Identity of a canonical key (#252/#273): two keys name the same file iff their canonical forms are equal ignoring
 * letter case, so a case-insensitive filesystem cannot see them as two files.
 */
export function identity(canonical: string): string {
  return canonical.toLowerCase();
}

/** The noun a recipe section's keys name, for messages. */
const SECTION_NOUN: Record<RecipeKeySection, string> = { eventSheets: "event sheet", layouts: "layout" };

/**
 * The one validateRecipe line for a group of two or more keys sharing an identity (#252/#253). `label` is the
 * section prefix as the author wrote it (`files` / `layouts`), `canonical` the group's first canonical path, and
 * `spellings` the original keys in recipe order (JSON-quoted here). `caseOnly` adds `(letter case is ignored)`
 * when the members' canonical forms differ only in letter case.
 */
export function collisionMessage(
  label: string,
  section: RecipeKeySection,
  canonical: string,
  spellings: string[],
  caseOnly: boolean,
): string {
  const note = caseOnly ? " (letter case is ignored)" : "";
  const quoted = spellings.map((s) => JSON.stringify(s)).join(", ");
  return (
    `${label}: ${spellings.length} keys name the same ${SECTION_NOUN[section]} ${canonical}${note} — ${quoted}. ` +
    "Merge their entries under one key."
  );
}

/** A canonical POSIX recipe reference to check against the disk (#253). */
export interface SpellingRef {
  /** Canonical project-relative POSIX path, e.g. `eventSheets/Gameplay/Event sheet 1.json`. */
  path: string;
  /**
   * `file` names a file that should already exist: every segment, leaf included, is checked. `create` names a file
   * the recipe will write: only its FOLDER segments are checked (the leaf is the CREATE-leaf fold's business,
   * see {@link findCaseFoldedMatch}).
   */
  kind: "file" | "create";
}

/** A ref whose spelling matches the disk only after case-folding (#253). */
export interface SpellingMismatch {
  /** The ref as written. */
  path: string;
  /** The ref's leading segments up to and including the first segment that only matches case-folded. */
  prefix: string;
  /** On-disk spelling(s) of `prefix`, sorted; more than one when several differ only in letter case. */
  onDisk: string[];
}

/** Child names of the directory `dir` ("" = root) derived from a POSIX file listing. */
function childNames(dir: string, existingRelPaths: readonly string[]): Set<string> {
  const base = dir === "" ? "" : `${dir}/`;
  const names = new Set<string>();
  for (const p of existingRelPaths) {
    if (!p.startsWith(base)) continue;
    const name = p.slice(base.length).split("/")[0];
    if (name) names.add(name);
  }
  return names;
}

/**
 * Detect refs whose letter case differs from what is on disk (#253), purely, from an injected listing of existing
 * project-relative POSIX files (ancestor folders are derived from it). Per ref, segment by segment from the root:
 * an exact name at that level continues the walk (exact beats fold, so a listing holding both `Foo.json` and
 * `foo.json` is never flagged for either); only a case-folded match records a mismatch carrying the on-disk
 * spelling(s) of the path so far and stops; no match stops with no mismatch (a new path). `create` refs check
 * folder segments only. Results follow `refs` order.
 */
export function findSpellingMismatches(
  refs: readonly SpellingRef[],
  existingRelPaths: readonly string[],
): SpellingMismatch[] {
  const out: SpellingMismatch[] = [];
  for (const ref of refs) {
    const segments = ref.path.split("/").filter((s) => s !== "");
    const checked = ref.kind === "create" ? segments.slice(0, -1) : segments;
    let dir = "";
    for (let i = 0; i < checked.length; i++) {
      const seg = checked[i]!;
      const names = childNames(dir, existingRelPaths);
      if (names.has(seg)) {
        dir = dir === "" ? seg : `${dir}/${seg}`;
        continue;
      }
      const folded = [...names].filter((n) => n.toLowerCase() === seg.toLowerCase()).sort();
      if (folded.length > 0) {
        const parent = dir === "" ? "" : `${dir}/`;
        out.push({
          path: ref.path,
          prefix: checked.slice(0, i + 1).join("/"),
          onDisk: folded.map((n) => `${parent}${n}`),
        });
      }
      break;
    }
  }
  return out;
}

/**
 * The on-disk spelling(s) of `relPath` when a listed file equals it ignoring letter case but NOT exactly
 * (#253); `[]` when `relPath` exists exactly, or nothing matches even case-folded. Sorted. Used for the
 * CREATE-leaf fold, where a recipe would write a leaf that a case-insensitive filesystem sees as an existing file.
 */
export function findCaseFoldedMatch(relPath: string, existingRelPaths: readonly string[]): string[] {
  if (existingRelPaths.includes(relPath)) return [];
  const lower = relPath.toLowerCase();
  return existingRelPaths.filter((p) => p.toLowerCase() === lower).sort();
}
