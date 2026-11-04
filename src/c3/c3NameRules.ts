/**
 * The C3 editor's name rules for layouts and for new object classes (objectTypes and families).
 *
 * Temporary local bridge: c3source has no exported name validators yet (GenvidTechnologies/c3source#123), and this
 * module goes away when it ships them (construct3-chef#260). Off-barrel on purpose: not re-exported from
 * `src/index.ts`.
 *
 * Source: the C3 editor r495-2 bundle, read as text and never run.
 * - `projectResources.js` (sha256 e0180c2a41e4f8103e2a6b5a5ab6e8be7eb3d1e97e331b2b18de2969d60b7b43): the `nit`
 *   normalizer at offset 57585, the reserved-word set `ht` and the punctuation set `rt` just before the `window.HF`
 *   constructor at offset 55966.
 * - `main.js` (sha256 18c7a7cee194779da60deba01052a74ae57b8c038eadd0041932ced68794d10c): the layout-name rule `rRi`
 *   at offset 84014 with its constants at offset 83721, the whitespace set `hRi` (`Ju`) at offset 213447, and the
 *   punctuation literals `self.t.rq` at offset 223683.
 */
import { nameSegmentIssueText, reservedDeviceName } from "./pathSegments.js";

/** Characters the editor's layout-name rule refuses (`main.js` @83721). */
const LAYOUT_FORBIDDEN_CHARS: ReadonlySet<string> = new Set([
  String.fromCharCode(92),
  "/",
  ":",
  "*",
  "?",
  '"',
  "<",
  ">",
  "|",
  "~",
]);

/** The editor's whitespace set `hRi`: 23 code points (`main.js` @213447). */
const EDITOR_WHITESPACE: ReadonlySet<string> = new Set(
  [
    0x20, 0x09, 0x0a, 0x0d, 0xa0, 0x85, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
    0x200a, 0x200b, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ].map((c) => String.fromCodePoint(c)),
);

/** Layout names of this many code points or more are refused (`main.js` @83721). */
const LAYOUT_NAME_LIMIT = 200;

/**
 * The punctuation set `rt` that `nit` drops (`projectResources.js` @55966): the ASCII and full-width punctuation from
 * `self.t.rq` (`main.js` @223683), then a literal run of further symbols, then the soft hyphen.
 */
const NORMALIZER_DROPPED: ReadonlySet<string> = new Set([
  ...[0x2e, 0x3002, 0x2c, 0xff0c, 0x22, 0x201c, 0x201d, 0x28, 0xff08, 0x29, 0xff09, 0x3f, 0xff1f, 0x3a, 0xff1a].map(
    (c) => String.fromCodePoint(c),
  ),
  String.fromCharCode(92),
  ...`/;*|'-\`!$%^&+=<>{}[]@#~`,
  ...[0xac, 0xa3, 0xad].map((c) => String.fromCodePoint(c)),
]);

/** Names C3 reserves for itself, compared lower-cased (`projectResources.js` @55966). */
const RESERVED_WORDS: ReadonlySet<string> = new Set(["self", "true", "false", "system"]);

/** Why a layout name is unusable. */
export type LayoutNameIssue =
  | { kind: "empty" }
  | { kind: "forbidden-char"; char: string }
  | { kind: "edge-dot-or-space" }
  | { kind: "too-long" }
  | { kind: "reserved-device"; segment: string; device: string };

/**
 * The first reason C3's layout-name rule refuses `name`, or `undefined` when it accepts it. Checks run in this order:
 * empty, a forbidden character (the first one found), a leading or trailing `.` or editor whitespace, 200 or more
 * code points after NFC, then a Windows reserved device name.
 */
export function layoutNameIssue(name: string): LayoutNameIssue | undefined {
  if (name === "") return { kind: "empty" };
  const chars = [...name.normalize()];
  const forbidden = chars.find((c) => LAYOUT_FORBIDDEN_CHARS.has(c));
  if (forbidden !== undefined) return { kind: "forbidden-char", char: forbidden };
  const edge = (c: string): boolean => c === "." || EDITOR_WHITESPACE.has(c);
  if (edge(chars[0]) || edge(chars[chars.length - 1])) return { kind: "edge-dot-or-space" };
  if (chars.length >= LAYOUT_NAME_LIMIT) return { kind: "too-long" };
  const device = reservedDeviceName(name);
  if (device !== undefined) return { kind: "reserved-device", segment: name, device };
  return undefined;
}

/** The reason text for a {@link LayoutNameIssue}, without any caller prefix. */
export function layoutNameIssueText(issue: LayoutNameIssue): string {
  switch (issue.kind) {
    case "empty":
      return "must not be empty";
    case "forbidden-char":
      return `must not contain '${issue.char}'`;
    case "edge-dot-or-space":
      return "must not start or end with '.' or a space";
    case "too-long":
      return "must be shorter than 200 characters";
    case "reserved-device":
      return nameSegmentIssueText({ kind: "reserved", segment: issue.segment, device: issue.device });
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}

/**
 * C3's `nit(name, true)` normalizer: uppercase the character after a space, drop punctuation and whitespace, strip
 * leading `_`, and empty a name made only of digits.
 */
export function normalizeObjectClassName(name: string): string {
  let chars = [...name.normalize()];
  for (let i = 0; i < chars.length - 1; i++) {
    if (chars[i] === " ") chars[i + 1] = chars[i + 1].toUpperCase();
  }
  chars = chars.filter((c) => !NORMALIZER_DROPPED.has(c) && !EDITOR_WHITESPACE.has(c));
  while (chars.length > 0 && chars[0] === "_") chars.shift();
  if (chars.length > 0 && chars.every((c) => c >= "0" && c <= "9")) chars = [];
  return chars.join("");
}

/** Why a new object-class name is unusable. */
export type ObjectClassNameIssue = { kind: "reserved-word"; name: string } | { kind: "normalized"; normalized: string };

/**
 * The first reason C3 would not keep `name` as written when creating an object class, or `undefined` when it would.
 * The reserved-word check runs first, on the name as written, so `System` reports the reserved reason. A name the
 * normalizer rewrites into a reserved word (`Sys tem` becomes `SysTem`, which is not reserved; `s-elf` becomes `self`)
 * is refused by the normalizer check, so both paths refuse.
 */
export function objectClassNameIssue(name: string): ObjectClassNameIssue | undefined {
  if (RESERVED_WORDS.has(name.toLowerCase())) return { kind: "reserved-word", name };
  const normalized = normalizeObjectClassName(name);
  if (normalized !== name) return { kind: "normalized", normalized };
  return undefined;
}

/** The reason text for an {@link ObjectClassNameIssue}, without any caller prefix. */
export function objectClassNameIssueText(issue: ObjectClassNameIssue): string {
  switch (issue.kind) {
    case "reserved-word":
      return `must not be '${issue.name}': C3 reserves it (self, true, false and system, letter case ignored)`;
    case "normalized":
      return `must be a name C3 keeps as written: C3 would load it as ${
        issue.normalized === "" ? "an empty name" : `'${issue.normalized}'`
      }`;
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}
