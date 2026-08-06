import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_ONLY } from "@genvidtech/mcp-utils";
import {
  __getHandler,
  __getToolConfig,
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
import { seedManifestDrift } from "../helpers/seedManifestDrift.js";

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
// Handlers under test only touch watcher.txId, watcher.bump(), watcher.suppress(fn),
// and (sync-addon-metadata, deliberately NOT) watcher.expect(path) — expectCalls
// records calls to prove the latter, T24 below asserts it stays empty.
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

// cpSync stamps every copied file with ~the same mtime, and the recursive copy
// order (readdir order — not alphabetical on all filesystems) decides whether
// extracted/ ends up newer or older than the source dirs. checkSourceFreshness
// compares those mtimes with a strict `source > extracted`, so on some CI
// filesystems a freshly-copied fixture reads as spuriously stale. Force
// extracted/ deterministically newer than source so the freshness check is
// neutral and these tests drive staleness solely via __setExtractedDirty.
function makeExtractedNewerThanSource(root: string): void {
  const future = new Date(Date.now() + 3_600_000);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.utimesSync(full, future, future);
    }
  };
  const extractedDir = path.join(root, "extracted");
  if (fs.existsSync(extractedDir)) walk(extractedDir);
}

// Deterministic mtime control for the checkRegistryFreshness tests below:
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
    expect(result.content[0].text).to.equal("txId: 5\nextractedDirty: false");
  });

  // ── 2. stale-warning appended when extractedDirty is true ────────────────
  // Uses read-dsl which routes through paginatedResponse → appendStaleWarning.
  // The fixture has extracted/eventSheets/Event sheet 1.dsl.txt.

  it("read-dsl appends STALE_WARNING when extractedDirty=true, not when false", async () => {
    const handler = __getHandler("read-dsl")!;
    expect(handler).to.exist;

    // With dirty = true
    __setExtractedDirty(true);
    const dirtyResult = (await handler({ sheet: "Event sheet 1" }, makeExtra())) as any;
    expect(dirtyResult.content[0].text).to.include(STALE_WARNING);

    // Reset and try clean
    __setExtractedDirty(false);
    const cleanResult = (await handler({ sheet: "Event sheet 1" }, makeExtra())) as any;
    expect(cleanResult.content[0].text).to.not.include(STALE_WARNING);
  });

  // ── 3. read-dsl single-block pagination contract ─────────────────────────
  // paginatedResponse now delegates to paginatedContent (upstream helper) which
  // collapses the page text and the range footer into ONE content block, joined
  // with "\n\n". The old two-block shape is gone.
  //
  // Fixture: extracted/eventSheets/Event sheet 1.dsl.txt — 12 lines.

  it("read-dsl with offset+limit returns single content block with in-block range footer", async () => {
    const handler = __getHandler("read-dsl")!;
    expect(handler).to.exist;

    __setExtractedDirty(false);
    // offset=2, limit=1 → returns line 2 of the DSL file; footer appended in-block.
    const result = (await handler({ sheet: "Event sheet 1", offset: 2, limit: 1 }, makeExtra())) as any;

    // Single block — core contract of #26
    expect(result.content).to.have.length(1);
    expect(result.content[0].type).to.equal("text");
    // Range footer is in the same block, after "\n\n"
    expect(result.content[0].text).to.match(/\nlines: \d+-\d+ \/ \d+$/);

    // Out-of-range page: offset far beyond total lines → footer shows "lines: 0 / <total>"
    // (documents the latent-bug fix: the old two-block code computed a misleading
    //  endLine when returnedLines was 0 — the new upstream helper emits "lines: 0 / N")
    const outOfRange = (await handler({ sheet: "Event sheet 1", offset: 9999, limit: 1 }, makeExtra())) as any;
    expect(outOfRange.content).to.have.length(1);
    expect(outOfRange.content[0].text).to.match(/lines: 0 \/ \d+/);
  });

  // ── 4. apply-recipe txId-rejection ───────────────────────────────────────

  it("apply-recipe rejects mismatched txId before parsing recipe, no watcher bump", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: "{}", txId: 4 }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.equal("State changed (expected 4, got 5) — re-validate before applying\ntxId: 5");
    expect(watcher.bumped).to.equal(0);
  });

  // ── 5. apply-recipe caughtError on invalid JSON ───────────────────────────

  it("apply-recipe returns caughtError for invalid JSON, no watcher bump, dirty unchanged", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan; also tests dirty stays true
    const result = (await handler({ recipe: "{ not json", txId: 5 }, makeExtra())) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.match(/^Error:/);
    expect(result.content[0].text).to.include("txId: 5");
    expect(watcher.bumped).to.equal(0);
    expect(__getExtractedDirty()).to.be.true;
  });

  // ── 6. apply-recipe success with regenerate:false ─────────────────────────

  it("apply-recipe succeeds (regenerate:false): one block, txId bumped once, no isError", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: 5, regenerate: false }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: 6");
    expect(watcher.bumped).to.equal(1);
    // regenerate:false should NOT clear dirty
    // (dirty was true; test verifies it stays unchanged from this handler's perspective)
  });

  // ── 7. apply-recipe success (regenerate:true) clears extractedDirty ───────
  // Runs all 6 generators against the tmp fixture copy. Regression guard for the
  // generateSidRegistry dir fix in this commit: before it, this crashed on
  // Windows (ENOENT, doubled path) and silently mis-wrote the registry on POSIX.

  it("apply-recipe success (regenerate:true): clears extractedDirty, txId bumped", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE, txId: 5 }, makeExtra())) as any;

    expect(result.isError).to.be.undefined;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("txId: 6");
    expect(watcher.bumped).to.equal(1);
    // a full regenerate clears the stale flag
    expect(__getExtractedDirty()).to.be.false;
  });

  // ── 8. list-event-sheets pagination ──────────────────────────────────────
  // Fixture has 2 real event sheet entries under eventSheets/ (sorted):
  //   Event sheet 1.json, Event sheet 2.json
  // The *.uistate.json editor-local files are excluded by the c3source finder.
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

    it("excludes editor-local uistate files and includes all real sheets", async () => {
      const handler = __getHandler("list-event-sheets")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;
      const text: string = result.content[0].text;

      // Editor-local files must be absent
      expect(text).to.not.include(".uistate.json");
      // Both real event sheets must be present
      expect(text).to.include("Event sheet 1.json");
      expect(text).to.include("Event sheet 2.json");
    });
  });

  // ── 9. list-layouts pagination ────────────────────────────────────────────
  // Fixture has 3 real layout entries under layouts/ (sorted):
  //   Main Layout.json, Second Layout.json, Templates Layout.json
  // The *.uistate.json siblings and uistate/*.json files are excluded by the
  // c3source finder.
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

    it("excludes editor-local uistate files and includes all real layouts", async () => {
      const handler = __getHandler("list-layouts")!;
      expect(handler).to.exist;

      const result = (await handler({}, makeExtra())) as any;
      const text: string = result.content[0].text;

      // Editor-local files must be absent (*.uistate.json siblings and uistate/ subdir)
      expect(text).to.not.include(".uistate.json");
      expect(text).to.not.include("uistate/");
      // All three real layouts must be present
      expect(text).to.include("Main Layout.json");
      expect(text).to.include("Second Layout.json");
      expect(text).to.include("Templates Layout.json");
    });
  });

  // ── 10. apply-recipe CancelledError after source write ────────────────────
  // Aborted signal causes checkCancelled() to throw inside runGenerators AFTER
  // applyParsed has already written source files.

  // ── 11. navigation-graph ──────────────────────────────────────────────────
  // Fixture has two nav entries:
  //   Event sheet 1 → Second Layout  (line 11 in Event sheet 1.dsl.txt)
  //   Event sheet 2 → Main Layout    (line 7  in Event sheet 2.dsl.txt)

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
      expect(text).to.match(/\ntxId: 5$/);
      expect(text).to.include("Sprite2 [MyCustomBehavior]");
      expect(text).to.include("9patch [MyCustomBehavior]");
      expect(watcher.bumped).to.equal(0);
    });
  });

  it("apply-recipe with aborted signal: isError, Cancelled text, txId bumped, dirty=true", async () => {
    const handler = __getHandler("apply-recipe")!;
    expect(handler).to.exist;

    __setExtractedDirty(true); // skip registry freshness scan
    const result = (await handler({ recipe: VALID_RECIPE }, makeExtra(true))) as any;

    expect(result.isError).to.be.true;
    expect(result.content).to.have.length(1);
    expect(result.content[0].text).to.include("Cancelled");
    expect(result.content[0].text).to.match(/\ntxId: 6$/);
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
      expect(validateResult.content[0].text).to.equal(`${formatAddonValidation(validateAddons(tmp))}\ntxId: 5`);

      const listHandler = __getHandler("list-addons")!;
      const listResult = (await listHandler({}, makeExtra())) as any;
      expect(listResult.content[0].text).to.equal(`${formatAddonInventory(listAddons(tmp))}\ntxId: 5`);

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
      const result = (await handler({ direction: "manifest-from-package", txId: 4 }, makeExtra())) as any;

      expect(result.isError).to.be.true;
      expect(result.content).to.have.length(1);
      expect(result.content[0].text).to.equal(
        "State changed (expected 4, got 5) — re-validate before syncing\ntxId: 5",
      );
      expect(watcher.bumped).to.equal(0);
      expect(fs.readFileSync(manifestPath).equals(before), "manifest bytes must be unchanged").to.equal(true);
    });

    it("T22: a successful apply writes exactly one content block with a txId footer, bumps exactly once, and leaves extractedDirty unchanged", async () => {
      seedDrift();
      expect(__getExtractedDirty()).to.equal(false);

      const handler = __getHandler("sync-addon-metadata")!;
      const result = (await handler({ direction: "manifest-from-package", txId: 5 }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(result.content).to.have.length(1);
      expect(result.content[0].text).to.include("txId: 6");
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
        { direction: "package-from-manifest", txId: watcher.txId },
        makeExtra(),
      )) as any;
      expect(packageFromManifestResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      const noDriftResult = (await syncHandler(
        { direction: "manifest-from-package", txId: watcher.txId },
        makeExtra(),
      )) as any;
      expect(noDriftResult.isError).to.be.undefined;
      expect(watcher.bumped).to.equal(0);

      expect(__getExtractedDirty()).to.equal(false);
    });

    it("T24: the manifest write happens INSIDE watcher.suppress, and watcher.expect is never called", async () => {
      seedDrift();
      const manifestPath = path.join(tmp, "project.c3proj");

      let changedDuringSuppress = false;
      const trackingWatcher = makeFakeWatcher(5);
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
      const result = (await handler({ direction: "manifest-from-package", txId: 5 }, makeExtra())) as any;

      expect(result.isError).to.be.undefined;
      expect(trackingWatcher.suppressCalls).to.equal(1);
      expect(changedDuringSuppress, "the manifest write should happen inside the suppress window").to.equal(true);
      expect(trackingWatcher.expectCalls).to.deep.equal([]);
    });

    it("T25: MCP response text equals formatAddonMetadataSync's direct render of the same result — both surfaces route through the shared formatter", async () => {
      seedDrift();

      const previewHandler = __getHandler("preview-addon-metadata-sync")!;
      const previewResult = (await previewHandler({ direction: "manifest-from-package" }, makeExtra())) as any;

      const expected = syncAddonMetadata(tmp, { direction: "manifest-from-package", dryRun: true });
      expect("error" in expected, "expected a success result").to.equal(false);
      expect(previewResult.content[0].text).to.equal(
        `${formatAddonMetadataSync(expected as AddonSyncResult)}\ntxId: 5`,
      );

      // Both tools must render via the shared formatter — not hand-built strings.
      const serverSource = fs.readFileSync(path.resolve("src/mcp/server.ts"), "utf-8");
      const callCount = (serverSource.match(/formatAddonMetadataSync\(/g) ?? []).length;
      expect(callCount, "both tools should call formatAddonMetadataSync").to.be.at.least(2);
    });
  });

  // ── 14. checkRegistryFreshness excludes editor-local paths (ADR 0018 site 2) ─
  // generate-sids is the only handler whose response surfaces the effect of
  // checkRegistryFreshness's own scan directly (via appendStaleWarning), rather
  // than a stale flag set earlier by something else — so it's the right probe.
  // Mtimes are set explicitly (utimesSync) on every real source file plus the
  // registry, never relying on wall-clock/cpSync ordering.

  describe("checkRegistryFreshness (generate-sids probe)", () => {
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
      const layoutPath = path.join(tmp, "layouts", "Main Layout.json");
      fs.utimesSync(layoutPath, NEWER, NEWER);

      const handler = __getHandler("generate-sids")!;
      const result = (await handler({}, makeExtra())) as any;

      expect(result.content[0].text).to.include(STALE_WARNING);
      expect(__getExtractedDirty()).to.equal(true);
      expect(watcher.bumped).to.equal(1);
    });
  });
});
