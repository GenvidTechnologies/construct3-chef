import {
  detectManifestDrift,
  type DuplicateName,
  type DuplicateOccurrence,
  type SkippedLink,
} from "@genvidtech/c3source";

/**
 * Print cap per list. Same value as `STRAY_REPORT_LIMIT` in `projectSync.ts`, which is not exported;
 * the return carries every finding, so the cap bounds only what is printed.
 */
const ADVISORY_REPORT_LIMIT = 20;

/**
 * Advisory drift report (detection-only): item names repeated within a uniqueness scope
 * (`[duplicates]`) and symbolic links or junctions that the walk did not follow (`[links]`),
 * as found by c3source's `detectManifestDrift`.
 *
 * Emits label-column lines via `log`, at least one per list (`(no duplicates)` / `(no links)`
 * when empty). Follows the shape of `reportStrayFiles`.
 *
 * **Advisory.** This function never throws because of a finding and changes no exit code and no
 * `SyncResult.clean`. A malformed `project.c3proj` still throws, as it does for any manifest read.
 * The policy for advisories is ADR 0070.
 *
 * **A duplicate is not drift.** Drift keying stays exact upstream: a case-only rename still reads
 * as `missing` plus `untracked`. Which names count as duplicates is c3source's
 * `DuplicateName` definition; it is not restated here.
 *
 * `skipFileSections` is set because the `rootFileFolders.*` sections are chef's own walk and their
 * uniqueness scope is unvalidated upstream. Every scope upstream returns under that option is
 * reported (the name scopes and `images`).
 *
 * Returns the full findings, not the capped rendering. A side of a duplicate with no occurrences
 * prints as `(none)`.
 */
export function reportDriftAdvisories(
  rootDir: string,
  log: (line: string) => void,
): { duplicates: DuplicateName[]; links: SkippedLink[] } {
  const drift = detectManifestDrift(rootDir, undefined, { skipFileSections: true });
  const duplicates = drift.duplicates ?? [];
  const links = drift.links ?? [];

  const emit = (label: string, empty: string, lines: string[]): void => {
    const col = label.padEnd(16);
    if (lines.length === 0) {
      log(col + empty);
      return;
    }
    for (const l of lines.slice(0, ADVISORY_REPORT_LIMIT)) log(col + l);
    if (lines.length > ADVISORY_REPORT_LIMIT) {
      log(col + `… and ${lines.length - ADVISORY_REPORT_LIMIT} more (${lines.length} total)`);
    }
  };

  const occ = (o: DuplicateOccurrence): string => [o.folder, ...o.path, o.name].join("/");
  const side = (os: DuplicateOccurrence[]): string => (os.length === 0 ? "(none)" : os.map(occ).join(", "));

  emit(
    "[duplicates]",
    "(no duplicates)",
    duplicates.map((d) => `! ${d.scope} '${d.key}': manifest ${side(d.manifest)}; disk ${side(d.disk)}`),
  );
  emit(
    "[links]",
    "(no links)",
    links.map((l) => `! ${[l.folder, ...l.diskPath, l.name].join("/")} (not followed)`),
  );
  return { duplicates, links };
}
