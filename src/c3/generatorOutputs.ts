import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FOLD_CASE } from "./sourceIo.js";

/** Identity of a path on this platform: case-folded where the filesystem folds case. */
function foldKey(p: string): string {
  const resolved = path.resolve(p);
  return FOLD_CASE ? resolved.toLowerCase() : resolved;
}

/** Every regular file under `dir`, recursively (directories are never listed). Empty when `dir` is absent. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full));
    else found.push(full);
  }
  return found;
}

/**
 * Write a generator's outputs in place, then delete only its orphans.
 *
 * Ordering guarantee: computing `outputs` is the caller's job and happens
 * first; every output is written before any orphan is deleted, so a write that
 * throws propagates with the previous owned files still on disk. Owned files
 * are those whose name ends with one of `ownedSuffixes` (the `cleanOwnedFiles`
 * rule). Outputs are always rewritten, even when unchanged, because the server
 * compares mtimes to judge freshness.
 */
export function replaceOwnedOutputs(
  outDir: string,
  ownedSuffixes: readonly string[],
  outputs: ReadonlyMap<string, string>,
): void {
  const owned = listFiles(outDir).filter((f) => ownedSuffixes.some((s) => f.endsWith(s)));

  mkdirSync(outDir, { recursive: true });

  // Case-only respelling: rename an existing file to the output's spelling.
  const outputKeys = new Map<string, string>();
  for (const out of outputs.keys()) outputKeys.set(foldKey(out), out);
  const survivors: string[] = [];
  for (const existing of owned) {
    const target = outputKeys.get(foldKey(existing));
    if (FOLD_CASE && target !== undefined && path.resolve(target) !== path.resolve(existing)) {
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(existing, target);
      survivors.push(target);
    } else {
      survivors.push(existing);
    }
  }

  // Write every output.
  for (const [out, content] of outputs) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, content);
  }

  // Delete orphans: snapshot files that are not outputs.
  for (const file of survivors) {
    if (!outputKeys.has(foldKey(file))) rmSync(file, { force: true });
  }

  // Prune directories emptied by the orphan pass, deepest first, never outDir.
  const root = path.resolve(outDir);
  const dirs = new Set<string>();
  for (const file of owned) {
    let d = path.dirname(path.resolve(file));
    while (d !== root && d.startsWith(root)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true });
  }
}
