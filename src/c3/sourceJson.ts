import { writeFileSync } from "node:fs";

/**
 * Writes a C3 **source** JSON file (`eventSheets/`, `layouts/`,
 * `objectTypes/`) in the project's canonical on-disk form: tab-indented,
 * with no trailing newline. Every file in the canonical fixture
 * (`test/fixtures/construct3-sample/project`) ends at its closing `}`/`]` —
 * this helper encodes that ground truth so no call site has to.
 *
 * Not for `project.c3proj` — that manifest is written separately via
 * c3source's `writeProjectManifest`/`serializeProjectManifest`, which
 * already emits no trailing newline in its own, different way.
 *
 * Deliberately synchronous, so the write is done before the caller returns.
 * Its fs event still arrives later: MCP call sites register the path with the
 * watcher before calling this (#277).
 *
 * Off-barrel deliberately: not re-exported from `src/index.ts` (repo is at
 * 1.0.0, and a barrel export is a permanent public-API commitment). This is
 * an internal write helper, not published API — see `src/c3/addonValidator.ts`
 * / `src/c3/editorLocal.ts` for the same pattern.
 */
export function writeSourceJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, serializeSourceJson(value));
}

/**
 * The canonical source-JSON serialization (tab-indented, no trailing
 * newline) as a string. `writeSourceJson` and the in-memory `SourceIo`
 * overlay share this one serializer so the bytes cannot diverge.
 */
export function serializeSourceJson(value: unknown): string {
  return JSON.stringify(value, null, "\t");
}
