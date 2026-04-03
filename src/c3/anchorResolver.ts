/**
 * Anchor resolver for `.dsl.idx.txt` files.
 *
 * Parses the coordinate index produced by the DSL generator and provides
 * three lookup strategies: by DSL line number, by SID, and by name/regex.
 */

export interface Anchor {
  eventNumber: number | null;
  jsonPath: string;
  sid: number | undefined;
  dslLine: number;
  description: string;
}

export type AnchorLookup =
  | { by: "line"; line: number }
  | { by: "sid"; sid: number }
  | { by: "name"; name: string };

export interface AnchorResult {
  /** true if lookup matched exactly, false if nearest-enclosing */
  exact: boolean;
  anchor: Anchor;
  alternatives?: Anchor[];
}

/**
 * Parse a `.dsl.idx.txt` index file into an array of Anchor objects.
 *
 * Action rows (sub-rows with no DSL line and no SID) are excluded from the
 * result — they cannot be recipe targets.
 */
export function parseIndexText(indexText: string): Anchor[] {
  const anchors: Anchor[] = [];

  for (const rawLine of indexText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    // Skip header/comment lines and empty lines
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const parts = line.split("|");
    if (parts.length < 5) continue;

    const [rawEvent, rawPath, rawSid, rawDslLine, ...descParts] = parts;
    const jsonPath = rawPath.trim();
    const dslLineStr = rawDslLine.trim();
    const description = descParts.join("|").trim();

    // Action rows: no dslLine — skip them
    if (!dslLineStr) continue;

    const dslLine = parseInt(dslLineStr, 10);
    if (isNaN(dslLine)) continue;

    const eventStr = rawEvent.trim();
    let eventNumber: number | null = null;
    if (eventStr !== "" && eventStr !== "-") {
      const parsed = parseInt(eventStr, 10);
      if (!isNaN(parsed)) {
        eventNumber = parsed;
      }
    }

    const sidStr = rawSid.trim();
    let sid: number | undefined;
    if (sidStr.startsWith("§")) {
      const sidNum = parseInt(sidStr.slice(1), 10);
      if (!isNaN(sidNum)) {
        sid = sidNum;
      }
    }

    anchors.push({ eventNumber, jsonPath, sid, dslLine, description });
  }

  return anchors;
}

/**
 * Resolve an anchor lookup against a parsed index.
 *
 * - `by: "line"`: Finds the entry at or nearest-below the given line number.
 *   Returns `exact: true` only when `dslLine` matches exactly.
 *   Returns `null` if the given line is before all entries.
 *
 * - `by: "sid"`: Exact SID match. Returns `exact: true` or `null`.
 *
 * - `by: "name"`: Regex match against the description field.
 *   First match is `anchor`, additional matches go in `alternatives`.
 *   Returns `null` if no match.
 */
export function resolveAnchor(
  indexText: string,
  lookup: AnchorLookup,
): AnchorResult | null {
  const anchors = parseIndexText(indexText);

  switch (lookup.by) {
    case "line": {
      return resolveByLine(anchors, lookup.line);
    }
    case "sid": {
      return resolveBySid(anchors, lookup.sid);
    }
    case "name": {
      return resolveByName(anchors, lookup.name);
    }
  }
}

function resolveByLine(anchors: Anchor[], targetLine: number): AnchorResult | null {
  // Find all anchors with dslLine <= targetLine, pick the one with the largest dslLine
  let best: Anchor | null = null;
  for (const anchor of anchors) {
    if (anchor.dslLine <= targetLine) {
      if (best === null || anchor.dslLine > best.dslLine) {
        best = anchor;
      }
    }
  }

  if (best === null) return null;

  return {
    exact: best.dslLine === targetLine,
    anchor: best,
  };
}

function resolveBySid(anchors: Anchor[], targetSid: number): AnchorResult | null {
  const found = anchors.find((a) => a.sid === targetSid);
  if (!found) return null;
  return { exact: true, anchor: found };
}

function resolveByName(anchors: Anchor[], pattern: string): AnchorResult | null {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    // If the pattern is not a valid regex, fall back to literal string match
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  const matches = anchors.filter((a) => regex.test(a.description));
  if (matches.length === 0) return null;

  const [first, ...rest] = matches;
  return {
    exact: true,
    anchor: first,
    alternatives: rest.length > 0 ? rest : undefined,
  };
}
