/**
 * The refusal wording for layout names and new object-class names. The rules live in c3source's `itemNameIssue`; this
 * module holds wording only. Off-barrel on purpose: not re-exported from `src/index.ts`.
 *
 * Every kind `itemNameIssue` reports is a refusal here, `rewritten` included: chef refuses a name C3 would store
 * differently (ADR 0067). Each function returns the reason without a caller prefix, or `undefined` when C3 keeps the
 * name as written.
 */
import { itemNameIssue } from "@genvidtech/c3source";
import { nameSegmentIssueText } from "./pathSegments.js";

const RESERVED_WORDS_LIST = "self, true, false and system, letter case ignored";

/** The text for a name C3 would store as `loaded` instead of the input. */
function keepsAsWritten(loaded: string): string {
  return `must be a name C3 keeps as written: C3 would load it as ${loaded === "" ? "an empty name" : `'${loaded}'`}`;
}

/** The reason C3 refuses the layout name `name`, or `undefined` when it keeps it as written. */
export function layoutNameRefusal(name: string): string | undefined {
  const issue = itemNameIssue("layouts", name);
  if (issue === undefined) return undefined;
  switch (issue.kind) {
    case "too-long":
      return "must be shorter than 200 characters";
    case "device-name":
      return nameSegmentIssueText({ kind: "reserved", segment: name, device: issue.name.toUpperCase() });
    default:
      return keepsAsWritten(issue.name);
  }
}

/** The reason C3 refuses the new object-class name `name`, or `undefined` when it keeps it as written. */
export function objectClassNameRefusal(name: string): string | undefined {
  const issue = itemNameIssue("objectTypes", name);
  if (issue === undefined) return undefined;
  const prefix = `must not be '${name}': `;
  const loadedAs = issue.name !== name ? `C3 would load it as '${issue.name}', ` : "";
  switch (issue.kind) {
    case "reserved-word":
      return loadedAs === ""
        ? `${prefix}C3 reserves it (${RESERVED_WORDS_LIST})`
        : `${prefix}${loadedAs}which C3 reserves (${RESERVED_WORDS_LIST})`;
    case "device-name":
      return `${prefix}C3 would load it as '${issue.name}', a Windows reserved device name (${issue.name.toUpperCase()})`;
    case "system-expression":
      return loadedAs === ""
        ? `${prefix}C3 reserves it as a System expression name (letter case ignored)`
        : `${prefix}${loadedAs}which C3 reserves as a System expression name (letter case ignored)`;
    default:
      return keepsAsWritten(issue.name);
  }
}
