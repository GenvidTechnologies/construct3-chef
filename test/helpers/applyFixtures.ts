import {
  mkdtempSync,
  cpSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  chmodSync,
  realpathSync,
  utimesSync,
} from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

const FIXTURE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

/**
 * Stamp every file under `<root>/extracted/` an hour into the future, so a fresh copy never reads as stale.
 *
 * Whether `cpSync` keeps the source's mtimes depends on the platform: Windows keeps them, Linux stamps
 * each file as it is copied, so the copy order and the clock decide whether extracted/ ends up older
 * than the source dirs. checkSourceFreshness/checkDerivedFreshness compare with a strict
 * `source > extracted` and bump the txId when it holds, which made a token taken from a fresh copy
 * stale on some CI runs (#302). Tests that want staleness set it explicitly afterwards.
 */
export function makeExtractedNewerThanSource(root: string): void {
  const future = new Date(Date.now() + 3_600_000);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else utimesSync(full, future, future);
    }
  };
  const extractedDir = path.join(root, "extracted");
  if (existsSync(extractedDir)) walk(extractedDir);
}

/** Temp copy of the whole sample fixture; realpath'd because os.tmpdir() is an 8.3 short path on Windows. */
export function copyFixture(prefix = "c3chef-apply-"): string {
  const t = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), prefix));
  cpSync(FIXTURE_ROOT, t, { recursive: true });
  makeExtractedNewerThanSource(t);
  return t;
}

/** Relative POSIX path -> sha256 for every file outside `extracted/`. */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (rel === "extracted") continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export function plantBrokenSheet(root: string): void {
  writeFileSync(path.join(root, "eventSheets", "Broken.json"), "{ not json");
}

export function plantBrokenLayout(root: string): void {
  writeFileSync(path.join(root, "layouts", "Broken.json"), "{ not json");
}

export function breakManifest(root: string): void {
  writeFileSync(path.join(root, "project.c3proj"), "{ not json");
}

/** chmod 0o444; returns a restore function (0o666). Call the restore before rmSync (Windows EPERM). */
export function makeReadOnly(file: string): () => void {
  chmodSync(file, 0o444);
  return () => chmodSync(file, 0o666);
}
