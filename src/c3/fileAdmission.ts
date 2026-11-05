/**
 * Which unlisted disk files and folders the C3 editor adds to a `rootFileFolders` section when it rescans the
 * project. A local bridge: c3source exports no such predicate (GenvidTechnologies/c3source#130). Off-barrel on
 * purpose: not re-exported from `src/index.ts`.
 *
 * Source: the rescan loop in the r495 editor bundle's `projectResources.js` (function `l5e`), read by hand. The
 * checks run in this order:
 *
 * 1. Name, files and folders: admitted when c3source's `itemNameIssue("layouts", name)` is `undefined`, or is a
 *    `rewritten` result equal to `name.normalize()`. The second case is the NFC carve-out: the editor normalises
 *    to NFC internally and c3source compares the raw name.
 * 2. Folders: refused when the name fails, and `ts-defs` at the script section root is refused.
 * 3. Reserved root names, files only, only in the `general` section at its root (the editor's folder prefix is
 *    empty only there): 17 names, letter case ignored.
 * 4. Section switch on the lower-cased extension. `script` admits `.js`, unless a `.ts` twin is listed. `general`
 *    admits any extension, with the same `.js` twin rule. `sound`/`music`/`video`/`icon` admit a file whose
 *    registry type category (first segment of `fileTypeForSection`) is `audio`/`audio`/`video`/`image`. `font`
 *    uses a local extension set. Any other section key gets the name check only.
 *
 * Deviations and gaps:
 * - `script` also admits `.ts`. The editor's rescan admits `.js` only; without this, sync would stop registering
 *   new `.ts` scripts. This is a chef deviation.
 * - `font`: the editor tests a registry font flag whose per-extension values were not read. The set below is chef's
 *   own list; the MIME types of those extensions span `application/*` and `font/*`.
 * - Not validated in a live editor, except `video` (`.mov` observed admitted).
 */
import { fileTypeForSection, itemNameIssue } from "@genvidtech/c3source";
import type { C3FileSection } from "@genvidtech/c3source";

/** Why the editor's rescan does not admit a file. */
export type AdmissionRefusal = "name" | "reserved-root-name" | "ts-twin" | "category";

/** Names the editor refuses in the general section root, lower case. */
const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  "appmanifest.json",
  "c2runtime.js",
  "c3runtime.js",
  "c3main.js",
  "data.json",
  "debug.html",
  "index.html",
  "local.html",
  "modernjscheck.js",
  "offline.json",
  "offlineclient.js",
  "register-sw.js",
  "javascriptinevents.js",
  "typescriptinevents.js",
  "start.js",
  "style.css",
  "sw.js",
]);

const FONT_EXTENSIONS: ReadonlySet<string> = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot"]);

/** The registry type category a section's rescan requires. */
const SECTION_CATEGORY: Partial<Record<C3FileSection, string>> = {
  sound: "audio",
  music: "audio",
  video: "video",
  icon: "image",
};

function nameAdmitted(name: string): boolean {
  const issue = itemNameIssue("layouts", name);
  if (issue === undefined) return true;
  return issue.kind === "rewritten" && issue.name === name.normalize();
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** The reason the editor's rescan skips the file `name`, or `undefined` when it adds it. */
export function fileAdmissionIssue(
  section: string,
  name: string,
  ctx: { atSectionRoot: boolean; tsTwinListed: boolean },
): AdmissionRefusal | undefined {
  if (!nameAdmitted(name)) return "name";
  if (section === "general" && ctx.atSectionRoot && RESERVED_ROOT_NAMES.has(name.toLowerCase())) {
    return "reserved-root-name";
  }
  const ext = extensionOf(name);
  switch (section) {
    case "script":
      if (ext === ".js") return ctx.tsTwinListed ? "ts-twin" : undefined;
      return ext === ".ts" ? undefined : "category";
    case "general":
      return ext === ".js" && ctx.tsTwinListed ? "ts-twin" : undefined;
    case "sound":
    case "music":
    case "video":
    case "icon": {
      const category = fileTypeForSection(section, name).split("/")[0];
      return category === SECTION_CATEGORY[section] ? undefined : "category";
    }
    case "font":
      return FONT_EXTENSIONS.has(ext) ? undefined : "category";
    default:
      return undefined;
  }
}

/** Whether the editor's rescan adds the folder `name` to `section`. */
export function folderAdmitted(section: string, name: string, ctx: { atSectionRoot: boolean }): boolean {
  if (!nameAdmitted(name)) return false;
  return !(section === "script" && ctx.atSectionRoot && name === "ts-defs");
}
