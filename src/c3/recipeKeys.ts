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
  const segments = path.posix
    .normalize(slashed)
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments[0]?.toLowerCase() === section.toLowerCase()) segments.shift();
  const name = segments.join("/").replace(JSON_EXT, "");
  if (name === "") return "must name a file (the name is empty)";
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
