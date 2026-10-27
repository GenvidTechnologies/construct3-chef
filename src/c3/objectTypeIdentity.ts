/**
 * Pure objectType name identity over an injected listing, so the scaffold guard and the
 * scaffold-sprite source lookup share one rule: an objectType's identity is its file basename
 * `<name>.json` with letter case ignored (ADR `wiki/decisions/0046` §2). Same pure-over-a-listing
 * shape as `findSpellingMismatches` in `recipeKeys.ts`.
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts`.
 */

import * as path from "node:path";

/** Listed objectType files whose basename equals `${name}.json` with letter case ignored (ADR 0046 §2). */
export function objectTypeNameMatches(listing: readonly string[], name: string): string[] {
  const want = `${name}.json`.toLowerCase();
  return listing.filter((p) => path.basename(p).toLowerCase() === want);
}

export type ObjectTypeCreateDecision =
  | { kind: "create" } // zero matches on disk
  | { kind: "skip"; path: string } // exactly one match, and it is the entry's own target, letter case included
  | { kind: "refuse"; onDisk: string[] }; // a case variant, another folder, a folder-case variant, or 2+ matches

/**
 * Decide what a recipe objectType entry may do against the existing listing (#274, ADR 0046 §4: refuse rather than
 * resolve). `listing` and `targetPath` must be spelled the same way, both root-relative with "/" separators
 * (e.g. `objectTypes/images/Sprite.json`); both are POSIX-normalized here, so a doubled or trailing "/" in a folder
 * does not matter. Letter case is compared exactly. Pure: no I/O.
 */
export function decideObjectTypeCreate(
  listing: readonly string[],
  targetPath: string,
  name: string,
): ObjectTypeCreateDecision {
  const matches = objectTypeNameMatches(listing, name);
  if (matches.length === 0) return { kind: "create" };
  const want = path.posix.normalize(targetPath);
  if (matches.length === 1 && path.posix.normalize(matches[0]!) === want) return { kind: "skip", path: matches[0]! };
  return { kind: "refuse", onDisk: matches };
}

export type ObjectTypeLookup =
  | { kind: "found"; path: string } // exactly one match, exact spelling
  | { kind: "not-found" } // zero matches
  | { kind: "case-mismatch"; onDisk: string } // exactly one match, different letter case
  | { kind: "ambiguous"; matches: string[] }; // two or more matches (exact or case-variant), never first-hit

/** Resolve `name` against a listing of objectType file paths; two or more matches are ambiguous, never first-hit. */
export function lookupObjectTypeByName(listing: readonly string[], name: string): ObjectTypeLookup {
  const matches = objectTypeNameMatches(listing, name);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  const only = matches[0]!;
  return path.basename(only) === `${name}.json`
    ? { kind: "found", path: only }
    : { kind: "case-mismatch", onDisk: only };
}
