/**
 * Chef's admission rule for an unlisted entry in a `rootFileFolders` section, in two layers.
 *
 * 1. Upstream. `rescanAdmissionIssue` in `@genvidtech/c3source` owns the editor's rescan
 *    decision: the name check, the reserved Files-root names, the `ts-defs` folder, the `.ts`
 *    twin of a `.js` file, and the per-section type rules (GenvidTechnologies/c3source#130).
 *    This module does not copy any of it.
 * 2. Chef's policy over upstream:
 *    - the `script` section also admits a `.ts` file, which upstream refuses with kind
 *      `section`; upstream's `name` refusal still applies to it;
 *    - a section key that is not a key of `C3_ROOT_FILE_FOLDERS` gets the name check only,
 *      instead of upstream's throw.
 *
 * This module is off-barrel on purpose: it is not exported from `src/index.ts`, so it is not
 * published API. ADR 0069's amendment records the two layers.
 */
import {
  C3_ROOT_FILE_FOLDERS,
  rescanAdmissionIssue,
  type C3FileSection,
  type RescanAdmissionIssue,
  type RescanEntry,
} from "@genvidtech/c3source";

/** Lower-cased text from the last dot; "" when the only dot is at index 0 or there is none (upstream's parse). */
export function lowerExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 1 ? "" : name.slice(dot).toLowerCase();
}

function isFileSection(key: string): key is C3FileSection {
  return Object.prototype.hasOwnProperty.call(C3_ROOT_FILE_FOLDERS, key); // same test as upstream's throw; not `in`
}

/** Why the editor's rescan skips an unlisted entry in section `sectionKey`, with chef's layers (ADR 0069 amendment). */
export function rescanIssue(sectionKey: string, entry: RescanEntry): RescanAdmissionIssue | undefined {
  if (!isFileSection(sectionKey)) {
    // Unknown key: name check only, instead of upstream's throw.
    // `general` off its root has no reserved names, and the twin is answered "none".
    const issue = rescanAdmissionIssue("general", { ...entry, atSectionRoot: false, hasRegisteredFile: () => false });
    return issue?.kind === "name" ? issue : undefined;
  }
  const issue = rescanAdmissionIssue(sectionKey, entry);
  // Chef deviation: `script` also admits `.ts`. Upstream's name refusal still applies (it comes first).
  if (
    sectionKey === "script" &&
    entry.kind === "file" &&
    issue?.kind === "section" &&
    lowerExtension(entry.name) === ".ts"
  )
    return undefined;
  return issue;
}
