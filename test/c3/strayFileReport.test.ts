import { describe, it, afterEach } from "mocha";
import { assert } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { reportStrayFiles, NAME_SECTIONS } from "../../src/c3/projectSync.js";
import { runCli } from "../helpers/runCli.js";

/**
 * #177. Pins the `[strays]` detection-only report: `reportStrayFiles`'s rendered
 * output, and its wiring at the CLI `validate-project` / `sync-project` surfaces.
 *
 * DELIBERATELY DISTINCT from the neighbouring `strayFileTolerance.test.ts`, which
 * this file must not be confused with or folded into:
 *   - *tolerance* (#175) = chef's consumers do not CRASH on a stray file;
 *   - *report* (#177, here) = the stray file is SURFACED to the user.
 *
 * KNOWN-RED BASELINE at the commit that introduces this file. The three `runCli`
 * rows below (R3, R4, R10) assert on a `[strays]` line in the CLI's real stdout,
 * and nothing in `src/cli.ts` emits one until the wiring task lands. Their red
 * state is the structural revert-confirm that the wiring is genuinely load-bearing
 * — the same discipline as `strayFileTolerance.test.ts`'s committed-red step. Every
 * other row in this file is green from the start. (`test/mcp/serverHandlers.test.ts`
 * carries the other two red rows, R2 and R15, which need the MCP seams.)
 *
 * ALL seeding is synthetic temp-dir. No row may assert against
 * `test/fixtures/construct3-chef-sample/`: `detectStrayFiles` returns `[]` there and
 * `scripts/verify-fixture-parity.mjs` forbids adding a stray, so a fixture-based
 * positive assertion would pass vacuously (the #149/#175 shape).
 */
describe("[strays] detection-only report (#177)", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, { recursive: true, force: true });
    }
  });

  function tmpRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "c3chef-strayreport-"));
    created.push(root);
    return root;
  }

  function write(root: string, relPath: string, contents: string): void {
    const full = path.join(root, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }

  /**
   * Reporter-only seed. `detectStrayFiles` is manifest-INDEPENDENT — it classifies
   * basenames under the seven name-section roots and never reads `project.c3proj` —
   * so an empty manifest is sufficient for every row that calls `reportStrayFiles`
   * directly. Same pattern as `strayFileTolerance.test.ts`'s `seedProject()`.
   */
  function seedReporterProject(): string {
    const root = tmpRoot();
    writeFileSync(path.join(root, "project.c3proj"), JSON.stringify({}, null, "\t"));
    return root;
  }

  /**
   * `runSync`-clean seed, for the rows that route through `runSync` →
   * `readProjectManifest` (which shape-validates) and additionally need
   * `result.clean === true` so the CLI exits 0.
   *
   * Two shape traps this seed exists to encode: each section's `items` is a
   * `string[]` of BARE NAMES (not objects carrying a `sid`), and the
   * `rootFileFolders` key for the general file folder is `general`, NOT `file`.
   * Getting either wrong throws `Could not parse … as JSON` out of
   * `readProjectManifest` — a seeding failure that looks nothing like the
   * missing-`[strays]`-line failure the red rows are meant to produce.
   *
   * Written without a trailing newline, matching how chef writes `project.c3proj`.
   */
  function seedSyncCleanProject(): string {
    const root = tmpRoot();
    const empty = () => ({ items: [] as string[], subfolders: [] as unknown[] });
    const manifest = {
      projectFormatVersion: 1,
      savedWithRelease: 49500,
      name: "StrayReportProbe",
      runtime: "c3",
      usedAddons: [],
      containers: [],
      layouts: { items: ["MainLayout"], subfolders: [] },
      eventSheets: empty(),
      families: empty(),
      objectTypes: empty(),
      timelines: empty(),
      flowcharts: empty(),
      rootFileFolders: {
        script: empty(),
        sound: empty(),
        music: empty(),
        video: empty(),
        font: empty(),
        icon: empty(),
        general: empty(),
      },
    };
    writeFileSync(path.join(root, "project.c3proj"), JSON.stringify(manifest, undefined, "\t"));
    write(
      root,
      path.join("layouts", "MainLayout.json"),
      JSON.stringify({ name: "MainLayout", layers: [] }, null, "\t"),
    );
    return root;
  }

  function capture(root: string): string[] {
    const lines: string[] = [];
    reportStrayFiles(root, (m) => lines.push(m));
    return lines;
  }

  // ── R5 ─────────────────────────────────────────────────────────────────────
  // A clean project is never silent: exactly one line, mirroring the pinned
  // `reportImageDrift` "(no drift)" clean-project test in syncC3Proj.test.ts.

  it("R5: a clean project emits exactly one (no strays) line", () => {
    const root = seedReporterProject();
    write(root, path.join("layouts", "MainLayout.json"), JSON.stringify({ name: "MainLayout", layers: [] }));
    write(root, path.join("objectTypes", "Hero.json"), JSON.stringify({ name: "Hero" }));

    const lines = capture(root);

    assert.lengthOf(lines, 1);
    assert.match(lines[0], /^\[strays\]\s+\(no strays\)$/);
  });

  // ── R6 + R7 ────────────────────────────────────────────────────────────────
  // One seed, two assertions. `notes.txt` is the POSITIVE CONTROL: it proves the
  // walk reached `layouts/`, which is what makes the surrounding absences (the
  // editor-local files for R6, the `.json` section items for R7) meaningful
  // rather than vacuous. This seed is deliberately NOT shared with R8/R9/R11/R13
  // — every extra stray would break R6's "exactly one `! ` row".

  it("R6/R7: editor-local files and .json section items are never reported", () => {
    const root = seedReporterProject();
    // Positive control — the one file that MUST be reported.
    write(root, path.join("layouts", "notes.txt"), "a stray note\n");
    // R6: editor-local, both dimensions — a `*.uistate.json` sibling and a `uistate/` dir.
    write(root, path.join("layouts", "Main.uistate.json"), "{}");
    write(root, path.join("layouts", "uistate", "a.txt"), "editor-local\n");
    // R7: real `.json` section items, which are items and therefore never strays.
    write(root, path.join("layouts", "MainLayout.json"), JSON.stringify({ name: "MainLayout", layers: [] }));
    write(root, path.join("objectTypes", "Hero.json"), JSON.stringify({ name: "Hero" }));

    const lines = capture(root);
    const strayRows = lines.filter((l) => l.includes("! "));

    // R6: exactly one stray row, and it is the positive control.
    assert.lengthOf(strayRows, 1, `expected exactly one stray row, got: ${JSON.stringify(lines)}`);
    assert.match(strayRows[0], /^\[strays\]\s+! layouts\/notes\.txt$/);

    // R7: neither section item appears anywhere in the report.
    for (const line of lines) {
      assert.notInclude(line, "MainLayout");
      assert.notInclude(line, "Hero");
    }
  });

  // ── R8 ─────────────────────────────────────────────────────────────────────

  it("R8: a nested stray renders its section-root-relative subfolder path", () => {
    const root = seedReporterProject();
    write(root, path.join("layouts", "sub", "deep.md"), "# deep\n");

    const lines = capture(root);

    // Full-line, not a substring: `[strays]` (8 chars) padded to 16 => exactly 8 spaces.
    assert.isTrue(
      lines.some((l) => /^\[strays\] {8}! layouts\/sub\/deep\.md$/.test(l)),
      `expected a full-line [strays] row for layouts/sub/deep.md, got: ${JSON.stringify(lines)}`,
    );
  });

  // ── R9 ─────────────────────────────────────────────────────────────────────
  // `models3d` is upstream's seventh name section and the one chef's NAME_SECTIONS
  // deliberately excludes from SYNC. Both halves matter: the stray is reported
  // (reporting is not syncing), and sync still does not touch the section.
  // Uses the runSync-clean seed because the second half calls `runSync`.
  // NOTE: `models3d` is not a legal `--section` value; `"layouts"` is.

  it("R9: a models3d stray is reported, and reporting it does not make it a sync target", () => {
    const root = seedSyncCleanProject();
    write(root, path.join("models3d", "mesh.obj"), "o mesh\n");

    const lines = capture(root);
    assert.include(lines, "[strays]".padEnd(16) + "! models3d/mesh.obj");

    // The "did not become a sync target" half is pinned STRUCTURALLY, against
    // NAME_SECTIONS itself. Asserting it behaviourally — e.g. that
    // `runSync(root, true, noop, "layouts").changes` carries no models3d entry —
    // is unfalsifiable three times over: the section filter already excludes
    // every section but layouts, the seed manifest has no models3d key to drift
    // against, and upstream partitions items from strays so a stray can never
    // surface as a DriftEntry at all. That assertion passes just as happily
    // WITH models3d added to NAME_SECTIONS, which is precisely the state it
    // claims to forbid. This one fails in that state.
    assert.notInclude(
      NAME_SECTIONS.map((s) => s.key),
      "models3d",
      "reporting a models3d stray must not turn models3d into a sync target",
    );
  });

  // ── R11 ────────────────────────────────────────────────────────────────────
  // Neither MCP tool that emits this report paginates, so the row count is capped.

  it("R11: output is capped at 20 rows with a `… and N more` tail", () => {
    const root = seedReporterProject();
    for (let i = 0; i < 25; i++) {
      write(root, path.join("layouts", `stray${String(i).padStart(2, "0")}.txt`), "x");
    }

    const lines = capture(root);

    assert.lengthOf(lines, 21);
    assert.lengthOf(
      lines.filter((l) => l.includes("! ")),
      20,
    );
    assert.match(lines[20], /^\[strays\]\s+… and 5 more \(25 total\)$/);
  });

  // ── R13 ────────────────────────────────────────────────────────────────────
  // Pins the behaviour (rather than leaving it accidental) for a configured
  // `extractedDir` that lives UNDER one of the seven section roots: its generated
  // files are strays and are reported. `docs/cli.md` recommends keeping
  // `extractedDir` outside the section roots for exactly this reason.

  it("R13: an extractedDir nested under a section root is reported", () => {
    const root = seedReporterProject();
    write(root, path.join("layouts", "extracted", "Foo.dsl.txt"), "dsl\n");

    const lines = capture(root);

    assert.include(lines, "[strays]".padEnd(16) + "! layouts/extracted/Foo.dsl.txt");
  });

  // ── T5 — KNOWN-RED at the commit that introduces this row ───────────────────
  // `reportStrayFiles` is currently declared `: void` and returns `undefined` at
  // runtime, so `strays.length` throws a `TypeError`. That red state is the
  // structural revert-confirm that widening the return type is genuinely
  // load-bearing — the same committed-red discipline as
  // `strayFileTolerance.test.ts`'s R-rows above. A later task widens the return
  // type to `StrayFile[]`, at which point this row goes green with no edit here.

  it("T5: reportStrayFiles returns the full detected set, not the capped rendering", () => {
    const root = seedReporterProject();
    for (let i = 1; i <= 25; i++) {
      write(root, path.join("layouts", `stray-${String(i).padStart(2, "0")}.txt`), "x");
    }

    const lines: string[] = [];
    const strays = reportStrayFiles(root, (m) => lines.push(m));

    // Raw `.length` access (not `assert.lengthOf`, which would intercept an
    // undefined target with its own "Target cannot be null or undefined."
    // AssertionError) so the RED failure is the actual runtime `TypeError`
    // this row exists to prove: `reportStrayFiles` is currently `: void` and
    // returns `undefined`.
    // The full detected set, uncapped.
    assert.equal(strays.length, 25);
    // The rendering stays capped: 20 rows + 1 "… and N more" tail line.
    assert.equal(lines.length, 21);
  });

  // ── R3 / R4 / R10 — CLI process boundary (RED until the wiring lands) ───────
  // These three use the real-subprocess `runCli` helper because they assert on a
  // real process exit code, which no in-process unit test can reach. Per that
  // helper's own docstring it stays scoped to exactly this kind of row — do not
  // migrate the rows above onto it.

  it("R3: a stray never affects the exit code (informational severity)", () => {
    const root = seedSyncCleanProject();
    write(root, path.join("layouts", "notes.txt"), "a stray note\n");

    const result = runCli(["validate-project", "--project-dir", root]);

    // Both assertions are required: exit 0 alone would also pass with the
    // reporter entirely absent, so the stdout match is the wiring assertion.
    assert.equal(result.exitCode, 0, `expected exit 0; stderr: ${result.stderr}`);
    assert.match(result.stdout, /^\[strays\]\s+! layouts\/notes\.txt$/m);
  });

  it("R4: the [strays] report survives a run that exits non-zero", () => {
    const root = seedSyncCleanProject();
    // Real manifest drift → validate-project exits 1.
    write(root, path.join("eventSheets", "Untracked.json"), JSON.stringify({ name: "Untracked", events: [] }));
    write(root, path.join("layouts", "notes.txt"), "a stray note\n");

    const result = runCli(["validate-project", "--project-dir", root]);

    assert.equal(result.exitCode, 1, `expected exit 1; stderr: ${result.stderr}`);
    // Regression guard: validate-project sets `process.exitCode` rather than
    // calling a terminal `process.exit(1)`, so nothing can truncate the report
    // before it prints — but this row still pins that the report survives a
    // non-zero exit, in case that ever changes back.
    assert.match(result.stdout, /^\[strays\]\s+! layouts\/notes\.txt$/m);
  });

  it("R10: --section does not narrow the stray report", () => {
    const root = seedSyncCleanProject();
    write(root, path.join("objectTypes", "README.md"), "# notes\n");

    const result = runCli(["validate-project", "--section", "layouts", "--project-dir", root]);

    // The report is project-wide, exactly as `[images]` already is.
    assert.match(result.stdout, /^\[strays\]\s+! objectTypes\/README\.md$/m);
    assert.equal(result.exitCode, 0, `expected exit 0; stderr: ${result.stderr}`);
  });
});
