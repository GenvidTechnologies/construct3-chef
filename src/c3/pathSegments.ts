/**
 * Pure path-segment checks for names that become files on disk (#330).
 *
 * Off-barrel on purpose (not re-exported from `src/index.ts`): internal building blocks, not published API.
 */

/** Superscript one, two and three: Windows reserves `COM`/`LPT` followed by any of them, as well as 1-9. */
const SUPERSCRIPTS = String.fromCharCode(0xb9, 0xb2, 0xb3);

/**
 * The reserved set, from Microsoft's "Naming Files, Paths, and Namespaces": `CON PRN AUX NUL`, `COM1`-`COM9`,
 * `LPT1`-`LPT9` and their superscript-digit spellings. `CONIN$` and `CONOUT$` are the console names `CreateFile`
 * accepts. A regex with the `i` flag is used instead of a `toUpperCase()` lookup because `toUpperCase` maps the
 * dotless i (U+0131) to ASCII `I`, which would turn the non-reserved `CON` + dotless i + `N$` into `CONIN$`.
 */
const RESERVED = new RegExp(
  `^(?:CON|PRN|AUX|NUL|COM[1-9${SUPERSCRIPTS}]|LPT[1-9${SUPERSCRIPTS}]|CONIN[$]|CONOUT[$])$`,
  "i",
);

/**
 * The upper-cased reserved Windows device name `segment` resolves to, or `undefined` when it is not one. The base is
 * everything before the first `.` with trailing spaces trimmed: Microsoft documents a reserved name followed by an
 * extension (`NUL.txt`, `NUL.tar.gz`) as equivalent to the name, and Win32 path normalisation drops trailing dots and
 * spaces. So `NUL.json`, `NUL.`, `NUL ` and `NUL .json` all name `NUL`; a leading space, a leading dot or a longer
 * stem (`NULL`, `COM10`) does not.
 */
export function reservedDeviceName(segment: string): string | undefined {
  const base = segment.split(".")[0].replace(/ +$/, "");
  return RESERVED.test(base) ? base.toUpperCase() : undefined;
}

/** The shared refusal wording for a segment {@link reservedDeviceName} matched. */
export function reservedPhrase(i: { segment: string; device: string }): string {
  return `a Windows reserved device name: '${i.segment}' (${i.device})`;
}

/** True for a segment Win32 path normalisation would strip down to nothing (`.. `, `...`); a bare `.` and `` are not flagged. */
export function isDotsAndSpaces(segment: string): boolean {
  return segment !== "." && segment !== "" && segment.replace(/[ .]+$/, "") === "";
}

/** Why a path segment is unusable as a file or folder name. */
export type SegmentIssue =
  | { kind: "colon" }
  | { kind: "dots-and-spaces" }
  | { kind: "reserved"; segment: string; device: string };

/**
 * The first issue across `segments`, kind-major: every segment is scanned for `:` before any is scanned for
 * dots-and-spaces, and every segment for that before any is scanned for a reserved device name. `undefined` when
 * every segment is usable.
 */
export function segmentsIssue(segments: readonly string[]): SegmentIssue | undefined {
  // ':' is an NTFS alternate data stream on Windows but a literal name elsewhere, so it is host-dependent.
  if (segments.some((s) => s.includes(":"))) return { kind: "colon" };
  // Win32 path normalisation strips trailing dots and spaces, so `.. ` or `...` is a '.'/'..' in disguise.
  // A bare '.' is fine. (Node writes keep them; Win32 normalisation is what drops them.)
  if (segments.some(isDotsAndSpaces)) return { kind: "dots-and-spaces" };
  // Last, so a segment that is both reserved and malformed keeps its older, more specific wording. The segment is
  // reported as the caller passed it (`con.txt`), with the device it resolves to (`CON`).
  for (const segment of segments) {
    const device = reservedDeviceName(segment);
    if (device !== undefined) return { kind: "reserved", segment, device };
  }
  return undefined;
}

/** Path wording ("a segment ..."), for keys and folders. */
export function segmentIssueText(i: SegmentIssue): string {
  switch (i.kind) {
    case "colon":
      return "must not contain ':' (host-dependent on Windows)";
    case "dots-and-spaces":
      return "must not contain a segment that is only dots and spaces";
    case "reserved":
      return `must not contain a segment that is ${reservedPhrase(i)}`;
    default: {
      const exhaustive: never = i;
      return exhaustive;
    }
  }
}

/** Single-name wording, for an objectType name. */
export function nameSegmentIssueText(i: SegmentIssue): string {
  switch (i.kind) {
    case "colon":
      return "must not contain ':' (host-dependent on Windows)";
    case "dots-and-spaces":
      return "must not be only dots and spaces";
    case "reserved":
      return `must not be ${reservedPhrase(i)}`;
    default: {
      const exhaustive: never = i;
      return exhaustive;
    }
  }
}
