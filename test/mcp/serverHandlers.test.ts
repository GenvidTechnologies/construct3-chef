import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { READ_ONLY, walkFiles, toPosixPath } from "@genvidtech/mcp-utils";
import {
  __getHandler,
  __getToolConfig,
  __listToolNames,
  __setTestWatcher,
  __setExtractedDirty,
  __getExtractedDirty,
  __setProjectRoot,
  __resetTestState,
} from "../../src/mcp/server.js";
import { validateAddons, formatAddonValidation } from "../../src/c3/addonValidator.js";
import { listAddons, formatAddonInventory } from "../../src/c3/addonInventory.js";
import { syncAddonMetadata, formatAddonMetadataSync, type AddonSyncResult } from "../../src/c3/addonMetadataSync.js";
import { SID_SOURCE_DIRS } from "../../src/c3/generators.js";
import { reportStrayFiles, runSync } from "../../src/c3/projectSync.js";
import { buildScenario, cleanupScenarios } from "../helpers/syncScenarios.js";
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";
import { runCli } from "../helpers/runCli.js";
import {
  snapshotTree,
  plantBrokenSheet,
  plantBrokenLayout,
  breakManifest,
  makeReadOnly,
  makeExtractedNewerThanSource,
} from "../helpers/applyFixtures.js";
import { applyParsed } from "../../src/c3/recipeApplier.js";
import { formatScaffoldRefusal } from "../../src/c3/scaffoldGuard.js";
import {
  formatScaffoldPathRejection,
  formatScaffoldEmptyInput,
  formatScaffoldOutputNotJson,
  formatScaffoldSourceNotFile,
  formatScaffoldNameRejection,
  formatScaffoldSourceNotFound,
  formatScaffoldSourceCaseMismatch,
  formatScaffoldSourceAmbiguous,
} from "../../src/c3/scaffoldPlan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "construct3-chef-sample");

// The stale-warning string — must match the literal in server.ts exactly
const STALE_WARNING = "\n\n[Warning: extracted files may be stale — run regenerate to refresh]";

// A minimal valid recipe that applies cleanly against construct3-chef-sample.
// Adds a new instance variable to the Text objectType (which exists in
// objectTypes/Text.json and instanceTypes.d.ts).  Running this twice on the
// same tmp copy is safe: the second pass skips (all vars already exist).
const VALID_RECIPE = JSON.stringify({
  addInstVars: [
    {
      type: "Text",
      instanceVariables: [{ name: "serverHandlerTest", type: "number" }],
    },
  ],
});

// ── Fake watcher ─────────────────────────────────────────────────────────────
// Handlers under test touch watcher.txId, watcher.bump(), watcher.suppress(fn) and
// watcher.expect(path). suppress alone is NOT the self-write contract (#277): the
// source writes are synchronous, so their fs.watch events land after suppress has
// returned, and only an expect() registered BEFORE the write masks them.
// expectCalls records those registrations; T24 and H1-H5 assert which paths a
// tool registers (and that a no-write path registers none).
// Cast to the SDK type when handing to __setTestWatcher.

interface FakeWatcher {
  txId: number;
  bumped: number;
  suppressCalls: number;
  expectCalls: string[];
  bump(): void;
  suppress<T>(fn: () => Promise<T>): Promise<T>;
  expect(filePath: string): void;
}

function makeFakeWatcher(txId = 0): FakeWatcher {
  return {
    txId,
    bumped: 0,
    suppressCalls: 0,
    expectCalls: [],
    bump() {
      this.txId++;
      this.bumped++;
    },
    async suppress<T>(fn: () => Promise<T>): Promise<T> {
      this.suppressCalls++;
      return fn();
    },
    expect(filePath: string) {
      this.expectCalls.push(filePath);
    },
  };
}

// ── Synthetic extra ───────────────────────────────────────────────────────────
// Handlers only use extra.signal and extra._meta?.progressToken.
// Passing undefined for progressToken means sendProgress is a no-op.

function makeExtra(aborted = false): any {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { signal: ac.signal };
}

// Deterministic mtime control for the checkDerivedFreshness tests below:
// stamps every file under `dir` (recursively) with an explicit mtime, so the
// freshness comparison isn't at the mercy of cpSync/wall-clock ordering.
function setAllMtimesRecursive(dir: string, time: Date): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) setAllMtimesRecursive(full, time);
    else fs.utimesSync(full, time, time);
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("MCP server handler response shaping", () => {
  let tmp: string;
  let watcher: FakeWatcher;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-mcp-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    makeExtractedNewerThanSource(tmp);
    __setProjectRoot(tmp);
    watcher = makeFakeWatcher(5);
    __setTestWatcher(watcher as any);
    __setExtractedDirty(false);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    __resetTestState();
  });

  // ── 1. get-state: correct single-block shape ──────────────────────────────

  it("get-state returns one text block with txId and extractedDirty, no isError", async () => {
    const handler = __getHandler("get-state")!;
    expect(handler).to.exist;

    const result = (await handler({}, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");
    expect(result.content[0].text).to.equal("txId: default:5\nextractedDirty: false");
  });

  // ── 1b. list-projects: reflects the single-entry registry __setProjectRoot
  //       reseeds (#95) ──────────────────────────────────────────────────

  it("list-projects reports the sole registered project as default", async () => {
    const handler = __getHandler("list-projects")!;
    expect(handler).to.exist;

    const result = (await handler({}, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    const text = result.content[0].text as string;
    expect(text).to.match(/^default \(default\)/);
    expect(text).to.include(`root: ${tmp}`);
    expect(text).to.include(`extractedDir: ${path.join(tmp, "extracted")}`);
  });

  // ── 2. stale-warning appended when extractedDirty is true ────────────────
  // Uses read-dsl which routes through paginatedResponse → appendStaleWarning.
  // The fixture has extracted/eventSheets/Gameplay/Event sheet 1.dsl.txt (read-dsl
  // takes a relative path without extension, so the sheet is "Gameplay/Event sheet 1").

  it("read-dsl appends STALE_WARNING when extractedDirty=true, not when false", async () => {
    const handler = __getHandler("read-dsl")!;
    expect(handler).to.exist;

    // With dirty = true
    __setExtractedDirty(true);
    const dirtyResult = (await handler({ sheet: "Gameplay/Event sheet 1" }, makeExtra())) as any;
    expect(dirtyResult.content[0].text).to.include(STALE_WARNING);

    // Reset and try clean
    __setExtractedDirty(false);
    const cleanResult = (await handler({ sheet: "Gameplay/Event sheet 1" }, makeExtra())) as any;
    expect(cleanResult.content[0].text).to.not.include(STALE_WARNING);
  });

  // ── 3. read-dsl single-block pagination contract ─────────────────────────
  // paginatedResponse now delegates to paginatedContent (upstream helper) which
  // collapses the page text and the range footer into ONE content block, joined
  // with "\n\n". The old two-block shape is gone.
  //
  // Fixture: extracted/eventSheets/Gameplay/Event sheet 1.dsl.txt — 38 lines
  // (line 2 is the "# Source: eventSheets/Gameplay/Event sheet 1.json" header).

  it("read-dsl with offset+limit returns single content block with in-block range footer", async () => {
    const handler = __getHandler("read-dsl")!;
    expect(handler).to.exist;

    __setExtractedDirty(false);
    // offset=2, limit=1 → returns line 2 of the DSL file; footer appended in-block.
    const result = (await handler({ sheet: "Gameplay/Event sheet 1", offset: 2, limit: 1 }, makeExtra())) as any;

    // Single block — core contract of #26
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");
    // Range footer is in the same block, after "\n\n"
    expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);

    // Out-of-range page: offset far beyond total lines → footer shows "lines: 0 / <total>"
    // (documents the latent-bug fix: the old two-block code computed a misleading
    //  endLine when returnedLines was 0 — the new upstream helper emits "lines: 0 / N")
    const outOfRange = (await handler({ sheet: "Gameplay/Event sheet 1", offset: 9999, limit: 1 }, makeExtra())) as any;
    expect(outOfRange.content).to.have.length(1);
    expect(outOfRange.content[0].text).to.match(/lines: 0 \/ \d+/);
  });

  // ── 4. apply-recipe txId-rejection ───────────────────────────────────────

  it("apply-recipe rejects mismatched txId before parsing recipe, no watcher bump", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: "{}", txId: "default:4" }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.equal(
      "State changed (expected default:4, got default:5) — re-validate before applying\ntxId: default:5",
    );
    expect(watcher.bumped).to.equal(0);
  });

  // ── 5. apply-recipe caughtError on invalid JSON ───────────────────────────

  it("apply-recipe returns caughtError for invalid JSON, no watcher bump, dirty unchanged", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan; also tests dirty stays true
    const result = (await handler({ recipe: "{ not json", txId: "default:5" }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.match(/^Error:/);
    expect(result.content[0].text).to.include("txId: default:5");
    expect(watcher.bumped).to.equal(0);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 6. apply-recipe success with regenerate:false ─────────────────────────

  it("apply-recipe succeeds (regenerate:false): one block, txId bumped once, no isError", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: "default:5", regenerate: false }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: default:6");
    // R1 (#245): an addInstVars-only apply creates no new file, so no sync-project reminder.
    expect(result.content[0].text).to.not.include("Reminder: run sync-project");
    expect(watcher.bumped).to.equal(1);
    // regenerate:false should NOT clear dirty
    // (dirty was true; test verifies it stays unchanged from this handler's perspective)
  });

  // R6 (#245/#240): the reminder only prints when the apply creates a new file, so the
  // wording guard needs a recipe that creates one (a new objectType).
  it("apply-recipe that creates a file prints the reminder naming sync-project, not sync-c3proj", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const createRecipe = JSON.stringify({ objectTypes: [{ name: "ReminderJson", plugin: "Json" }] });
    const result = (await handler({ recipe: createRecipe, txId: "default:5", regenerate: false }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.include("Reminder: run sync-project");
    // The post-apply reminder reaches MCP callers too, so it must name a command that exists (#240).
    expect(result.content[0].text).to.include("sync-project");
    expect(result.content[0].text).to.not.include("sync-c3proj");
  });

  // R10a/R10b (#249): a files CREATE over an existing sheet is refused on both MCP paths.
  const CREATE_EXISTING_RECIPE = JSON.stringify({
    files: { "eventSheets/Gameplay/Event sheet 1.json": { create: true, events: [] } },
  });

  it("validate-recipe reports a files CREATE over an existing sheet as an error (#249)", async () => {
    const handler = __getHandler("validate-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: CREATE_EXISTING_RECIPE }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    const text = result.content.map((b: any) => b.text).join("\n");
    expect(text).to.include("already exist on disk");
    expect(text).to.include("eventSheets/Gameplay/Event sheet 1.json");
    expect(text).to.include("txId: default:5");
  });

  it("apply-recipe refuses a files CREATE over an existing sheet: error, no bump, sheet untouched (#249)", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    const sheet = path.join(tmp, "eventSheets", "Gameplay", "Event sheet 1.json");
    const before = fs.readFileSync(sheet);

    const result = (await handler(
      { recipe: CREATE_EXISTING_RECIPE, txId: "default:5", regenerate: false },
      makeExtra(),
    )) as any;

    expect(result.isError).to.be.true;
    expect(watcher.bumped).to.equal(0);
    expect(fs.readFileSync(sheet).equals(before)).to.be.true;
    expect(__getExtractedDirty()).to.be.false;
  });

  // R9 (#252): one sheet under two spellings is refused on MCP validate-recipe AND apply-recipe, with the group
  // line byte-identical to the one applyParsed (CLI path) throws.
  it("KI9: validate-recipe and apply-recipe refuse two spellings of one sheet, same group line as applyParsed", async () => {
    const GROUP_LINE =
      'files: 2 keys name the same event sheet eventSheets/Gameplay/Event sheet 1.json — "Gameplay/Event sheet 1", ' +
      '"eventSheets/Gameplay/Event sheet 1.json". Merge their entries under one key.';
    const twoSpellings = JSON.stringify({
      files: {
        "Gameplay/Event sheet 1": [{ op: "insert-event", comment: "FIRST-SPELLING" }],
        "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", comment: "SECOND-SPELLING" }],
      },
    });
    const sheet = path.join(tmp, "eventSheets", "Gameplay", "Event sheet 1.json");
    const before = fs.readFileSync(sheet);

    const validated = (await __getHandler("validate-recipe")!({ recipe: twoSpellings }, makeExtra())) as any;
    const validatedText = validated.content.map((b: any) => b.text).join("\n");
    expect(validated.isError, validatedText).to.be.true;
    expect(validatedText).to.include(GROUP_LINE);
    expect(validatedText).to.include("txId: default:5");

    const applied = (await __getHandler("apply-recipe")!(
      { recipe: twoSpellings, txId: "default:5", regenerate: false },
      makeExtra(),
    )) as any;
    const appliedText = applied.content.map((b: any) => b.text).join("\n");
    expect(applied.isError, appliedText).to.be.true;
    expect(appliedText).to.include(GROUP_LINE);
    expect(appliedText).to.include("txId: default:5");
    expect(watcher.bumped).to.equal(0);
    expect(fs.readFileSync(sheet).equals(before)).to.be.true;
    expect(__getExtractedDirty()).to.be.false;

    // The CLI/library path (applyParsed) throws the same line, byte for byte.
    let libMessage = "";
    try {
      applyParsed(tmp, JSON.parse(twoSpellings), { regenerate: false, log: () => {} });
    } catch (e) {
      libMessage = (e as Error).message;
    }
    expect(libMessage).to.include(GROUP_LINE);
  });

  // #253: a key that matches an existing sheet only when letter case is ignored is refused on both MCP paths with
  // the same text. Host independent: asserts the refusal and the bump count, not whether a case-folding host edits.
  it("KS11: validate-recipe and apply-recipe refuse a miscased key with the same text, no bump", async () => {
    const REFUSAL =
      "recipe path refused: 1 path(s) match an existing file or folder only when letter case is ignored, and a recipe " +
      "path must use the on-disk spelling so it behaves the same on every filesystem. Nothing was written.";
    const miscased = JSON.stringify({
      files: { "gameplay/EVENT SHEET 1": [{ op: "insert-event", comment: "MISCASED" }] },
    });
    const sheet = path.join(tmp, "eventSheets", "Gameplay", "Event sheet 1.json");
    const before = fs.readFileSync(sheet);

    const validated = (await __getHandler("validate-recipe")!({ recipe: miscased }, makeExtra())) as any;
    const validatedText = validated.content.map((b: any) => b.text).join("\n");
    expect(validated.isError, validatedText).to.be.true;
    expect(validatedText).to.include(REFUSAL);

    const applied = (await __getHandler("apply-recipe")!(
      { recipe: miscased, txId: "default:5", regenerate: false },
      makeExtra(),
    )) as any;
    const appliedText = applied.content.map((b: any) => b.text).join("\n");
    expect(applied.isError, appliedText).to.be.true;
    expect(appliedText).to.include(REFUSAL);
    expect(watcher.bumped).to.equal(0);
    expect(fs.readFileSync(sheet).equals(before)).to.be.true;
    expect(__getExtractedDirty()).to.be.false;
  });

  // R2 (#245): a workflow tool routes through applyParsed too; it only edits an existing
  // layout (creates no new file), so no reminder.
  it("clone-replica-to-layouts (workflow) succeeds with no sync-project reminder", async () => {
    const handler = __getHandler("clone-replica-to-layouts")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler(
      {
        templatesLayout: "layouts/Templates Layout.json",
        templateName: "default",
        sourceType: "Sprite3",
        targets: [{ layout: "layouts/UI/Second Layout.json", layer: "layer 1" }],
        txId: "default:5",
        regenerate: false,
      },
      makeExtra(),
    )) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content[0].text).to.include("txId: default:6");
    expect(result.content[0].text).to.not.include("Reminder: run sync-project");
  });

  // ── 7. apply-recipe success (regenerate:true) clears extractedDirty ───────
  // Runs all 6 generators against the tmp fixture copy. Regression guard for the
  // generateSidRegistry dir fix in this commit: before it, this crashed on
  // Windows (ENOENT, doubled path) and silently mis-wrote the registry on POSIX.

  it("apply-recipe success (regenerate:true): clears extractedDirty, txId bumped", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: "default:5" }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: default:6");
    expect(watcher.bumped).to.equal(1);
    // a full regenerate clears the stale flag
    expect(__getExtractedDirty()).to.be.false;
  });

  // R12/R37 (#256): the handler's own full regenerate is the only one, and the D2 wrap adds no failure text.
  it("R12/R37: a create-sheet apply regenerates once and reports no partial-write failure", async () => {
    const handler = __getHandler("apply-recipe")!;
    __setExtractedDirty(true); // skip registry freshness scan
    const recipe = JSON.stringify({ files: { "eventSheets/R12Probe.json": { create: true, events: [] } } });
    const result = (await handler({ recipe, txId: "default:5" }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    const text: string = result.content.map((b: any) => b.text).join("\n");
    const count = (needle: string): number => text.split(needle).length - 1;
    expect(count("--- Regenerating extracted files ---")).to.equal(0);
    expect(count("Generated sid-registry.txt")).to.equal(1);
    expect(count("failed after writing")).to.equal(0);
  });

  describe("a project with no scripts/ (#309)", () => {
    it("SL19: regenerate succeeds, clears extractedDirty and writes tsconfig.json", async () => {
      fs.rmSync(path.join(tmp, "scripts"), { recursive: true, force: true });
      // The fixture copy ships an extracted/tsconfig.json; remove it so the assertion sees this run's write.
      fs.rmSync(path.join(tmp, "extracted", "tsconfig.json"), { force: true });
      __setExtractedDirty(true);
      const handler = __getHandler("regenerate")!;

      const result = (await handler({}, makeExtra())) as any;

      expect({
        isError: result.isError === true,
        dirty: __getExtractedDirty(),
        tsconfig: fs.existsSync(path.join(tmp, "extracted", "tsconfig.json")),
        text: result.isError === true ? result.content?.[0]?.text : undefined,
      }).to.deep.equal({ isError: false, dirty: false, tsconfig: true, text: undefined });
    });

    it("SL20: apply-recipe with objectTypes succeeds, writes the objectType and clears extractedDirty", async () => {
      fs.rmSync(path.join(tmp, "scripts"), { recursive: true, force: true });
      __setExtractedDirty(true); // skip registry freshness scan
      const handler = __getHandler("apply-recipe")!;
      const recipe = JSON.stringify({ objectTypes: [{ name: "ProbeJ", plugin: "Json" }] });

      const result = (await handler({ recipe, txId: "default:5" }, makeExtra())) as any;

      expect({
        isError: result.isError === true,
        probeJ: fs.existsSync(path.join(tmp, "objectTypes", "ProbeJ.json")),
        dirty: __getExtractedDirty(),
        text: result.isError === true ? result.content?.[0]?.text : undefined,
      }).to.deep.equal({ isError: false, probeJ: true, dirty: false, text: undefined });
    });
  });

  // ── 8. list-event-sheets pagination ──────────────────────────────────────
  // Fixture has 2 real event sheet entries under eventSheets/ (sorted):
  //   Event sheet 1.json, Event sheet 2.json
  // Editor-local exclusion here is an UPSTREAM c3source contract, not a
  // chef-side filter: the handler calls PROJECT.findAllEventSheets(), which
  // routes through c3source's find_all_eventsheets_path, which applies
  // isEditorLocalPath internally. There is nothing in this repo to revert, so
  // K1-K3 below cannot be driven red by reverting a local change — see the
  // three-part anti-vacuity comment above those tests for what substitutes.
  // These are live filesystem reads — no stale warning even when dirty.

  describe("list-event-sheets", () => {
    it("no-params: one block, contains known fixture entry", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      // Sorted first entry in the fixture
      expect(result.content[0].text).to.include("Event sheet 1.json");
    });

    it("offset/limit: single block with in-block range footer", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      const result = (await handler({ offset: 1, limit: 1 }, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);
    });

    it("no stale warning even when extractedDirty=true", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      __setExtractedDirty(true);
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.not.include(STALE_WARNING);
    });

    // K1-K3: one test per EDITOR_LOCAL_EXCLUSIONS dimension (fileSuffixes,
    // dirs, exactNames — ADR 0016 precedent, see includeTree.test.ts for the
    // same three-dimension split), each replacing the single vacuous test
    // that used to live here. The canonical construct3-sample fixture tracks
    // ZERO *.uistate.json/uistate/ files at every tag (verify-fixture-parity.mjs),
    // so a bare `not.include` against the pristine fixture passes without
    // exercising anything — and since the filter is c3source's, not chef's,
    // there is no local hunk to revert for a genuine red (see the describe-
    // level comment above). Each test below is therefore a THREE-part device:
    //   (i)   an UNFILTERED baseline walk of the same tmp dir proves the
    //         seeded editor-local file and the seeded real file both landed
    //         and are reachable — kills a typo'd/misplaced seed.
    //   (iii) a seeded REAL file (`Seeded Real.json`) proves the handler is
    //         actually reading `tmp` (via __setProjectRoot) and not silently
    //         falling back to the pristine fixture — if __setProjectRoot ever
    //         stopped reassigning PROJECT, the handler would still list the
    //         fixture's 2 real sheets and a bare not.include would still pass.
    //   (ii)  the exclusion count is DERIVED (`baseline.length - 1`), never a
    //         hardcoded literal, so the assertion survives a construct3-sample
    //         pin bump that adds a real sheet to the fixture.
    it("K1 fileSuffixes: excludes an *.uistate.json sibling, includes all real sheets", async () => {
      const esDir = path.join(tmp, "eventSheets");
      fs.writeFileSync(path.join(esDir, "Seeded Real.json"), JSON.stringify({ events: [] }));
      fs.writeFileSync(path.join(esDir, "Event sheet 1.uistate.json"), JSON.stringify({ events: [] }));

      const baseline = walkFiles(esDir, ".json").map((p) => toPosixPath(path.relative(esDir, p)));
      expect(baseline).to.include("Event sheet 1.uistate.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-event-sheets")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("Event sheet 1.uistate.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("K2 dirs: excludes a uistate/ subfolder file, includes all real sheets", async () => {
      const esDir = path.join(tmp, "eventSheets");
      fs.writeFileSync(path.join(esDir, "Seeded Real.json"), JSON.stringify({ events: [] }));
      fs.mkdirSync(path.join(esDir, "uistate"), { recursive: true });
      fs.writeFileSync(path.join(esDir, "uistate", "Hidden.json"), JSON.stringify({ events: [] }));

      const baseline = walkFiles(esDir, ".json").map((p) => toPosixPath(path.relative(esDir, p)));
      expect(baseline).to.include("uistate/Hidden.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-event-sheets")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("uistate/Hidden.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("K3 exactNames: excludes the editor-owned tsconfig.json, includes all real sheets", async () => {
      const esDir = path.join(tmp, "eventSheets");
      fs.writeFileSync(path.join(esDir, "Seeded Real.json"), JSON.stringify({ events: [] }));
      fs.writeFileSync(path.join(esDir, "tsconfig.json"), JSON.stringify({}));

      const baseline = walkFiles(esDir, ".json").map((p) => toPosixPath(path.relative(esDir, p)));
      expect(baseline).to.include("tsconfig.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-event-sheets")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("tsconfig.json");
      expect(lines).to.have.length(baseline.length - 1);
    });
  });

  // ── 9. list-layouts pagination ────────────────────────────────────────────
  // Fixture has 3 real layout entries under layouts/ (sorted):
  //   Main Layout.json, Second Layout.json, Templates Layout.json
  // Editor-local exclusion here is an UPSTREAM c3source contract, not a
  // chef-side filter: the handler calls PROJECT.findAllLayouts(), which
  // routes through c3source's find_all_layouts_path, which applies
  // isEditorLocalPath internally. There is nothing in this repo to revert, so
  // L1-L3 below cannot be driven red by reverting a local change — the same
  // three-part anti-vacuity device documented above list-event-sheets' K1-K3
  // applies here, with ONE difference worth stating explicitly: the baseline
  // walk below uses `walkFiles(layoutsDir, () => true)` with NO `.json`
  // predicate, because find_all_layouts_path itself carries no `.json`
  // filter (only !isEditorLocalPath) — unlike find_all_eventsheets_path. A
  // `.json`-filtered baseline here would make the derived exclusion count
  // wrong.
  // These are live filesystem reads — no stale warning even when dirty.

  describe("list-layouts", () => {
    it("no-params: one block, contains known fixture entry", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      // Sorted first entry in the fixture
      expect(result.content[0].text).to.include("Main Layout.json");
    });

    it("offset/limit: single block with in-block range footer", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      const result = (await handler({ offset: 1, limit: 1 }, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);
    });

    it("no stale warning even when extractedDirty=true", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      __setExtractedDirty(true);
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.not.include(STALE_WARNING);
    });

    // L1-L3: the list-event-sheets K1-K3 device, replayed against list-layouts.
    // See the describe-level comment above for why no genuine red is possible
    // here and why the baseline predicate differs (no `.json` filter).
    it("L1 fileSuffixes: excludes an *.uistate.json sibling, includes all real layouts", async () => {
      const layoutsDir = path.join(tmp, "layouts");
      fs.writeFileSync(path.join(layoutsDir, "Seeded Real.json"), JSON.stringify({ layers: [] }));
      fs.writeFileSync(path.join(layoutsDir, "Main Layout.uistate.json"), JSON.stringify({ layers: [] }));

      const baseline = walkFiles(layoutsDir, () => true).map((p) => toPosixPath(path.relative(layoutsDir, p)));
      expect(baseline).to.include("Main Layout.uistate.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-layouts")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("Main Layout.uistate.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("L2 dirs: excludes a uistate/ subfolder file, includes all real layouts", async () => {
      const layoutsDir = path.join(tmp, "layouts");
      fs.writeFileSync(path.join(layoutsDir, "Seeded Real.json"), JSON.stringify({ layers: [] }));
      fs.mkdirSync(path.join(layoutsDir, "uistate"), { recursive: true });
      fs.writeFileSync(path.join(layoutsDir, "uistate", "Hidden.json"), JSON.stringify({ layers: [] }));

      const baseline = walkFiles(layoutsDir, () => true).map((p) => toPosixPath(path.relative(layoutsDir, p)));
      expect(baseline).to.include("uistate/Hidden.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-layouts")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("uistate/Hidden.json");
      expect(lines).to.have.length(baseline.length - 1);
    });

    it("L3 exactNames: excludes the editor-owned tsconfig.json, includes all real layouts", async () => {
      const layoutsDir = path.join(tmp, "layouts");
      fs.writeFileSync(path.join(layoutsDir, "Seeded Real.json"), JSON.stringify({ layers: [] }));
      fs.writeFileSync(path.join(layoutsDir, "tsconfig.json"), JSON.stringify({}));

      const baseline = walkFiles(layoutsDir, () => true).map((p) => toPosixPath(path.relative(layoutsDir, p)));
      expect(baseline).to.include("tsconfig.json");
      expect(baseline).to.include("Seeded Real.json");

      const handler = __getHandler("list-layouts")!;
      const result = (await handler({}, makeExtra())) as any;
      const lines: string[] = result.content[0].text.split("\n");

      expect(lines).to.include("Seeded Real.json");
      expect(lines).to.not.include("tsconfig.json");
      expect(lines).to.have.length(baseline.length - 1);
    });
  });

  // ── 10. apply-recipe CancelledError after source write ────────────────────
  // Aborted signal causes checkCancelled() to throw inside runGenerators AFTER
  // applyParsed has already written source files.

  // ── 11. navigation-graph ──────────────────────────────────────────────────
  // Fixture has two nav entries:
  //   Event sheet 1 → Second Layout  (line 38 in Gameplay/Event sheet 1.dsl.txt)
  //   Event sheet 2 → Main Layout    (line 11 in UI/Event sheet 2.dsl.txt)

  describe("navigation-graph", () => {
    it("default (table): one block, contains header and fixture nav entries", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      const text: string = result.content[0].text;
      expect(text).to.include("From EventSheet");
      expect(text).to.include("Event sheet 1");
      expect(text).to.include("Second Layout");
    });

    it("format 'plantuml': one block, contains @startuml/@enduml/-->", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      const result = (await handler({ format: "plantuml" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      const text: string = result.content[0].text;
      expect(text).to.include("@startuml");
      expect(text).to.include("@enduml");
      expect(text).to.include("-->");
    });

    it("stale warning: appended when extractedDirty=true, absent when false", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      __setExtractedDirty(true);
      const dirtyResult = (await handler({}, makeExtra())) as any;
      expect(dirtyResult.content[0].text).to.include(STALE_WARNING);

      __setExtractedDirty(false);
      const cleanResult = (await handler({}, makeExtra())) as any;
      expect(cleanResult.content[0].text).to.not.include(STALE_WARNING);
    });

    it("pagination footer: offset/limit yields single block with in-block range footer", async () => {
      const handler = __getHandler("navigation-graph")!;
      expect(handler).to.exist;

      const result = (await handler({ offset: 0, limit: 1 }, makeExtra())) as any;

      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      expect(result.content[0].text).to.include("lines: ");
    });
  });

  // ── 12. scan-addon-usage txId footer on a behavior scan ──────────────────
  // Fixture carries the MyCompany_MyBehavior behavior addon
  // (addons/behavior/MyCompany_MyBehavior), instantiated on Sprite2/9patch —
  // a read-only tool, so no watcher.bump() and the response carries the
  // CURRENT txId (5, from makeFakeWatcher(5) in beforeEach).

  describe("scan-addon-usage (behavior addon)", () => {
    it("behavior scan response carries the txId footer, no bump, single block", async () => {
      const handler = __getHandler("scan-addon-usage")!;
      expect(handler).to.exist;

      const result = (await handler({ addon: "MyCompany_MyBehavior" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].type).to.equal("text");
      const text: string = result.content[0].text;
      expect(text).to.match(/\ntxId: default:5$/);
      expect(text).to.include("Sprite2 [MyCustomBehavior]");
      expect(text).to.include("9patch [MyCustomBehavior]");
      expect(watcher.bumped).to.equal(0);
    });
  });

  it("apply-recipe with aborted signal: isError, Cancelled text, txId bumped, dirty=true", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    const result = (await handler({ recipe: VALID_RECIPE }, makeExtra(true))) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("Cancelled");
    expect(result.content[0].text).to.match(/\ntxId: default:6$/);
    expect(watcher.bumped).to.equal(1);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 13. preview-addon-metadata-sync / sync-addon-metadata (F2) ────────────
  // sync-addon-metadata is the FIRST MUTATE tool in the addon surface — every
  // other addon tool (read-addon, validate-addons, list-addons, diff-addon-aces,
  // scan-addon-usage) is READ_ONLY. `tmp` (the mkdtempSync fixture copy set up
  // in the outer beforeEach) is used directly by these tests, exactly like the
  // apply-recipe MUTATE tests above — never the tracked fixture itself.

  describe("addon-metadata-sync MCP tools", () => {
    // MyCompany_MyBehavior's addon.json (version 1.0.0.0, author Scirra) matches
    // the PRISTINE fixture's usedAddons entry exactly (see
    // test/c3/addonMetadataSync.test.ts's makeSeededProject) — seeding this drift
    // and then successfully applying manifest-from-package must reproduce
    // project.c3proj byte-for-byte against FIXTURE_DIR's pristine copy.
    function seedDrift(): void {
      seedManifestDrift(FIXTURE_DIR, tmp, [{ id: "MyCompany_MyBehavior", version: "0.9.0.0", author: "Nobody" }]);
    }

    it("T2: direction is a required (non-optional) z.enum on both tools — the schema rejects a missing/invalid value before either handler body runs", () => {
      for (const name of ["preview-addon-metadata-sync", "sync-addon-metadata"]) {
        const config = __getToolConfig(name);
        expect(config, `${name} should be registered`).to.exist;
        const schema = z.object(config!.inputSchema as Record<string, z.ZodTypeAny>);

        expect(schema.safeParse({}).success, `${name}: missing direction should be rejected`).to.equal(false);
        expect(
          schema.safeParse({ direction: "bogus" }).success,
          `${name}: invalid direction should be rejected`,
        ).to.equal(false);
        expect(
          schema.safeParse({ direction: "manifest-from-package" }).success,
          `${name}: a valid direction should be accepted`,
        ).to.equal(true);
      }
      expect(watcher.bumped).to.equal(0);
    });

    it("T20: validate-addons and list-addons keep READ_ONLY annotations and byte-identical output; neither module imports addonMetadataSync", async () => {
      expect(__getToolConfig("validate-addons")!.annotations).to.deep.equal(READ_ONLY);
      expect(__getToolConfig("list-addons")!.annotations).to.deep.equal(READ_ONLY);

      const validateHandler = __getHandler("validate-addons")!;
      const validateResult = (await validateHandler({}, makeExtra())) as any;
      expect(validateResult.content[0].text).to.equal(`${formatAddonValidation(validateAddons(tmp))}\ntxId: default:5`);

      const listHandler = __getHandler("list-addons")!;
      const listResult = (await listHandler({}, makeExtra())) as any;
      expect(listResult.content[0].text).to.equal(`${formatAddonInventory(listAddons(tmp))}\ntxId: default:5`);

      // A prose cross-reference to addonMetadataSync.ts (its module doc comment
      // names the sibling module by design — see the "Duality note" above
      // checkMetadataMismatch) is fine; an actual `import ... from
      // "./addonMetadataSync.js"` is the regression this guards against.
      for (const modulePath of ["src/c3/addonValidator.ts", "src/c3/addonInventory.ts"]) {
        const source = fs.readFileSync(path.resolve(modulePath), "utf-8");
        expect(source, `${modulePath} should not import addonMetadataSync`).to.not.match(
          /from\s+["']\.\/addonMetadataSync\.js["']/,
        );
      }
    });

    it("T21: sync-addon-metadata rejects a stale txId BEFORE any write, does not bump, response carries txId", async () => {
      seedDrift();
      const manifestPath = path.join(tmp, "project.c3proj");
      const before = fs.readFileSync(manifestPath);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: "default:4" }, makeExtra())) as any;

      expect(result.isError).to.be.true;
      expect(result.content).to.have.length(1);
      expect(result.content[0].text).to.equal(
        "State changed (expected default:4, got default:5) — re-validate before syncing\ntxId: default:5",
      );
      expect(watcher.bumped).to.equal(0);
      expect(fs.readFileSync(manifestPath).equals(before), "manifest bytes must be unchanged").to.equal(true);
    });

    it("T22: a successful apply writes exactly one content block with a txId footer, bumps exactly once, and leaves extractedDirty unchanged", async () => {
      seedDrift();
      expect(__getExtractedDirty()).to.equal(false);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: "default:5" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].text).to.include("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.equal(false);

      const written = fs.readFileSync(path.join(tmp, "project.c3proj"));
      const pristine = fs.readFileSync(path.join(FIXTURE_DIR, "project.c3proj"));
      expect(written.equals(pristine), "restored manifest should equal the pristine fixture byte-for-byte").to.equal(
        true,
      );
    });

    it("T23: preview, a package-from-manifest sync, and a no-drift apply never call bump(); extractedDirty stays unchanged", async () => {
      // Deliberately NOT seeded — the pristine fixture has no drift, so a
      // manifest-from-package apply here is the no-write branch.
      const previewHandler = __getHandler("preview-addon-metadata-sync")!;
      const previewResult = (await previewHandler({ direction: "manifest-from-package" }, makeExtra())) as any;
      expect(previewResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      const syncHandler = __getHandler("sync-addon-metadata")!;

      const packageFromManifestResult = (await syncHandler(
        { direction: "package-from-manifest", txId: `default:${watcher.txId}` },
        makeExtra(),
      )) as any;
      expect(packageFromManifestResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      const noDriftResult = (await syncHandler(
        { direction: "manifest-from-package", txId: `default:${watcher.txId}` },
        makeExtra(),
      )) as any;
      expect(noDriftResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      expect(__getExtractedDirty()).to.equal(false);
    });

    it("T24 (H1): the manifest write happens INSIDE watcher.suppress, and project.c3proj is registered via watcher.expect BEFORE the write", async () => {
      seedDrift();
      const manifestPath = path.join(tmp, "project.c3proj");
      const manifestBefore = fs.readFileSync(manifestPath);

      let changedDuringSuppress = false;
      let manifestUnchangedAtFirstExpect: boolean | undefined;
      const trackingWatcher = makeFakeWatcher(5);
      const recordExpect = trackingWatcher.expect.bind(trackingWatcher);
      trackingWatcher.expect = (filePath: string): void => {
        manifestUnchangedAtFirstExpect ??= fs.readFileSync(manifestPath).equals(manifestBefore);
        recordExpect(filePath);
      };
      trackingWatcher.suppress = async <T>(fn: () => Promise<T>): Promise<T> => {
        trackingWatcher.suppressCalls++;
        const before = fs.readFileSync(manifestPath);
        const result = await fn();
        const after = fs.readFileSync(manifestPath);
        changedDuringSuppress = !before.equals(after);
        return result;
      };
      __setTestWatcher(trackingWatcher as any);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: "default:5" }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(trackingWatcher.suppressCalls).to.equal(1);
      expect(changedDuringSuppress, "the manifest write should happen inside the suppress window").to.equal(true);
      // Unique: the tracker's end-of-call refresh re-registers each path.
      expect([...new Set(trackingWatcher.expectCalls)]).to.deep.equal([manifestPath]);
      expect(manifestUnchangedAtFirstExpect, "expect() must run before the manifest write").to.equal(true);
    });

    it("H2: a no-write sync-addon-metadata apply (no drift) registers nothing via watcher.expect", async () => {
      // Pristine fixture: no drift, so manifest-from-package is the no-write branch (T23's setup).
      const result = (await __getHandler("sync-addon-metadata")!(
        { direction: "manifest-from-package", txId: `default:${watcher.txId}` },
        makeExtra(),
      )) as any;
      expect(result.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);
      expect(watcher.expectCalls).to.deep.equal([]);
    });

    it("T25: MCP response text equals formatAddonMetadataSync's direct render of the same result — both surfaces route through the shared formatter", async () => {
      seedDrift();

      const previewHandler = __getHandler("preview-addon-metadata-sync")!;
      const previewResult = (await previewHandler({ direction: "manifest-from-package" }, makeExtra())) as any;

      const expected = syncAddonMetadata(tmp, { direction: "manifest-from-package", dryRun: true });
      expect("error" in expected, "expected a success result").to.equal(false);
      expect(previewResult.content[0].text).to.equal(
        `${formatAddonMetadataSync(expected as AddonSyncResult)}\ntxId: default:5`,
      );

      // Both tools must render via the shared formatter — not hand-built strings.
      const serverSource = fs.readFileSync(path.resolve("src/mcp/server.ts"), "utf-8");
      const callCount = (serverSource.match(/formatAddonMetadataSync\(/g) ?? []).length;
      expect(callCount, "both tools should call formatAddonMetadataSync").to.be.at.least(2);
    });
  });

  // ── 14. checkDerivedFreshness excludes editor-local paths (ADR 0018 site 2) ─
  // generate-sids is the only handler whose response surfaces the effect of
  // checkDerivedFreshness's own scan directly (via appendStaleWarning), rather
  // than a stale flag set earlier by something else — so it's the right probe.
  // Mtimes are set explicitly (utimesSync) on every real source file plus the
  // registry, never relying on wall-clock/cpSync ordering.

  describe("checkDerivedFreshness (generate-sids probe)", () => {
    const BASELINE = new Date(2020, 0, 1);
    const NEWER = new Date(BASELINE.getTime() + 100_000);

    function pinBaseline(): void {
      for (const dir of SID_SOURCE_DIRS) {
        setAllMtimesRecursive(path.join(tmp, dir), BASELINE);
      }
      fs.utimesSync(path.join(tmp, "extracted", "sid-registry.txt"), BASELINE, BASELINE);
    }

    it("a newer *.uistate.json sibling under layouts/ does NOT set extractedDirty or bump", async () => {
      pinBaseline();
      const uistatePath = path.join(tmp, "layouts", "Main Layout.uistate.json");
      fs.writeFileSync(uistatePath, "{}");
      fs.utimesSync(uistatePath, NEWER, NEWER);

      const handler = __getHandler("generate-sids")!;
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.not.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(false);
      expect(watcher.bumped).to.equal(0);
    });

    it("positive control: a newer REAL layouts/*.json file DOES set extractedDirty and bump", async () => {
      pinBaseline();
      const layoutPath = path.join(tmp, "layouts", "Gameplay", "Main Layout.json");
      fs.utimesSync(layoutPath, NEWER, NEWER);

      const handler = __getHandler("generate-sids")!;
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(true);
      expect(watcher.bumped).to.equal(1);
    });
  });

  describe("derived freshness on read tools (#256)", () => {
    const BASELINE = new Date(2020, 0, 1);
    const NEWER = new Date(BASELINE.getTime() + 100_000);
    const TOOLS: ReadonlyArray<{ tool: string; file: string }> = [
      { tool: "read-sid-registry", file: "sid-registry.txt" },
      { tool: "read-template-scope", file: "template-scope.txt" },
      { tool: "list-global-layers", file: "global-layers.txt" },
    ];

    // Pin every source file and every extracted/ artifact to BASELINE.
    function pinBaseline(): void {
      for (const dir of SID_SOURCE_DIRS) {
        setAllMtimesRecursive(path.join(tmp, dir), BASELINE);
      }
      setAllMtimesRecursive(path.join(tmp, "extracted"), BASELINE);
    }

    async function call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
      const handler = __getHandler(tool)!;
      expect(handler, `handler ${tool}`).to.exist;
      const result = (await handler(args, makeExtra())) as any;
      return result.content[0].text as string;
    }

    for (const { tool, file } of TOOLS) {
      it(`R9 ${tool}: a newer real layout makes ${file} stale (warning, dirty, bumped 1)`, async () => {
        pinBaseline();
        expect(__getExtractedDirty()).to.equal(false);
        expect(watcher.bumped).to.equal(0);
        const layoutPath = path.join(tmp, "layouts", "Gameplay", "Main Layout.json");
        fs.utimesSync(layoutPath, NEWER, NEWER);

        const text = await call(tool);

        expect(text).to.include(STALE_WARNING);
        expect(__getExtractedDirty()).to.equal(true);
        expect(watcher.bumped).to.equal(1);
      });
    }

    it("R9 read-dsl (positive control): a newer sheet makes its DSL stale (warning, dirty, bumped 1)", async () => {
      pinBaseline();
      const sheetPath = path.join(tmp, "eventSheets", "Gameplay", "Event sheet 1.json");
      fs.utimesSync(sheetPath, NEWER, NEWER);

      const text = await call("read-dsl", { sheet: "Gameplay/Event sheet 1" });

      expect(text).to.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(true);
      expect(watcher.bumped).to.equal(1);
    });

    for (const { tool, file } of TOOLS) {
      it(`R9n ${tool}: a newer uistate sibling leaves ${file} fresh (no warning, bumped 0)`, async () => {
        pinBaseline();
        const uistatePath = path.join(tmp, "layouts", "Main Layout.uistate.json");
        fs.writeFileSync(uistatePath, "{}");
        fs.utimesSync(uistatePath, NEWER, NEWER);

        const text = await call(tool);

        expect(text).to.not.include(STALE_WARNING);
        expect(__getExtractedDirty()).to.equal(false);
        expect(watcher.bumped).to.equal(0);
      });
    }

    it("R9i read-template-scope: calling twice on a stale source leaves bumped at 1", async () => {
      pinBaseline();
      fs.utimesSync(path.join(tmp, "layouts", "Gameplay", "Main Layout.json"), NEWER, NEWER);

      await call("read-template-scope");
      const second = await call("read-template-scope");

      expect(second).to.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(true);
      expect(watcher.bumped).to.equal(1);
    });

    for (const { tool, file } of TOOLS) {
      it(`R10 ${tool}: nothing newer than ${file} gives no warning and bumped 0`, async () => {
        pinBaseline();

        const text = await call(tool);

        expect(text).to.not.include(STALE_WARNING);
        expect(__getExtractedDirty()).to.equal(false);
        expect(watcher.bumped).to.equal(0);
      });
    }
  });

  describe("read-tool argument containment (#275)", () => {
    const BASELINE = new Date(2020, 0, 1);
    const NEWER = new Date(BASELINE.getTime() + 100_000);
    const SHEET_MSG = "Invalid sheet path '../escape' — must stay within eventSheets/";
    const LAYOUT_MSG = "Invalid layout path '../escape' — must stay within layouts/";
    const SHEET = "Gameplay/Event sheet 1";
    const LAYOUT = "Gameplay/Main Layout";
    const SHEET_TOOLS: ReadonlyArray<{ tool: string; extra: Record<string, unknown>; notFound: string }> = [
      { tool: "read-dsl", extra: {}, notFound: "No DSL file found" },
      { tool: "read-dsl-index", extra: {}, notFound: "No DSL index file found" },
      { tool: "read-event-sids", extra: {}, notFound: "No event sheet found" },
      { tool: "read-scripts", extra: {}, notFound: "No extracted TypeScript found" },
      { tool: "resolve-anchor", extra: { by: "line", value: "1" }, notFound: "No DSL index file found" },
    ];

    async function callFull(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const handler = __getHandler(tool)!;
      expect(handler, `handler ${tool}`).to.exist;
      const result = (await handler(args, makeExtra())) as any;
      return { text: result.content[0].text as string, isError: result.isError === true };
    }

    // Source at <tmp>/escape.json (newer) plus every escaped extracted artifact a tool could stat.
    function seedEscapedPair(): void {
      const sheetJson = fs.readFileSync(path.join(tmp, "eventSheets", "Gameplay", "Event sheet 1.json"), "utf-8");
      fs.writeFileSync(path.join(tmp, "escape.json"), sheetJson);
      for (const f of ["escape.dsl.txt", "escape.dsl.idx.txt", "escape.ts", "escape.layout.txt"]) {
        fs.writeFileSync(path.join(tmp, "extracted", f), "x\n");
      }
      setAllMtimesRecursive(path.join(tmp, "extracted"), BASELINE);
      fs.utimesSync(path.join(tmp, "escape.json"), NEWER, NEWER);
    }

    for (const { tool, extra } of SHEET_TOOLS) {
      it(`RA1 ${tool}: '../escape' is refused with no txId move and no dirty flag`, async () => {
        seedEscapedPair();
        const { text } = await callFull(tool, { sheet: "../escape", ...extra });
        // One deep-equal so a regression reports the refusal and the txId/dirty side effects together.
        expect({
          refused: text.includes(SHEET_MSG),
          bumped: watcher.bumped,
          dirty: __getExtractedDirty(),
        }).to.deep.equal({ refused: true, bumped: 0, dirty: false });
      });
    }

    it("RA1 read-layout: '../escape' is refused with no txId move and no dirty flag", async () => {
      seedEscapedPair();
      const { text } = await callFull("read-layout", { layout: "../escape" });
      expect({
        refused: text.includes(LAYOUT_MSG),
        bumped: watcher.bumped,
        dirty: __getExtractedDirty(),
      }).to.deep.equal({ refused: true, bumped: 0, dirty: false });
    });

    it("RA2 read-event-sids: a valid sheet JSON outside eventSheets/ is not probed or returned", async () => {
      seedEscapedPair();
      const { text } = await callFull("read-event-sids", { sheet: "../escape" });
      expect(text).to.include(SHEET_MSG);
      expect(text).to.not.include("No event sheet found");
      expect(text).to.not.include("Event SID Map");
    });

    it("RA3 positive control: every tool still reads a real sheet or layout by relative name", async () => {
      fs.writeFileSync(path.join(tmp, "extracted", "eventSheets", "Gameplay", "Event sheet 1.ts"), "// ts\n");
      for (const { tool, extra } of SHEET_TOOLS) {
        const { text, isError } = await callFull(tool, { sheet: SHEET, ...extra });
        expect(isError, `${tool}: ${text}`).to.equal(false);
        expect(text, tool).to.not.include("must stay within");
      }
      const layout = await callFull("read-layout", { layout: LAYOUT });
      expect(layout.isError, layout.text).to.equal(false);
      expect(layout.text).to.not.include("must stay within");
    });

    for (const bad of ["", "."]) {
      for (const { tool, extra, notFound } of SHEET_TOOLS) {
        it(`RA4 ${tool}: sheet ${JSON.stringify(bad)} gets the not-found message, not containment`, async () => {
          const { text } = await callFull(tool, { sheet: bad, ...extra });
          expect(text).to.include(notFound);
          expect(text).to.not.include("must stay within");
        });
      }
      it(`RA4 read-layout: layout ${JSON.stringify(bad)} gets the not-found message, not containment`, async () => {
        const { text } = await callFull("read-layout", { layout: bad });
        expect(text).to.include("No layout summary found");
        expect(text).to.not.include("must stay within");
      });
    }
  });

  // ── 15. [strays] detection-only report at the MCP surfaces (#177) ───────────
  // KNOWN-RED at the commit that introduces these two rows: nothing in
  // `server.ts` emits a `[strays]` line until the wiring task lands. Their red
  // state is the structural revert-confirm that the wiring is load-bearing.
  //
  // Both rows re-point PROJECT_ROOT at their OWN synthetic temp-dir project
  // rather than the fixture copy the outer beforeEach seeds: `detectStrayFiles`
  // returns `[]` on `construct3-chef-sample` and `verify-fixture-parity.mjs`
  // forbids adding a stray there, so a fixture-based assertion here would pass
  // vacuously (the #149/#175 shape). The reporter-behaviour rows live in
  // `test/c3/strayFileReport.test.ts`; these two exist only for the MCP wiring.

  describe("[strays] report (#177)", () => {
    let strayRoot: string;

    /**
     * A shape-valid, in-sync project. Two traps encoded here: each section's
     * `items` is a `string[]` of BARE NAMES (not objects carrying a `sid`), and
     * the `rootFileFolders` key for the general file folder is `general`, NOT
     * `file`. Getting either wrong throws `Could not parse … as JSON` out of
     * `readProjectManifest` — a seeding failure, not the missing-`[strays]`-line
     * failure these rows are meant to produce.
     */
    function seedStrayProject(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-strays-"));
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
      fs.writeFileSync(path.join(root, "project.c3proj"), JSON.stringify(manifest, undefined, "\t"));
      fs.mkdirSync(path.join(root, "layouts"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "layouts", "MainLayout.json"),
        JSON.stringify({ name: "MainLayout", layers: [] }, null, "\t"),
      );
      fs.writeFileSync(path.join(root, "layouts", "notes.txt"), "a stray note\n");
      return root;
    }

    function strayLinesOf(text: string): string[] {
      return text.split("\n").filter((l) => l.startsWith("[strays]"));
    }

    /**
     * Mirrors `seedStrayProject()`, but `project.c3proj` is the literal
     * `{ NOT JSON` — unparseable — so `runSync`'s top-of-function
     * `readProjectManifest` throws. Seeds TWO stray files under `layouts/`
     * (not one) so T13's order assertion below is meaningful. Callers own
     * cleanup: this does not participate in the `strayRoot`/`afterEach` pair
     * above, since T12/T13 need a distinct root from the shape-valid seed the
     * other rows in this block use.
     */
    function seedUnparseableStrayProject(): string {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-strays-unparseable-"));
      fs.mkdirSync(path.join(root, "layouts"), { recursive: true });
      fs.writeFileSync(path.join(root, "project.c3proj"), "{ NOT JSON");
      fs.writeFileSync(path.join(root, "layouts", "notes.txt"), "a stray note\n");
      fs.writeFileSync(path.join(root, "layouts", "scratch.txt"), "another stray note\n");
      return root;
    }

    beforeEach(() => {
      strayRoot = seedStrayProject();
      __setProjectRoot(strayRoot);
    });

    afterEach(() => {
      fs.rmSync(strayRoot, { recursive: true, force: true });
    });

    it("R2: scaffold-layout emits no [strays] lines, while validate-project on the same project does", async () => {
      const scaffold = __getHandler("scaffold-layout")!;
      expect(scaffold).to.exist;

      // scaffold-layout needs the SID registry (#316).
      fs.mkdirSync(path.join(strayRoot, "extracted"), { recursive: true });
      fs.writeFileSync(path.join(strayRoot, "extracted", "sid-registry.txt"), "");

      const scaffolded = (await scaffold(
        {
          source: "MainLayout.json",
          name: "ClonedLayout",
          path: "ClonedLayout.json",
          eventSheet: "MainEvents",
          regenerate: false,
        },
        makeExtra(),
      )) as any;

      // The scaffold must actually SUCCEED — an error response would contain no
      // `[strays]` line for the wrong reason, making the assertion below vacuous.
      expect(scaffolded.isError, scaffolded.content[0].text).to.be.undefined;
      expect(strayLinesOf(scaffolded.content[0].text)).to.deep.equal([]);

      // Positive control on the SAME project: validate-project does report it,
      // so the absence above is a deliberate scope boundary and not an artifact
      // of the seed carrying no stray at all.
      const validate = __getHandler("validate-project")!;
      const validated = (await validate({}, makeExtra())) as any;
      expect(validated.content[0].text).to.include("! layouts/notes.txt");
    });

    it("R15: the MCP validate-project block's [strays] lines are byte-identical to the reporter's", async () => {
      fs.writeFileSync(path.join(strayRoot, "layouts", "another.md"), "# also stray\n");

      const expected: string[] = [];
      reportStrayFiles(strayRoot, (m) => expected.push(m));
      expect(expected.length, "seed must produce at least two stray rows for order to be meaningful").to.be.at.least(2);

      const validate = __getHandler("validate-project")!;
      const validated = (await validate({}, makeExtra())) as any;

      // Order included — the CLI and MCP surfaces render through the same
      // reporter, so their `[strays]` output must not drift.
      expect(strayLinesOf(validated.content[0].text)).to.deep.equal(expected);
    });

    it("R16: both tools that emit [strays] lines document the report in their description", () => {
      for (const name of ["validate-project", "sync-project"]) {
        const config = __getToolConfig(name);
        expect(config, `${name} should be registered`).to.exist;
        expect(config!.description, `${name} description should mention the stray report`).to.match(/stray/i);
      }
    });

    it("T17: MCP validate-project gains no stray-gating input", () => {
      // Exit-code gating is CLI-only (--fail-on-strays); MCP reports findings in
      // the text block and reserves isError for genuine tool failure (ADR 0025
      // decision 4), so validate-project's inputSchema must stay free of any
      // stray-gating key. The sync-project/txId assertion below is a MANDATORY
      // positive control: without it, the zero-hit check on validate-project
      // would pass just as happily if __getToolConfig returned undefined, an
      // empty object, or the wrong tool entirely — the vacuous-negative shape
      // this repo has shipped twice.
      const validateConfig = __getToolConfig("validate-project");
      expect(validateConfig, "validate-project should be registered").to.exist;
      const validateKeys = Object.keys(validateConfig!.inputSchema as Record<string, z.ZodTypeAny>);
      expect(
        validateKeys.some((key) => /strays?/i.test(key)),
        `validate-project inputSchema keys: ${validateKeys.join(", ")}`,
      ).to.equal(false);

      const syncConfig = __getToolConfig("sync-project");
      expect(syncConfig, "sync-project should be registered").to.exist;
      const syncKeys = Object.keys(syncConfig!.inputSchema as Record<string, z.ZodTypeAny>);
      expect(syncKeys, `sync-project inputSchema keys: ${syncKeys.join(", ")}`).to.include("txId");
    });

    // ── T12/T13 — [strays] survives a manifest failure (#184) ─────────────────
    // KNOWN-RED at the commit that introduces these two rows: `runSync` parses
    // `project.c3proj` at the very top and throws on unparseable JSON, and the
    // outer `withMcpErrors` catches that and returns `mcpError(...)` BEFORE
    // `reportImageDrift`/`reportStrayFiles` ever run — so the response text
    // carries no `[strays]` line at all. The later wiring task (not this one)
    // moves the throw into an inner try/catch so both reporters still run
    // alongside the error. This red state is the structural revert-confirm
    // that the wiring is genuinely load-bearing, matching the committed-red
    // discipline `test/c3/strayFileTolerance.test.ts` already uses.

    it("T12: MCP validate-project reports strays past a manifest failure", async () => {
      const unparseableRoot = seedUnparseableStrayProject();
      __setProjectRoot(unparseableRoot);
      try {
        const validate = __getHandler("validate-project")!;
        const result = (await validate({}, makeExtra())) as any;

        // The contract is DELIBERATELY UNCHANGED here: the tool genuinely
        // failed to parse the manifest, so the response must still be
        // isError — the diagnostics ride ALONGSIDE the failure, they do not
        // turn it into a success. A reader seeing [strays] lines below might
        // otherwise assume the fix flips this to a success response; it does
        // not.
        expect(result.isError).to.equal(true);
        expect(result.content[0].text).to.include("Could not parse");
        expect(result.content[0].text).to.include("! layouts/notes.txt");
      } finally {
        fs.rmSync(unparseableRoot, { recursive: true, force: true });
      }
    });

    it("T13: the MCP error block's [strays] lines are byte-identical to the reporter's", async () => {
      const unparseableRoot = seedUnparseableStrayProject();
      __setProjectRoot(unparseableRoot);
      try {
        const expected: string[] = [];
        reportStrayFiles(unparseableRoot, (m) => expected.push(m));
        expect(expected.length, "seed must produce at least two stray rows for order to be meaningful").to.be.at.least(
          2,
        );

        const validate = __getHandler("validate-project")!;
        const result = (await validate({}, makeExtra())) as any;

        // Order included — the error block must render the SAME reporter
        // output the success path does, just alongside the failure text.
        expect(strayLinesOf(result.content[0].text)).to.deep.equal(expected);
      } finally {
        fs.rmSync(unparseableRoot, { recursive: true, force: true });
      }
    });
  });

  // ── writeSourceJson wiring — no trailing newline on real write paths ──────
  // (#195 T3). T1/T2 proved writeSourceJson itself
  // (test/c3/sourceJson.test.ts) and wired every C3-source write site onto
  // it. This proves the WIRING: a real mutate path (apply-recipe →
  // objectTypes/Text.json) and real create paths (scaffold-layout,
  // scaffold-sprite) still land bytes with no trailing newline when driven
  // end-to-end through the MCP handlers — not just through the helper in
  // isolation, which a stray bare `writeFileSync` reintroduced at a call
  // site would not be caught by. Reads a Buffer and asserts on the raw last
  // byte, since a string `.endsWith()` check can't distinguish "no trailing
  // newline" from "file happens to not end in whitespace" as precisely.

  describe("writeSourceJson wiring — no trailing newline on real write paths (#195 T3)", () => {
    function assertNoTrailingNewline(filePath: string, expectedByte: 0x7d | 0x5d): void {
      const buf = fs.readFileSync(filePath);
      const last = buf[buf.length - 1];
      expect(last, `last byte was 0x${last.toString(16)}, expected 0x${expectedByte.toString(16)}`).to.equal(
        expectedByte,
      );
      expect(last, "last byte must never be a trailing newline (0x0a)").to.not.equal(0x0a);
    }

    it("mutate path: apply-recipe (addInstVars) writes objectTypes/Text.json ending in '}', no trailing newline", async () => {
      const handler = __getHandler("apply-recipe")!;
      expect(handler).to.exist;

      __setExtractedDirty(true); // skip registry freshness scan
      const result = (await handler(
        { recipe: VALID_RECIPE, txId: "default:5", regenerate: false },
        makeExtra(),
      )) as any;

      expect(result.isError, result.content?.[0]?.text).to.be.undefined;

      assertNoTrailingNewline(path.join(tmp, "objectTypes", "Text.json"), 0x7d);
    });

    it("create path: scaffold-layout writes a new layout JSON ending in '}', no trailing newline", async () => {
      const handler = __getHandler("scaffold-layout")!;
      expect(handler).to.exist;

      const result = (await handler(
        {
          source: "Gameplay/Main Layout.json",
          name: "T3ClonedLayout",
          path: "T3ClonedLayout.json",
          eventSheet: "Event sheet 1",
          regenerate: false,
        },
        makeExtra(),
      )) as any;

      expect(result.isError, result.content?.[0]?.text).to.be.undefined;

      assertNoTrailingNewline(path.join(tmp, "layouts", "T3ClonedLayout.json"), 0x7d);
    });

    it("create path: scaffold-sprite writes a new objectType JSON ending in '}', no trailing newline", async () => {
      const handler = __getHandler("scaffold-sprite")!;
      expect(handler).to.exist;

      const result = (await handler({ source: "Text", name: "T3ClonedSprite" }, makeExtra())) as any;

      expect(result.isError, result.content?.[0]?.text).to.be.undefined;

      assertNoTrailingNewline(path.join(tmp, "objectTypes", "T3ClonedSprite.json"), 0x7d);
    });
  });

  // ── Manifest self-write registration (#277, H3-H5) ────────────────────────
  // Each tool that writes project.c3proj registers it via watcher.expect BEFORE
  // the write, and only when it writes. The fake's expect() snapshots the
  // manifest bytes at its first call so "before the write" is observed, not assumed.

  describe("project.c3proj self-write registration (#277)", () => {
    const manifestOf = (): string => path.join(tmp, "project.c3proj");
    let unchangedAtFirstExpect: boolean | undefined;

    function watchManifestBeforeWrite(): void {
      const manifestBefore = fs.readFileSync(manifestOf());
      unchangedAtFirstExpect = undefined;
      const w = makeFakeWatcher(5);
      const record = w.expect.bind(w);
      w.expect = (filePath: string): void => {
        unchangedAtFirstExpect ??= fs.readFileSync(manifestOf()).equals(manifestBefore);
        record(filePath);
      };
      watcher = w;
      __setTestWatcher(w as any);
    }

    it("H3: sync-project with drift registers exactly project.c3proj, before the write", async () => {
      fs.copyFileSync(path.join(tmp, "layouts", "Templates Layout.json"), path.join(tmp, "layouts", "Extra277.json"));
      watchManifestBeforeWrite();
      const result = (await __getHandler("sync-project")!({ txId: "default:5" }, makeExtra())) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(
        fs.readFileSync(manifestOf()).equals(fs.readFileSync(path.join(FIXTURE_DIR, "project.c3proj"))),
        "drift should have been synced",
      ).to.equal(false);
      expect([...new Set(watcher.expectCalls)]).to.deep.equal([manifestOf()]);
      expect(unchangedAtFirstExpect, "expect() must run before the manifest write").to.equal(true);
    });

    it("H4: sync-project with zero drift registers nothing", async () => {
      expect(runSync(tmp, true, () => {}).clean, "precondition: the pristine fixture has zero drift").to.equal(true);
      watchManifestBeforeWrite();
      const result = (await __getHandler("sync-project")!({ txId: "default:5" }, makeExtra())) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(watcher.expectCalls).to.deep.equal([]);
    });

    it("H5a: scaffold-layout registers its outPath and project.c3proj", async () => {
      watchManifestBeforeWrite();
      const result = (await __getHandler("scaffold-layout")!(
        {
          source: "Gameplay/Main Layout.json",
          name: "H5aLayout",
          path: "H5aLayout.json",
          eventSheet: "Event sheet 1",
          regenerate: false,
        },
        makeExtra(),
      )) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(fs.existsSync(path.join(tmp, "layouts", "H5aLayout.json"))).to.equal(true);
      expect([...new Set(watcher.expectCalls)]).to.have.members([
        path.join(tmp, "layouts", "H5aLayout.json"),
        manifestOf(),
      ]);
    });

    it("H5b: scaffold-sprite registers its outPath and project.c3proj", async () => {
      watchManifestBeforeWrite();
      const result = (await __getHandler("scaffold-sprite")!(
        { source: "Text", name: "H5bSprite", regenerate: false },
        makeExtra(),
      )) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(fs.existsSync(path.join(tmp, "objectTypes", "H5bSprite.json"))).to.equal(true);
      expect([...new Set(watcher.expectCalls)]).to.have.members([
        path.join(tmp, "objectTypes", "H5bSprite.json"),
        manifestOf(),
      ]);
    });
  });

  // ── scaffold-sprite regenerates extracted/ (#256) ─────────────────────────

  describe("scaffold-sprite regenerates extracted/ (#256)", () => {
    function snapshotExtracted(): Map<string, string> {
      const snap = new Map<string, string>();
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else
            snap.set(
              toPosixPath(path.relative(tmp, full)),
              createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
            );
        }
      };
      walk(path.join(tmp, "extracted"));
      return snap;
    }
    const registryRows = (file: string): number =>
      fs
        .readFileSync(path.join(tmp, "extracted", "sid-registry.txt"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l.includes(file)).length;

    it("R7: scaffold-sprite regenerates by default", async () => {
      __setExtractedDirty(false);
      const result = (await __getHandler("scaffold-sprite")!({ source: "Text", name: "RG7" }, makeExtra())) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(registryRows("objectTypes/RG7.json")).to.be.at.least(1);
      expect(__getExtractedDirty()).to.be.false;
      expect(watcher.bumped).to.equal(1);
    });

    it("R8: scaffold-sprite with regenerate:false leaves extracted/ unchanged and marks it dirty", async () => {
      __setExtractedDirty(false);
      const before = snapshotExtracted();
      const result = (await __getHandler("scaffold-sprite")!(
        { source: "Text", name: "RG8", regenerate: false },
        makeExtra(),
      )) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(snapshotExtracted()).to.deep.equal(before);
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("R34 (scaffold-sprite): regenerate:true still clears dirty", async () => {
      __setExtractedDirty(true);
      const before = snapshotExtracted();
      const result = (await __getHandler("scaffold-sprite")!(
        { source: "Text", name: "RG8", regenerate: true },
        makeExtra(),
      )) as any;
      expect(result.isError, result.content?.[0]?.text).to.be.undefined;
      expect(__getExtractedDirty()).to.be.false;
      expect(snapshotExtracted()).to.not.deep.equal(before);
      expect(watcher.bumped).to.equal(1);
    });
  });

  // ── regenerate:false marks extracted/ dirty (#256 D1) ─────────────────────

  describe("regenerate:false marks extracted/ dirty (#256 D1)", () => {
    function snapshotExtracted(): Map<string, string> {
      const snap = new Map<string, string>();
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else
            snap.set(
              toPosixPath(path.relative(tmp, full)),
              createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
            );
        }
      };
      walk(path.join(tmp, "extracted"));
      return snap;
    }

    const D1_RECIPE = JSON.stringify({ files: { "eventSheets/D1.json": { create: true, events: [] } } });
    const WORKFLOW_ARGS = {
      layout: "layouts/Gameplay/Main Layout.json",
      type: "Sprite3",
      templateName: "D1Tpl",
    };
    const LAYOUT_ARGS = {
      source: "Gameplay/Main Layout.json",
      name: "D1Layout",
      path: "D1/D1Layout.json",
      eventSheet: "Event sheet 1",
    };
    const CALLS: Array<{ id: string; tool: string; args: Record<string, unknown> }> = [
      { id: "apply-recipe", tool: "apply-recipe", args: { recipe: D1_RECIPE } },
      { id: "workflow", tool: "templatize-in-place", args: WORKFLOW_ARGS },
      { id: "scaffold-layout", tool: "scaffold-layout", args: LAYOUT_ARGS },
    ];
    const R26_TO_R28 = ["R26", "R27", "R28"];

    CALLS.forEach((c, i) => {
      it(`${R26_TO_R28[i]} ${c.id}: regenerate:false marks dirty, leaves extracted/ unchanged, bumps once`, async () => {
        __setExtractedDirty(false);
        const before = snapshotExtracted();
        const result = (await __getHandler(c.tool)!({ ...c.args, regenerate: false }, makeExtra())) as any;
        expect(result.isError, result.content?.[0]?.text).to.be.undefined;
        expect(__getExtractedDirty()).to.be.true;
        expect(snapshotExtracted()).to.deep.equal(before);
        expect(watcher.bumped).to.equal(1);
      });

      it(`R34 (${c.id}): regenerate:true still clears dirty`, async () => {
        __setExtractedDirty(true);
        const before = snapshotExtracted();
        const result = (await __getHandler(c.tool)!({ ...c.args, regenerate: true }, makeExtra())) as any;
        expect(result.isError, result.content?.[0]?.text).to.be.undefined;
        expect(__getExtractedDirty()).to.be.false;
        expect(snapshotExtracted()).to.not.deep.equal(before);
        expect(watcher.bumped).to.equal(1);
      });
    });
  });

  // ── scaffold-layout / scaffold-sprite refuse to overwrite or collide (#254) ──
  // `tmp` is a fresh fixture copy per test (beforeEach), so planted images and any
  // writes here cannot leak into other rows.

  describe("scaffold tools refuse overwrites and collisions (#254)", () => {
    /** relPath -> sha256 of every file under root, so "nothing written" is assertable tree-wide. */
    function snapshotTree(root: string): Map<string, string> {
      const snap = new Map<string, string>();
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else
            snap.set(
              toPosixPath(path.relative(root, full)),
              createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
            );
        }
      };
      walk(root);
      return snap;
    }

    const textOf = (result: any): string => result.content.map((b: any) => b.text).join("\n");

    it("H1: scaffold-layout with source == path is refused: names the file, leaves bytes, no bump, no suppress", async () => {
      const handler = __getHandler("scaffold-layout")!;
      expect(handler).to.exist;
      const rel = "layouts/Gameplay/Main Layout.json";
      const before = fs.readFileSync(path.join(tmp, rel));

      const result = (await handler(
        {
          source: "Gameplay/Main Layout.json",
          name: "H1Layout",
          path: "Gameplay/Main Layout.json",
          eventSheet: "Event sheet 1",
          regenerate: false,
        },
        makeExtra(),
      )) as any;

      expect(result.isError).to.be.true;
      const text = textOf(result);
      expect(text).to.include("scaffold-layout refused:");
      expect(text).to.include(rel);
      expect(text.split("\n").pop()).to.equal("txId: default:5");
      expect(fs.readFileSync(path.join(tmp, rel)).equals(before)).to.be.true;
      expect(watcher.bumped).to.equal(0);
      expect(watcher.suppressCalls).to.equal(0);
    });

    it("H2: scaffold-layout with a colliding layout name is refused and the whole tree is unchanged, dirty flag kept", async () => {
      const handler = __getHandler("scaffold-layout")!;
      expect(handler).to.exist;
      __setExtractedDirty(true);
      const before = snapshotTree(tmp);

      const result = (await handler(
        {
          source: "Gameplay/Main Layout.json",
          name: "H2Layout",
          path: "NewDir/Main Layout.json",
          eventSheet: "Event sheet 1",
          regenerate: true,
        },
        makeExtra(),
      )) as any;

      expect(result.isError).to.be.true;
      const text = textOf(result);
      expect(text).to.include("scaffold-layout refused:");
      expect(text).to.include("layouts/Gameplay/Main Layout.json");
      expect(fs.existsSync(path.join(tmp, "layouts", "NewDir"))).to.be.false;
      expect(snapshotTree(tmp)).to.deep.equal(before);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("H3: scaffold-sprite collects every conflict (objectType name + image target) and writes nothing", async () => {
      const handler = __getHandler("scaffold-sprite")!;
      expect(handler).to.exist;
      const before = snapshotTree(tmp);

      const result = (await handler({ source: "Sprite2", name: "Sprite3" }, makeExtra())) as any;

      expect(result.isError).to.be.true;
      const text = textOf(result);
      expect(text).to.include("refused: 2 conflicting path(s)");
      expect(text).to.include("objectTypes/images/Sprite3.json");
      expect(text).to.include("images/sprite3-animation 1-000.png");
      expect(text.split("\n").pop()).to.equal("txId: default:5");
      expect(fs.existsSync(path.join(tmp, "objectTypes", "Sprite3.json"))).to.be.false;
      expect(snapshotTree(tmp)).to.deep.equal(before);
      expect(watcher.bumped).to.equal(0);
    });

    it("H4a: scaffold-sprite with a missing source reports 'not found', not a refusal, even when the target exists", async () => {
      const handler = __getHandler("scaffold-sprite")!;
      const result = (await handler({ source: "NoSuchSprite", name: "Text" }, makeExtra())) as any;

      expect(result.isError).to.be.true;
      const text = textOf(result);
      expect(text).to.include("Source objectType not found");
      expect(text).to.not.include("refused:");
    });

    it("H4b: scaffold-layout with a missing source reports 'not found', not a refusal, even when the output exists", async () => {
      const handler = __getHandler("scaffold-layout")!;
      const result = (await handler(
        {
          source: "Nope/Missing.json",
          name: "H4Layout",
          path: "Gameplay/Main Layout.json",
          eventSheet: "Event sheet 1",
          regenerate: false,
        },
        makeExtra(),
      )) as any;

      expect(result.isError).to.be.true;
      const text = textOf(result);
      expect(text).to.include("Source layout not found");
      expect(text).to.not.include("refused:");
    });

    it("C4: the CLI refusal is byte-identical to the MCP refusal (minus the txId line) and to formatScaffoldRefusal", async function () {
      this.timeout(60_000);
      const handler = __getHandler("scaffold-sprite")!;
      const mcp = (await handler({ source: "Sprite2", name: "Sprite3" }, makeExtra())) as any;
      expect(mcp.isError).to.be.true;
      const lines = textOf(mcp).split("\n");
      expect(lines.pop()).to.equal("txId: default:5");
      const mcpMessage = lines.join("\n");

      const cli = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Sprite2", "--name", "Sprite3"]);

      const expected = formatScaffoldRefusal("scaffold-sprite", [
        { relPath: "objectTypes/images/Sprite3.json", reason: "objectType-name" },
        { relPath: "images/sprite3-animation 1-000.png", reason: "image-target" },
      ]);
      expect(cli.exitCode).to.equal(1);
      expect(cli.stderr.trimEnd()).to.equal(mcpMessage);
      expect(mcpMessage).to.equal(expected);
    });

    it("SR13: scaffold-sprite finds a source that the fixture keeps in a subfolder and writes the clone flat", async () => {
      const handler = __getHandler("scaffold-sprite")!;
      const result = (await handler({ source: "Sprite2", name: "SR13Clone", regenerate: false }, makeExtra())) as any;

      expect(result.isError, textOf(result)).to.be.undefined;
      expect(fs.existsSync(path.join(tmp, "objectTypes", "SR13Clone.json"))).to.be.true;
      expect(fs.existsSync(path.join(tmp, "images", "sr13clone-animation 1-000.png"))).to.be.true;
      expect(fs.existsSync(path.join(tmp, "objectTypes", "Sprite2.json"))).to.be.false;
      expect(watcher.bumped).to.equal(1);
    });

    it("SR14: a case-only source mismatch renders byte-identically on CLI and MCP", async function () {
      this.timeout(60_000);
      const handler = __getHandler("scaffold-sprite")!;
      const mcp = (await handler({ source: "text", name: "SR14Clone" }, makeExtra())) as any;
      expect(mcp.isError).to.be.true;
      const lines = textOf(mcp).split("\n");
      expect(lines.pop()).to.equal("txId: default:5");
      const mcpMessage = lines.join("\n");

      const cli = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "text", "--name", "SR14Clone"]);

      const expected = formatScaffoldSourceCaseMismatch("text", "objectTypes/Text.json");
      expect(mcpMessage).to.equal(expected);
      expect(cli.exitCode).to.equal(1);
      expect(cli.stderr.trimEnd()).to.equal(expected);
    });

    it("SR15: an ambiguous source renders byte-identically on CLI and MCP", async function () {
      this.timeout(60_000);
      fs.copyFileSync(path.join(tmp, "objectTypes", "Text.json"), path.join(tmp, "objectTypes", "tiles", "Text.json"));
      const handler = __getHandler("scaffold-sprite")!;
      const mcp = (await handler({ source: "Text", name: "SR15Clone" }, makeExtra())) as any;
      expect(mcp.isError).to.be.true;
      const lines = textOf(mcp).split("\n");
      expect(lines.pop()).to.equal("txId: default:5");
      const mcpMessage = lines.join("\n");

      const cli = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "SR15Clone"]);

      const expected = formatScaffoldSourceAmbiguous("Text", ["objectTypes/Text.json", "objectTypes/tiles/Text.json"]);
      expect(mcpMessage).to.equal(expected);
      expect(cli.exitCode).to.equal(1);
      expect(cli.stderr.trimEnd()).to.equal(expected);
    });

    it("SC4: a case-only layout name collision renders byte-identically on CLI and MCP, naming the on-disk file", async function () {
      this.timeout(60_000);
      const handler = __getHandler("scaffold-layout")!;
      const mcp = (await handler(
        {
          source: "Gameplay/Main Layout.json",
          name: "SC4Layout",
          path: "NewDir/main layout.json",
          eventSheet: "Event sheet 1",
          regenerate: false,
        },
        makeExtra(),
      )) as any;
      expect(mcp.isError).to.be.true;
      const lines = textOf(mcp).split("\n");
      expect(lines.pop()).to.equal("txId: default:5");
      const mcpMessage = lines.join("\n");

      const cli = runCli([
        "scaffold-layout",
        "--project-dir",
        tmp,
        "--source",
        "layouts/Gameplay/Main Layout.json",
        "--out",
        "layouts/NewDir2/main layout.json",
        "--name",
        "SC4Layout",
        "--event-sheet",
        "Event sheet 1",
        "--no-regenerate",
      ]);

      const expected = formatScaffoldRefusal("scaffold-layout", [
        { relPath: "layouts/Gameplay/Main Layout.json", reason: "layout-name" },
      ]);
      expect(mcpMessage).to.equal(expected);
      expect(cli.exitCode).to.equal(1);
      expect(cli.stderr.trimEnd()).to.equal(expected);
    });

    it("T19: CLI and MCP scaffold rejections are byte-identical to the shared formatters (a) output path (b) missing source (c) sprite name", async function () {
      this.timeout(60_000);
      // Strips the trailing txId line (asserted, not discarded). "default:5" is
      // hardcoded exactly as in C4/H1/H3: the harness fixes the counter at 5.
      const mcpMessage = (result: any): string => {
        expect(result.isError).to.be.true;
        const lines = textOf(result).split("\n");
        expect(lines.pop()).to.equal("txId: default:5");
        return lines.join("\n");
      };
      const layoutHandler = __getHandler("scaffold-layout")!;
      const spriteHandler = __getHandler("scaffold-sprite")!;

      // (a) output path escaping the layouts dir
      const mcpA = mcpMessage(
        await layoutHandler(
          {
            source: "Gameplay/Main Layout.json",
            name: "T19a",
            path: "../../x.json",
            eventSheet: "Event sheet 1",
            regenerate: false,
          },
          makeExtra(),
        ),
      );
      const cliA = runCli([
        "scaffold-layout",
        "--project-dir",
        tmp,
        "--source",
        "layouts/Gameplay/Main Layout.json",
        "--out",
        "../../x.json",
        "--name",
        "T19a",
        "--event-sheet",
        "Event sheet 1",
        "--no-regenerate",
      ]);
      expect(cliA.exitCode).to.equal(1);
      expect(cliA.stderr.trimEnd()).to.equal(mcpA);
      expect(mcpA).to.equal(formatScaffoldPathRejection("output", "../../x.json"));

      // (b) missing source layout
      const mcpB = mcpMessage(
        await layoutHandler(
          {
            source: "Nope.json",
            name: "T19b",
            path: "Gameplay/T19b.json",
            eventSheet: "Event sheet 1",
            regenerate: false,
          },
          makeExtra(),
        ),
      );
      const cliB = runCli([
        "scaffold-layout",
        "--project-dir",
        tmp,
        "--source",
        "layouts/Nope.json",
        "--out",
        "layouts/Gameplay/T19b.json",
        "--name",
        "T19b",
        "--event-sheet",
        "Event sheet 1",
        "--no-regenerate",
      ]);
      expect(cliB.exitCode).to.equal(1);
      expect(cliB.stderr.trimEnd()).to.equal(mcpB);
      expect(mcpB).to.equal(formatScaffoldSourceNotFound("layout", "layouts/Nope.json"));

      // (c) sprite name escaping the objectTypes dir
      const mcpC = mcpMessage(await spriteHandler({ source: "Text", name: "../X" }, makeExtra()));
      const cliC = runCli(["scaffold-sprite", "--project-dir", tmp, "--source", "Text", "--name", "../X"]);
      expect(cliC.exitCode).to.equal(1);
      expect(cliC.stderr.trimEnd()).to.equal(mcpC);
      expect(mcpC).to.equal(formatScaffoldNameRejection("name", "../X"));
    });

    it("SI267-R9: CLI (exit 1, stderr) and MCP (isError) scaffold input rejections are byte-identical to the shared formatters", async function () {
      this.timeout(180_000);
      // Same fixed-counter txId line as T19: the harness fixes the counter at 5.
      const mcpMessage = (result: any): string => {
        expect(result.isError).to.be.true;
        const lines = textOf(result).split("\n");
        expect(lines.pop()).to.equal("txId: default:5");
        return lines.join("\n");
      };
      const layoutHandler = __getHandler("scaffold-layout")!;
      const spriteHandler = __getHandler("scaffold-sprite")!;
      const SRC = "Gameplay/Main Layout.json";
      // MCP layout paths are layouts-relative; CLI paths are project-relative (layouts/...).
      const layoutCase = async (
        label: string,
        over: { name?: string; eventSheet?: string; out?: string; source?: string },
        expected: string,
      ): Promise<void> => {
        const o = { name: "SI267", eventSheet: "Event sheet 1", out: "Gameplay/SI267.json", source: SRC, ...over };
        const mcp = mcpMessage(
          await layoutHandler(
            { source: o.source, name: o.name, path: o.out, eventSheet: o.eventSheet, regenerate: false },
            makeExtra(),
          ),
        );
        const cli = runCli([
          "scaffold-layout",
          "--project-dir",
          tmp,
          "--source",
          "layouts/" + o.source,
          "--out",
          "layouts/" + o.out,
          "--name",
          o.name,
          "--event-sheet",
          o.eventSheet,
          "--no-regenerate",
        ]);
        expect(mcp, `${label} MCP`).to.equal(expected);
        expect(cli.exitCode, `${label} CLI exit: ${cli.stderr}`).to.equal(1);
        expect(cli.stderr.trimEnd(), `${label} CLI`).to.equal(expected);
      };

      await layoutCase("empty name", { name: "" }, formatScaffoldEmptyInput("name"));
      await layoutCase("empty eventSheet", { eventSheet: "" }, formatScaffoldEmptyInput("event sheet"));
      // The rejection renders the resolved project-relative path, so a trailing separator drops out.
      for (const [bad, rel] of [
        ["Foo/", "layouts/Foo"],
        ["Foo", "layouts/Foo"],
        ["Foo.JSON", "layouts/Foo.JSON"],
        [".json", "layouts/.json"],
      ]) {
        await layoutCase(`out ${bad}`, { out: bad }, formatScaffoldOutputNotJson(rel));
      }
      await layoutCase("directory source", { source: "Gameplay" }, formatScaffoldSourceNotFile("layouts/Gameplay"));

      const spriteCase = async (
        label: string,
        over: { source?: string; name?: string },
        expected: string,
      ): Promise<void> => {
        const o = { source: "Text", name: "SI267Clone", ...over };
        const mcp = mcpMessage(await spriteHandler({ source: o.source, name: o.name, regenerate: false }, makeExtra()));
        const cli = runCli([
          "scaffold-sprite",
          "--project-dir",
          tmp,
          "--source",
          o.source,
          "--name",
          o.name,
          "--no-regenerate",
        ]);
        expect(mcp, `${label} MCP`).to.equal(expected);
        expect(cli.exitCode, `${label} CLI exit: ${cli.stderr}`).to.equal(1);
        expect(cli.stderr.trimEnd(), `${label} CLI`).to.equal(expected);
      };
      await spriteCase("empty name", { name: "" }, formatScaffoldNameRejection("name", ""));
      await spriteCase("empty source", { source: "" }, formatScaffoldNameRejection("source", ""));
      await spriteCase("colon name", { name: "a:b" }, formatScaffoldNameRejection("name", "a:b"));
    });
  });

  // ── a refused apply writes nothing (#279) ─────────────────────────────────
  // Each row asserts the refusal (error text, txId line, bumped, dirty) FIRST and the
  // file state LAST, so a red run names which half failed.

  describe("a refused apply writes nothing (#279)", () => {
    const a1 = JSON.stringify({
      layouts: {
        "layouts/Templates Layout.json": [{ op: "add-layer", name: "P" }],
        "layouts/UI/Second Layout.json": [{ op: "rename-layer", currentName: "NoSuchLayer", newName: "X" }],
      },
    });
    const a2 = JSON.stringify({
      layouts: { "layouts/Templates Layout.json": [{ op: "add-layer", name: "P" }] },
      files: { "eventSheets/Gameplay/Event sheet 1.json": [{ op: "remove-event", path: "sid:123456789012345" }] },
    });

    async function check(tool: string, args: Record<string, unknown>, errorText: string): Promise<void> {
      const before = snapshotTree(tmp);
      const result = (await __getHandler(tool)!(args, makeExtra())) as any;
      const text = result.content.map((b: any) => b.text).join("\n") as string;
      expect(result.isError).to.be.true;
      expect(text).to.include(errorText);
      expect(text.split("\n").pop()).to.equal("txId: default:5");
      expect(watcher.bumped).to.equal(0);
      expect(__getExtractedDirty()).to.be.false;
      const after = snapshotTree(tmp);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
      expect(changed, "files changed by a refused apply").to.deep.equal([]);
    }

    it("T1: a layout op that fails after an earlier layout was edited leaves every file unchanged", async () => {
      await check(
        "apply-recipe",
        { recipe: a1, txId: "default:5", regenerate: false },
        'renameLayer: layer "NoSuchLayer" not found',
      );
    });

    it("T2b: a files op that fails after a layout edit leaves every file unchanged", async () => {
      await check(
        "apply-recipe",
        { recipe: a2, txId: "default:5", regenerate: false },
        'Cannot split node path "sid:123456789012345"',
      );
    });

    it("T4: clone-replica-to-layouts with a bad second target layer leaves every file unchanged", async () => {
      await check(
        "clone-replica-to-layouts",
        {
          templatesLayout: "layouts/Templates Layout.json",
          templateName: "default",
          sourceType: "Sprite3",
          targets: [
            { layout: "layouts/UI/Second Layout.json", layer: "layer 1" },
            { layout: "layouts/Gameplay/Main Layout.json", layer: "NoSuchLayer" },
          ],
          txId: "default:5",
          regenerate: false,
        },
        "NoSuchLayer",
      );
    });
  });

  // ── a failed mutation reports what it may have written (#255) ─────────────
  // Each row asserts in order: error text, the last-line txId, bumped, dirty, so a red run
  // names which half failed.

  describe("a failed mutation reports what it may have written (#255)", () => {
    const twoSheets = JSON.stringify({
      files: {
        "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", comment: "T2A" }],
        "eventSheets/UI/Event sheet 2.json": [{ op: "insert-event", comment: "T2B" }],
      },
    });
    const sheet1Only = JSON.stringify({
      files: { "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", comment: "T3B" }] },
    });
    const addInstVars = JSON.stringify({
      addInstVars: [{ type: "Text", instanceVariables: [{ name: "probeVar", type: "number" }] }],
    });
    const singleLayoutFail = JSON.stringify({
      layouts: {
        "layouts/UI/Second Layout.json": [{ op: "rename-layer", currentName: "NoSuchLayer", newName: "X" }],
      },
    });
    const cloneArgs = {
      templatesLayout: "layouts/Templates Layout.json",
      templateName: "default",
      sourceType: "Sprite3",
      targets: [{ layout: "layouts/UI/Second Layout.json", layer: "layer 1" }],
      txId: "default:5",
    };
    const scaffoldLayoutArgs = {
      source: "Gameplay/Main Layout.json",
      name: "ProbeLayout",
      path: "Probe/ProbeLayout.json",
      eventSheet: "Event sheet 1",
    };

    const run = async (tool: string, args: Record<string, unknown>): Promise<{ result: any; text: string }> => {
      const result = (await __getHandler(tool)!(args, makeExtra())) as any;
      return { result, text: result.content.map((b: any) => b.text).join("\n") as string };
    };
    const lastLine = (text: string): string => text.split("\n").pop()!;

    let restoreReadOnly: (() => void) | undefined;
    afterEach(() => {
      restoreReadOnly?.();
      restoreReadOnly = undefined;
    });
    const makeSheet2ReadOnly = (): void => {
      restoreReadOnly = makeReadOnly(path.join(tmp, "eventSheets", "UI", "Event sheet 2.json"));
    };

    it("T2: a write that fails after an earlier sheet landed bumps txId and marks extracted dirty", async function () {
      if (process.getuid?.() === 0) this.skip();
      makeSheet2ReadOnly();
      const { result, text } = await run("apply-recipe", { recipe: twoSheets, txId: "default:5", regenerate: false });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T3: addInstVars with a broken event sheet bumps txId and marks extracted dirty", async () => {
      plantBrokenSheet(tmp);
      const { result, text } = await run("apply-recipe", { recipe: addInstVars, txId: "default:5" });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T3b: a files-only insert with a broken layout (regenerate fails) bumps txId and marks extracted dirty", async () => {
      plantBrokenLayout(tmp);
      const { result, text } = await run("apply-recipe", { recipe: sheet1Only, txId: "default:5" });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T4b: clone-replica-to-layouts whose regenerate fails bumps txId and marks extracted dirty", async () => {
      plantBrokenSheet(tmp);
      const { result, text } = await run("clone-replica-to-layouts", cloneArgs);
      expect(result.isError, text).to.be.true;
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T5: scaffold-layout with a broken manifest bumps txId and marks extracted dirty", async () => {
      breakManifest(tmp);
      const { result, text } = await run("scaffold-layout", { ...scaffoldLayoutArgs, regenerate: false });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T6: scaffold-layout whose regenerate fails bumps txId and marks extracted dirty", async () => {
      plantBrokenSheet(tmp);
      const { result, text } = await run("scaffold-layout", { ...scaffoldLayoutArgs, regenerate: true });
      expect(result.isError, text).to.be.true;
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T7: scaffold-sprite with a broken manifest bumps txId and marks extracted dirty", async () => {
      breakManifest(tmp);
      const { result, text } = await run("scaffold-sprite", { source: "Text", name: "ProbeSprite" });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:6");
      expect(watcher.bumped).to.equal(1);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T8: regenerate that fails marks extracted dirty without bumping txId", async () => {
      plantBrokenSheet(tmp);
      const { result, text } = await run("regenerate", {});
      expect(result.isError, text).to.be.true;
      expect(watcher.bumped).to.equal(0);
      expect(__getExtractedDirty()).to.be.true;
    });

    it("T9: a single-layout op refused during compute leaves txId and dirty alone", async () => {
      const { result, text } = await run("apply-recipe", {
        recipe: singleLayoutFail,
        txId: "default:5",
        regenerate: false,
      });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:5");
      expect(watcher.bumped).to.equal(0);
      expect(__getExtractedDirty()).to.be.false;
    });

    it("T10: remove-layer on a missing layer leaves txId and dirty alone", async () => {
      const { result, text } = await run("remove-layer", {
        layout: "layouts/UI/Second Layout.json",
        layer: "NoSuchLayer",
        txId: "default:5",
        regenerate: false,
      });
      expect(result.isError, text).to.be.true;
      expect(lastLine(text)).to.equal("txId: default:5");
      expect(watcher.bumped).to.equal(0);
      expect(__getExtractedDirty()).to.be.false;
    });

    it("T13: a refused call after a failed write does not bump again (ledger is per call)", async function () {
      if (process.getuid?.() === 0) this.skip();
      makeSheet2ReadOnly();
      const first = await run("apply-recipe", { recipe: twoSheets, txId: "default:5", regenerate: false });
      expect(first.result.isError, first.text).to.be.true;
      expect(watcher.bumped).to.equal(1);
      const second = await run("apply-recipe", { recipe: singleLayoutFail, txId: "default:6", regenerate: false });
      expect(second.result.isError, second.text).to.be.true;
      expect(lastLine(second.text)).to.equal("txId: default:6");
      expect(watcher.bumped).to.equal(1);
    });
  });
});

// ── Project-scoped tool registration (#95) ──────────────────────────────
// Independent of the FIXTURE_DIR/watcher/tmp-project scaffolding above —
// __getToolConfig/__listToolNames read the module-level `toolConfigs` map
// populated once at import time by every `reg`/`regP` call, not per-project
// state, so this suite needs no beforeEach/afterEach of its own.

describe("MCP server project-scoped tool registration (#95)", () => {
  // list-projects is the sole exemption from the `project` selector every
  // other tool accepts via `regP` — it enumerates the registry, so it
  // cannot itself belong to one project (see server.ts's own comment above
  // the list-projects registration).
  const EXEMPT = ["list-projects"];

  it("T-C1: every non-exempt registered tool declares a 'project' input param", () => {
    const names = __listToolNames();

    // Positive control: derived from the LIVE handler registry, so a
    // registry that silently enumerates nothing (e.g. a broken import path)
    // cannot pass this assertion vacuously.
    expect(names.length, `registered tool count: ${names.length}`).to.be.greaterThan(30);

    const nonExempt = names.filter((n) => !EXEMPT.includes(n));
    expect(nonExempt.length, "non-exempt tool count").to.be.greaterThan(30);

    for (const name of nonExempt) {
      const config = __getToolConfig(name);
      expect(config, `${name}: no registered tool config`).to.exist;
      const inputSchema = config!.inputSchema as Record<string, z.ZodTypeAny> | undefined;
      expect(inputSchema, `${name}: no inputSchema`).to.exist;
      expect(inputSchema!.project, `${name}: missing 'project' input param`).to.exist;
    }
  });

  it("T-C1b: the sole exemption (list-projects) does NOT declare a 'project' param", () => {
    const config = __getToolConfig("list-projects");
    expect(config, "list-projects: no registered tool config").to.exist;
    const inputSchema = config!.inputSchema as Record<string, z.ZodTypeAny> | undefined;
    expect(inputSchema?.project, "list-projects unexpectedly gained a 'project' param").to.be.undefined;
  });
});

// ── #310: sync-project bumps txId only when it wrote ─────────────────────────

describe("sync-project txId bump (#310)", function () {
  this.timeout(30_000);
  let tmp: string | undefined;
  let watcher: FakeWatcher;

  beforeEach(() => {
    watcher = makeFakeWatcher(5);
  });

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
    cleanupScenarios();
    __resetTestState();
  });

  function pointAt(root: string): void {
    __setProjectRoot(root);
    __setTestWatcher(watcher as any);
    __setExtractedDirty(false);
  }

  const tokenOf = (text: string): string | undefined => /txId: (\S+)/.exec(text)?.[1];

  it("I310-M1: sync-project on a pristine fixture copy does not bump txId", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i310-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    pointAt(tmp);
    const result = (await __getHandler("sync-project")!({ txId: "default:5" }, makeExtra())) as any;
    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
    expect({ bumped: watcher.bumped, token: tokenOf(result.content[0].text) }).to.deep.equal({
      bumped: 0,
      token: "default:5",
    });
  });

  it("I310-M2: sync-project with drift bumps txId and changes the manifest", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-i310-"));
    fs.cpSync(FIXTURE_DIR, tmp, { recursive: true });
    fs.copyFileSync(path.join(tmp, "layouts", "Templates Layout.json"), path.join(tmp, "layouts", "Extra277.json"));
    const before = fs.readFileSync(path.join(tmp, "project.c3proj"));
    pointAt(tmp);
    const result = (await __getHandler("sync-project")!({ txId: "default:5" }, makeExtra())) as any;
    expect(result.isError, result.content?.[0]?.text).to.be.undefined;
    expect({
      bumped: watcher.bumped,
      manifestChanged: !fs.readFileSync(path.join(tmp, "project.c3proj")).equals(before),
    }).to.deep.equal({ bumped: 1, manifestChanged: true });
  });

  it("I310-M3: F0 through MCP is in sync for validate-project and sync-project", async () => {
    const { root } = buildScenario("F0");
    pointAt(root);
    const validated = (await __getHandler("validate-project")!({}, makeExtra())) as any;
    const vText: string = validated.content[0].text;
    const synced = (await __getHandler("sync-project")!({ txId: "default:5" }, makeExtra())) as any;
    const sText: string = synced.content[0].text;
    expect({
      validateIsError: validated.isError === true,
      validateTimelinesNoChanges: /\[timelines\][^\n]*\(no changes\)/.test(vText),
      syncIsError: synced.isError === true,
      syncHasUpdated: sText.includes("Updated"),
      bumped: watcher.bumped,
    }).to.deep.equal({
      validateIsError: false,
      validateTimelinesNoChanges: true,
      syncIsError: false,
      syncHasUpdated: false,
      bumped: 0,
    });
  });
});
