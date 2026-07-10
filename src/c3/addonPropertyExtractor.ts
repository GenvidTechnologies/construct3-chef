// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedProperty {
  id: string; // the property id (2nd arg to PluginProperty), a plain string literal
  items?: string[]; // for combo/link/group props declaring an items:[...] string-literal array; omitted otherwise
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Return a same-length copy of `text` with the *contents* of every string
 * literal ('...', "...", `...`) replaced by an inert filler character, while
 * the delimiting quotes and everything outside strings is preserved
 * verbatim. This lets downstream bracket/comma scanning treat the text
 * structurally (parens/commas inside a string literal can't be mistaken for
 * structural ones) while indices stay aligned with the original text, so
 * literal values are always sliced back out of the original.
 */
function maskStrings(text: string): string {
  const chars = text.split("");
  const n = chars.length;
  let quote: string | null = null;
  let i = 0;
  while (i < n) {
    const c = chars[i];
    if (quote === null) {
      if (c === "'" || c === '"' || c === "`") quote = c;
      i++;
      continue;
    }
    if (c === "\\") {
      chars[i] = "x";
      i++;
      if (i < n) {
        chars[i] = "x";
        i++;
      }
      continue;
    }
    if (c === quote) {
      quote = null;
      i++;
      continue;
    }
    chars[i] = "x";
    i++;
  }
  return chars.join("");
}

/**
 * Find the index of the bracket matching `openChar` at `openIdx`, scanning
 * `masked` (string-literal-safe, same length/indices as the real source) so
 * bracket-like characters inside string literals never affect depth.
 * Returns -1 if `openIdx` isn't `openChar` in `masked` or no match is found.
 */
function findMatchingBracket(masked: string, openIdx: number, openChar: string, closeChar: string): number {
  if (masked[openIdx] !== openChar) return -1;
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split `text` on top-level commas only (depth 0 across `()[]{}`), using the
 * aligned `masked` text to stay string-literal-safe. Trims each part and
 * drops empty parts (so an empty `text` yields `[]`).
 */
function splitTopLevelArgs(text: string, masked: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Map a single escaped character (the char following a `\`) to its value. */
function unescapeChar(c: string): string {
  if (c === "n") return "\n";
  if (c === "t") return "\t";
  return c;
}

/**
 * Parse `text` as a single plain single- or double-quoted string literal
 * (no concatenation, no template literals). Returns the unescaped value, or
 * `null` if `text` isn't exactly one such literal.
 */
function parseStringLiteral(text: string): string | null {
  const t = text.trim();
  if (t.length < 2) return null;
  const q = t[0];
  if ((q !== "'" && q !== '"') || t[t.length - 1] !== q) return null;

  let result = "";
  let i = 1;
  const end = t.length - 1;
  while (i < end) {
    const c = t[i];
    if (c === "\\") {
      if (i + 1 >= end + 1) return null; // dangling escape
      result += unescapeChar(t[i + 1]);
      i += 2;
      continue;
    }
    if (c === q) {
      // An unescaped quote before the closing one means this isn't a single
      // plain literal (e.g. concatenation) — don't guess, reject.
      return null;
    }
    result += c;
    i++;
  }
  return result;
}

/**
 * Look for an `items:` object-literal key anywhere in `argsText` (string-
 * literal-safe via `maskedArgsText`) whose value is a bracketed array of
 * plain string literals, and return the unescaped values. Returns
 * `undefined` if no `items:` key is found, or its value isn't a simple
 * string-literal array (never guesses).
 */
function extractItemsArray(argsText: string, maskedArgsText: string): string[] | undefined {
  const re = /\bitems\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(maskedArgsText)) !== null) {
    let i = match.index + match[0].length;
    while (i < maskedArgsText.length && /\s/.test(maskedArgsText[i])) i++;
    if (maskedArgsText[i] !== ":") continue;
    i++;
    while (i < maskedArgsText.length && /\s/.test(maskedArgsText[i])) i++;
    if (maskedArgsText[i] !== "[") continue;

    const closeIdx = findMatchingBracket(maskedArgsText, i, "[", "]");
    if (closeIdx === -1) continue;

    const inner = argsText.slice(i + 1, closeIdx);
    const maskedInner = maskedArgsText.slice(i + 1, closeIdx);
    const elements = splitTopLevelArgs(inner, maskedInner);

    const values: string[] = [];
    for (const el of elements) {
      const lit = parseStringLiteral(el);
      if (lit === null) return undefined; // not a simple string-literal array — omit entirely
      values.push(lit);
    }
    return values;
  }
  return undefined;
}

/**
 * Parse the captured argument-list text of a single `new SDK.PluginProperty(
 * ... )` call. Returns `null` if the 2nd top-level argument isn't a plain
 * string literal (a variable, template literal, or other expression) — such
 * a property is skipped, never guessed at.
 */
function parsePropertyArgs(argsText: string, maskedArgsText: string): ExtractedProperty | null {
  const args = splitTopLevelArgs(argsText, maskedArgsText);
  if (args.length < 2) return null;

  const id = parseStringLiteral(args[1]);
  if (id === null) return null;

  const property: ExtractedProperty = { id };
  const items = extractItemsArray(argsText, maskedArgsText);
  if (items !== undefined) property.items = items;
  return property;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Best-effort extraction of `new SDK.PluginProperty(...)` declarations from
 * an addon's editor-side `plugin.js` source (the SDK v2 addon root
 * `plugin.js`, not `c3runtime/plugin.js`). For each call site, extracts the
 * property id (2nd argument) when it's a plain string literal, plus an
 * `items` array when a later object-literal argument declares one as a
 * simple string-literal array (combo/link/group-style properties).
 *
 * Bounded, dependency-free: a balanced-parenthesis, string-literal-aware
 * scan — not a full JS parser. Any call site whose id isn't a plain string
 * literal, or whose `items` value isn't a simple string-literal array, is
 * skipped (id) or has `items` omitted, rather than guessed at. Malformed
 * call sites (e.g. unmatched parens) are skipped; scanning continues with
 * the next occurrence. Never throws — a wholesale failure yields `[]`.
 */
export function extractPluginProperties(source: string): ExtractedProperty[] {
  if (typeof source !== "string" || source.length === 0) return [];

  try {
    const masked = maskStrings(source);
    const marker = "new SDK.PluginProperty(";
    const results: ExtractedProperty[] = [];
    let searchFrom = 0;

    for (;;) {
      const idx = source.indexOf(marker, searchFrom);
      if (idx === -1) break;

      const openParenIdx = idx + marker.length - 1;
      const closeParenIdx = findMatchingBracket(masked, openParenIdx, "(", ")");

      if (closeParenIdx === -1) {
        searchFrom = idx + marker.length;
        continue;
      }

      const argsText = source.slice(openParenIdx + 1, closeParenIdx);
      const maskedArgsText = masked.slice(openParenIdx + 1, closeParenIdx);

      const property = parsePropertyArgs(argsText, maskedArgsText);
      if (property !== null) results.push(property);

      searchFrom = closeParenIdx + 1;
    }

    return results;
  } catch {
    return [];
  }
}
