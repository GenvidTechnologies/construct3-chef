import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WatcherFactory } from "@genvidtech/mcp-utils";
import { createSourceWatcher } from "../../src/mcp/sourceWatcher.js";
import { createProjectContext, type ProjectContext } from "../../src/mcp/projectContext.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";
import {
  __getHandler,
  __setTestWatcher,
  __setRegistry,
  __wireAllProjects,
  __resetTestState,
} from "../../src/mcp/server.js";
import { applyParsed } from "../../src/c3/recipeApplier.js";
import { copyFixture, snapshotTree, makeReadOnly } from "../helpers/applyFixtures.js";

// #277: a tool call's own source writes must not come back as external changes.
// mcp-utils' suppress() only masks events delivered while its body runs, and
// chef's writes are synchronous, so the real fs.watch events arrive AFTER the
// handler returned. W1-W5 and W7 reproduce that timing deterministically: they
// capture the factory callbacks createSourceWatcher hands to its (injected)
// watcherFactory and fire them only after the handler's promise resolved. W6
// drives the real fs.watch through the production wiring.
//
// Event shape mirrors production's fsWatchFactory: a directory target reports
// path.resolve(target, filename); the project.c3proj target (a file) reports
// path.resolve(target). Two events per changed file mimic Windows' duplicated
// change event.

const FIXTURE_DIR = path.resolve("test/fixtures/construct3-chef-sample");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rig {
  tmp: string;
  ctx: ProjectContext;
  /** Deliver `times` events for `rel` the way the real factory would, to the right watched target. */
  fire(rel: string, times?: number): void;
  /** Fire 2 events for every non-extracted file whose bytes differ from `before`. Returns the changed list. */
  fireChanged(before: Map<string, string>): string[];
}

interface RigOptions {
  /** Sleep this long after the tree is copied and before the watcher starts, so directory ctime stamps are trusted. */
  delayBeforeStartMs?: number;
}

async function makeRig(prefix: string, opts: RigOptions = {}): Promise<Rig> {
  const tmp = copyFixture(prefix);
  if (opts.delayBeforeStartMs) await sleep(opts.delayBeforeStartMs);
  const ctx = await createProjectContext("default", tmp);
  const callbacks = new Map<string, (f: string) => void>();
  const watcherFactory: WatcherFactory = (target, onEvent) => {
    callbacks.set(path.resolve(target), onEvent);
    return { close() {} };
  };
  const w = createSourceWatcher({
    projectRoot: tmp,
    expected: ctx.expected,
    watcherFactory,
    onSourceChange: () => {
      ctx.extractedDirty = true;
    },
  });
  w.start();
  const reg = new ProjectRegistry();
  reg.add(ctx);
  __setRegistry(reg);
  __setTestWatcher(w);
  ctx.extractedDirty = false;
  const fire = (rel: string, times = 1): void => {
    const target = rel === "project.c3proj" ? path.resolve(tmp, rel) : path.resolve(tmp, rel.split("/")[0]);
    const cb = callbacks.get(target);
    if (!cb) return; // not a watched dir (extracted/, images/, ...)
    for (let i = 0; i < times; i++) cb(path.resolve(tmp, rel));
  };
  const fireChanged = (before: Map<string, string>): string[] => {
    const after = snapshotTree(tmp);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    for (const rel of changed) fire(rel, 2);
    return changed;
  };
  return { tmp, ctx, fire, fireChanged };
}

function tokenOf(res: any): number {
  const text = res.content.map((c: any) => c.text).join("\n");
  const m = /default:(\d+)/.exec(text);
  expect(m, `no txId token in response: ${text.slice(0, 300)}`).to.not.equal(null);
  return Number(m![1]);
}

function cleanUp(tmp: string | undefined, restore: Array<() => void> = []): void {
  for (const r of restore) r();
  __resetTestState();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

const W1_RECIPE = JSON.stringify({
  addInstVars: [{ type: "Text", instanceVariables: [{ name: "probeIv", type: "number" }] }],
  layouts: { "layouts/UI/Second Layout.json": [{ op: "add-layer", name: "PIV" }] },
});

function makeExtra(): any {
  return { signal: new AbortController().signal, _meta: {} };
}

describe("MCP watcher self-writes (#277)", function () {
  this.timeout(60_000);
  let rig: Rig | undefined;
  const restores: Array<() => void> = [];

  afterEach(() => {
    cleanUp(rig?.tmp, restores.splice(0));
    rig = undefined;
  });

  /** The W1 scenario; returns the returned token. Shared with W2 so the control row follows the same flow. */
  async function runW1(r: Rig): Promise<number> {
    const before = snapshotTree(r.tmp);
    const res: any = await __getHandler("apply-recipe")!(
      { recipe: W1_RECIPE, txId: `default:${r.ctx.watcher.txId}`, regenerate: true },
      makeExtra(),
    );
    expect(res.isError, res.content?.[0]?.text).to.be.undefined;
    const token = tokenOf(res);
    const changed = r.fireChanged(before);
    expect(changed, "the apply should change the layout and the objectType").to.include.members([
      "layouts/UI/Second Layout.json",
      "objectTypes/Text.json",
    ]);
    return token;
  }

  it("W1: apply-recipe's own writes (2 events per file, after return) neither bump txId nor mark dirty", async () => {
    rig = await makeRig("w1-");
    const token = await runW1(rig);
    expect(rig.ctx.watcher.txId, "live txId should equal the returned counter").to.equal(token);
    expect(rig.ctx.extractedDirty).to.equal(false);
  });

  it("W2: control - after W1 settles, a genuine external edit still bumps +1 and marks dirty", async () => {
    rig = await makeRig("w2-");
    await runW1(rig);
    // W2 is a control for the watcher itself: it measures the delta from
    // wherever W1 left things, so it stays green independent of W1.
    const base = rig.ctx.watcher.txId;
    rig.ctx.extractedDirty = false;

    const textPath = path.join(rig.tmp, "objectTypes", "Text.json");
    fs.writeFileSync(textPath, fs.readFileSync(textPath, "utf-8") + " ");
    rig.fire("objectTypes/Text.json", 1);

    expect(rig.ctx.watcher.txId).to.equal(base + 1);
    expect(rig.ctx.extractedDirty).to.equal(true);
  });

  it("W3: remove-layer (workflow/layer path) own writes neither bump txId nor mark dirty", async () => {
    rig = await makeRig("w3-");
    // Seed a removable layer, then snapshot so only the handler's write counts.
    applyParsed(rig.tmp, { layouts: { "layouts/Templates Layout.json": [{ op: "add-layer", name: "P277" }] } } as any, {
      regenerate: true,
      log: () => {},
    });
    const before = snapshotTree(rig.tmp);
    const layout = JSON.parse(fs.readFileSync(path.join(rig.tmp, "layouts", "Templates Layout.json"), "utf-8"));
    const cand = layout.layers.find((l: any) => l.name === "P277");
    expect(cand, "seeded layer P277 should exist").to.exist;

    const res: any = await __getHandler("remove-layer")!(
      { layout: "Templates Layout.json", layer: "P277", txId: `default:${rig.ctx.watcher.txId}`, regenerate: true },
      makeExtra(),
    );
    expect(res.isError, res.content?.[0]?.text).to.be.undefined;
    const token = tokenOf(res);
    const changed = rig.fireChanged(before);
    expect(changed).to.include("layouts/Templates Layout.json");

    expect(rig.ctx.watcher.txId).to.equal(token);
    expect(rig.ctx.extractedDirty).to.equal(false);
  });

  it("W4: registrations survive a call whose progress notifications outlast the 5 s TTL", async () => {
    rig = await makeRig("w4-");
    const realNow = Date.now;
    let clock = realNow.call(Date);
    let notifications = 0;
    Date.now = () => clock;
    restores.push(() => {
      Date.now = realNow;
    });
    const extra = {
      signal: new AbortController().signal,
      _meta: { progressToken: "t" },
      sendNotification: async () => {
        notifications++;
        clock += 10_000;
      },
    };
    const start = clock;
    const before = snapshotTree(rig.tmp);
    const res: any = await __getHandler("apply-recipe")!(
      { recipe: W1_RECIPE, txId: `default:${rig.ctx.watcher.txId}`, regenerate: true },
      extra as any,
    );
    expect(res.isError, res.content?.[0]?.text).to.be.undefined;
    const token = tokenOf(res);
    expect(notifications, "the call should have emitted progress notifications").to.be.greaterThan(0);
    expect(clock - start, "the test clock should have moved past the 5 s TTL").to.be.greaterThan(5_000);
    rig.fireChanged(before);

    expect(rig.ctx.watcher.txId).to.equal(token);
    expect(rig.ctx.extractedDirty).to.equal(false);
  });

  it("W5: sync-project (drift > 0) manifest write neither bumps txId beyond the returned one nor fires an external change", async () => {
    rig = await makeRig("w5-");
    fs.copyFileSync(
      path.join(rig.tmp, "layouts", "Templates Layout.json"),
      path.join(rig.tmp, "layouts", "Extra277.json"),
    );
    const before = snapshotTree(rig.tmp);
    const res: any = await __getHandler("sync-project")!({ txId: `default:${rig.ctx.watcher.txId}` }, makeExtra());
    expect(res.isError, res.content?.[0]?.text).to.be.undefined;
    const token = tokenOf(res);
    const changed = rig.fireChanged(before);
    expect(changed).to.deep.equal(["project.c3proj"]);

    expect(rig.ctx.watcher.txId, "live txId should equal the returned counter").to.equal(token);
    expect(rig.ctx.extractedDirty).to.equal(false);
  });

  it("W7: a failed apply (EPERM on replay) still masks the files it did write", async () => {
    rig = await makeRig("w7-");
    restores.push(makeReadOnly(path.join(rig.tmp, "eventSheets", "UI", "Event sheet 2.json")));
    const before = snapshotTree(rig.tmp);
    const recipe = {
      files: {
        "eventSheets/Gameplay/Event sheet 1.json": [{ op: "insert-event", comment: "HOOK1" }],
        "eventSheets/UI/Event sheet 2.json": [{ op: "insert-event", comment: "HOOK2" }],
      },
    };
    const res: any = await __getHandler("apply-recipe")!(
      { recipe: JSON.stringify(recipe), txId: `default:${rig.ctx.watcher.txId}`, regenerate: true },
      makeExtra(),
    );
    expect(res.isError, "the apply should fail on the read-only sheet").to.equal(true);
    const token = tokenOf(res);
    const changed = rig.fireChanged(before);
    expect(changed, "the first sheet should have been written before the failure").to.include(
      "eventSheets/Gameplay/Event sheet 1.json",
    );

    expect(rig.ctx.watcher.txId, "live txId should equal the error response's counter").to.equal(token);
  });

  it("MU12-L3: the production wiring routes the watcher's baseline line to stderr, complete", async function () {
    this.timeout(30_000);
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "l3-"));
    const ops: Array<{ stop?: () => void }> = [];
    const captured: string[] = [];
    const realError = console.error;
    let ctx: ProjectContext | undefined;
    try {
      for (const d of ["layouts", "objectTypes", "eventSheets", "scripts"]) fs.mkdirSync(path.join(root, d));
      fs.writeFileSync(path.join(root, "project.c3proj"), fs.readFileSync(path.join(FIXTURE_DIR, "project.c3proj")));
      ctx = await createProjectContext("l3proj", root);
      const reg = new ProjectRegistry();
      reg.add(ctx);
      __setRegistry(reg);
      console.error = (...a: unknown[]) => {
        captured.push(a.map(String).join(" "));
      };
      ops.push(...(__wireAllProjects() as Array<{ stop?: () => void }>));
      console.error = realError;
      const baseline = captured.filter((l) => l.includes("OptimisticWatcher baseline:") && l.includes("l3proj"));
      expect(baseline, `captured: ${JSON.stringify(captured)}`).to.have.lengthOf(1);
      expect(captured.filter((l) => l.includes("baseline incomplete"))).to.deep.equal([]);
    } finally {
      console.error = realError;
      ctx?.watcher?.stop();
      for (const o of ops) o.stop?.();
      __resetTestState();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("W6: real fs.watch through the production wiring - own writes are silent, an external edit is not", async function () {
    this.timeout(90_000);
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "w6-"));
    const ops: Array<{ stop?: () => void }> = [];
    let ctx: ProjectContext | undefined;
    try {
      // Fresh writes (not cpSync) and NO subdirectory under any watched dir, so
      // this row stays a pure file-level check. Since mcp-utils 0.12.0 a
      // directory event alone is not a change; MU12-R1 covers read-induced
      // events on a tree that does have subfolders.
      for (const d of ["layouts", "objectTypes", "eventSheets", "scripts"]) fs.mkdirSync(path.join(root, d));
      const copy = (rel: string): void =>
        fs.writeFileSync(path.join(root, rel), fs.readFileSync(path.join(FIXTURE_DIR, rel)));
      copy("project.c3proj");
      copy(path.join("layouts", "Templates Layout.json"));
      for (const f of fs.readdirSync(path.join(FIXTURE_DIR, "objectTypes"), { withFileTypes: true }))
        if (f.isFile() && f.name.endsWith(".json")) copy(path.join("objectTypes", f.name));
      for (const f of fs.readdirSync(path.join(FIXTURE_DIR, "scripts"), { withFileTypes: true }))
        if (f.isFile()) copy(path.join("scripts", f.name));
      const subdirs = ["layouts", "objectTypes", "eventSheets", "scripts"].flatMap((d) =>
        fs
          .readdirSync(path.join(root, d), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => `${d}/${e.name}`),
      );
      expect(subdirs, "precondition: no subdirectory under a watched dir").to.deep.equal([]);

      ctx = await createProjectContext("w6", root);
      const reg = new ProjectRegistry();
      reg.add(ctx);
      __setRegistry(reg);
      ops.push(...(__wireAllProjects() as Array<{ stop?: () => void }>));
      await sleep(500);

      // Prime extracted/ so regenerate:true has a baseline.
      const primed: any = await __getHandler("regenerate")!({ project: "w6" }, makeExtra());
      expect(primed.isError, primed.content?.[0]?.text).to.be.undefined;
      await sleep(1000);
      ctx.extractedDirty = false;

      const res: any = await __getHandler("apply-recipe")!(
        {
          project: "w6",
          recipe: JSON.stringify({ layouts: { "layouts/Templates Layout.json": [{ op: "add-layer", name: "P277" }] } }),
          txId: `w6:${ctx.watcher.txId}`,
          regenerate: true,
        },
        makeExtra(),
      );
      expect(res.isError, res.content?.[0]?.text).to.be.undefined;
      const token = Number(/w6:(\d+)/.exec(res.content.map((c: any) => c.text).join("\n"))![1]);
      await sleep(1500);
      expect(ctx.watcher.txId, "settled live txId should equal the returned counter").to.equal(token);
      expect(ctx.extractedDirty).to.equal(false);

      // Positive control: the watcher is alive and an external edit is seen.
      fs.appendFileSync(path.join(root, "layouts", "Templates Layout.json"), " ");
      await sleep(1500);
      expect(ctx.watcher.txId, "external append should bump +1").to.equal(token + 1);
      expect(ctx.extractedDirty).to.equal(true);
    } finally {
      ctx?.watcher?.stop();
      for (const o of ops) o.stop?.();
      __resetTestState();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---- MU12 self-write count rows: events are fired by hand, after the handler returned ----

  const MU12_NEW_SHEET = "eventSheets/MU12New/MU12.json";
  const MU12_NEW_DIR = "eventSheets/MU12New";
  const LAYOUT_ONLY_RECIPE = JSON.stringify({
    layouts: { "layouts/UI/Second Layout.json": [{ op: "add-layer", name: "MU12L" }] },
  });

  async function applyAndToken(r: Rig, recipe: string): Promise<number> {
    const res: any = await __getHandler("apply-recipe")!(
      { recipe, txId: `default:${r.ctx.watcher.txId}`, regenerate: true },
      makeExtra(),
    );
    expect(res.isError, res.content?.[0]?.text).to.be.undefined;
    return tokenOf(res);
  }

  const createRecipe = (): string =>
    JSON.stringify({ files: { [MU12_NEW_SHEET]: { create: true, events: [{ comment: "MU12" }] } } });

  it("MU12-S1: a sheet create in a new subfolder, events forced file first, settles at the returned token and stays clean", async () => {
    rig = await makeRig("mu12-s1-");
    const token = await applyAndToken(rig, createRecipe());
    expect(fs.existsSync(path.join(rig.tmp, MU12_NEW_SHEET))).to.equal(true);
    rig.fire(MU12_NEW_SHEET, 2);
    rig.fire(MU12_NEW_DIR, 2);
    expect(rig.ctx.watcher.txId).to.equal(token);
    expect(rig.ctx.extractedDirty).to.equal(false);
  });

  it("MU12-S2: the same create with events forced dir first settles at token+1 and marks dirty (accepted cost)", async () => {
    rig = await makeRig("mu12-s2-");
    const token = await applyAndToken(rig, createRecipe());
    expect(fs.existsSync(path.join(rig.tmp, MU12_NEW_SHEET))).to.equal(true);
    rig.fire(MU12_NEW_DIR, 2);
    rig.fire(MU12_NEW_SHEET, 2);
    expect(rig.ctx.watcher.txId).to.equal(token + 1);
    expect(rig.ctx.extractedDirty).to.equal(true);
  });

  it("MU12-S3: an in-place layout edit with trusted directory stamps, dir event first, settles at the returned token", async () => {
    rig = await makeRig("mu12-s3-", { delayBeforeStartMs: 1200 });
    const dir = path.join(rig.tmp, "layouts", "UI");
    const ctimeBefore = fs.statSync(dir).ctimeMs;
    const token = await applyAndToken(rig, LAYOUT_ONLY_RECIPE);
    expect(fs.statSync(dir).ctimeMs, "precondition: the directory's ctime is unchanged across the call").to.equal(
      ctimeBefore,
    );
    rig.fire("layouts/UI", 2);
    rig.fire("layouts/UI/Second Layout.json", 2);
    expect(rig.ctx.watcher.txId).to.equal(token);
    expect(rig.ctx.extractedDirty).to.equal(false);
  });

  it("MU12-S4: the same edit with no wait (racy stamps) settles at token+1 - the fresh-tree artifact", async () => {
    rig = await makeRig("mu12-s4-");
    const token = await applyAndToken(rig, LAYOUT_ONLY_RECIPE);
    rig.fire("layouts/UI", 2);
    rig.fire("layouts/UI/Second Layout.json", 2);
    expect(rig.ctx.watcher.txId).to.equal(token + 1);
  });

  it("MU12-M1: list tools plus an event for every source file and subfolder neither bump nor dirty; an external edit does", async () => {
    rig = await makeRig("mu12-m1-", { delayBeforeStartMs: 1200 });
    const r = rig;
    const primed: any = await __getHandler("regenerate")!({}, makeExtra());
    expect(primed.isError, primed.content?.[0]?.text).to.be.undefined;
    const base = r.ctx.watcher.txId;
    r.ctx.extractedDirty = false;

    for (const tool of ["list-event-sheets", "list-layouts"]) {
      const res: any = await __getHandler(tool)!({}, makeExtra());
      expect(res.isError, res.content?.[0]?.text).to.be.undefined;
    }
    const fired: string[] = [];
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(r.tmp, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        fired.push(child);
        if (e.isDirectory()) walk(child);
      }
    };
    for (const d of ["eventSheets", "layouts", "objectTypes", "families", "scripts"])
      if (fs.existsSync(path.join(r.tmp, d))) walk(d);
    fired.push("project.c3proj");
    expect(
      fired.some((f) => fs.statSync(path.join(r.tmp, f)).isDirectory()),
      "precondition: has subfolders",
    ).to.equal(true);
    for (const f of fired) r.fire(f, 2);
    expect(r.ctx.watcher.txId).to.equal(base);
    expect(r.ctx.extractedDirty).to.equal(false);

    // Control: an external edit is still seen.
    const target = path.join(r.tmp, "objectTypes", "Text.json");
    fs.writeFileSync(target, fs.readFileSync(target, "utf-8") + " ");
    r.fire("objectTypes/Text.json", 1);
    expect(r.ctx.watcher.txId).to.equal(base + 1);
    expect(r.ctx.extractedDirty).to.equal(true);
  });

  it("MU12-R2: real fs.watch - the settled delta of a root-level, existing-subfolder and new-subfolder create is 0 or 1", async function () {
    this.timeout(90_000);
    const tmp = copyFixture("mu12-r2-");
    const ops: Array<{ stop?: () => void }> = [];
    let ctx: ProjectContext | undefined;
    try {
      await sleep(1200);
      ctx = await createProjectContext("r2", tmp);
      const reg = new ProjectRegistry();
      reg.add(ctx);
      __setRegistry(reg);
      ops.push(...(__wireAllProjects() as Array<{ stop?: () => void }>));
      await sleep(500);
      const primed: any = await __getHandler("regenerate")!({ project: "r2" }, makeExtra());
      expect(primed.isError, primed.content?.[0]?.text).to.be.undefined;
      await sleep(1500);

      const creates: Array<[string, string]> = [
        ["root-level", "eventSheets/R2Root.json"],
        ["existing subfolder", "eventSheets/Gameplay/R2Sub.json"],
        ["new subfolder", "eventSheets/R2New/R2New.json"],
      ];
      expect(fs.existsSync(path.join(tmp, "eventSheets", "Gameplay")), "precondition: Gameplay exists").to.equal(true);
      const deltas: number[] = [];
      for (const [label, rel] of creates) {
        const res: any = await __getHandler("apply-recipe")!(
          {
            project: "r2",
            recipe: JSON.stringify({ files: { [rel]: { create: true, events: [{ comment: "R2" }] } } }),
            txId: `r2:${ctx.watcher.txId}`,
            regenerate: true,
          },
          makeExtra(),
        );
        expect(res.isError, res.content?.[0]?.text).to.be.undefined;
        const token = Number(/r2:(\d+)/.exec(res.content.map((c: any) => c.text).join("\n"))![1]);
        await sleep(1500);
        const delta = ctx.watcher.txId - token;
        deltas.push(delta);
        process.stdout.write(`MU12-R2 ${label} (${rel}): settled delta = ${delta}\n`);
        expect(delta, `${label} create`).to.be.within(0, 1);
      }
      process.stdout.write(
        `MU12-R2 deltas [root-level, existing subfolder, new subfolder] = ${JSON.stringify(deltas)}\n`,
      );
    } finally {
      ctx?.watcher?.stop();
      for (const o of ops) o.stop?.();
      __resetTestState();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("MU12-R1: real fs.watch, aged atimes - read-induced events on a tree with subfolders are not changes (Windows)", async function () {
    if (process.platform !== "win32") this.skip();
    this.timeout(120_000);
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "mu12-r1-"));
    const ops: Array<{ stop?: () => void }> = [];
    let ctx: ProjectContext | undefined;
    let probe: fs.FSWatcher | undefined;
    try {
      // Fresh writes (not cpSync), with the fixture's own subfolders.
      const copyTree = (rel: string, topLevelOnly = false): void => {
        fs.mkdirSync(path.join(root, rel), { recursive: true });
        for (const e of fs.readdirSync(path.join(FIXTURE_DIR, rel), { withFileTypes: true })) {
          const child = path.join(rel, e.name);
          if (e.isDirectory()) {
            if (!topLevelOnly) copyTree(child);
          } else if (e.isFile()) {
            fs.writeFileSync(path.join(root, child), fs.readFileSync(path.join(FIXTURE_DIR, child)));
          }
        }
      };
      fs.writeFileSync(path.join(root, "project.c3proj"), fs.readFileSync(path.join(FIXTURE_DIR, "project.c3proj")));
      copyTree("layouts");
      copyTree("eventSheets");
      copyTree("objectTypes");
      copyTree("scripts", true);

      const allPaths: Array<{ p: string; dir: boolean }> = [];
      const collect = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          allPaths.push({ p, dir: e.isDirectory() });
          if (e.isDirectory()) collect(p);
        }
      };
      for (const d of ["layouts", "eventSheets", "objectTypes", "scripts"]) {
        allPaths.push({ p: path.join(root, d), dir: true });
        collect(path.join(root, d));
      }
      allPaths.push({ p: path.join(root, "project.c3proj"), dir: false });
      const subfolders = allPaths.filter(
        (e) => e.dir && !["layouts", "eventSheets", "objectTypes", "scripts"].includes(path.basename(e.p)),
      );
      expect(subfolders.length, "precondition: the project has subfolders").to.be.greaterThan(0);

      ctx = await createProjectContext("r1", root);
      const reg = new ProjectRegistry();
      reg.add(ctx);
      __setRegistry(reg);
      ops.push(...(__wireAllProjects() as Array<{ stop?: () => void }>));
      await sleep(500);
      const primed: any = await __getHandler("regenerate")!({ project: "r1" }, makeExtra());
      expect(primed.isError, primed.content?.[0]?.text).to.be.undefined;
      await sleep(1500);
      const base = ctx.watcher.txId;
      ctx.extractedDirty = false;

      // Age atime to now - 2 h, keeping mtime. Before the settle: utimes may move ctime.
      const aged = new Date(Date.now() - 2 * 3600_000);
      for (const { p } of allPaths) fs.utimesSync(p, aged, fs.statSync(p).mtime);
      await sleep(1600);
      expect(ctx.watcher.txId, "ageing atimes must not bump txId").to.equal(base);

      let probeEvents = 0;
      probe = fs.watch(root, { recursive: true }, () => {
        probeEvents++;
      });
      for (const { p, dir } of allPaths) {
        if (dir) fs.readdirSync(p);
        else fs.readFileSync(p);
      }
      const listed: any = await __getHandler("list-event-sheets")!({ project: "r1" }, makeExtra());
      expect(listed.isError, listed.content?.[0]?.text).to.be.undefined;
      await sleep(1500);
      process.stdout.write(`MU12-R1 probe saw ${probeEvents} read-induced events\n`);
      if (probeEvents === 0) this.skip(); // no read events: last-access updates off

      expect(ctx.watcher.txId, "reads must not bump txId").to.equal(base);
      expect(ctx.extractedDirty).to.equal(false);

      const inSub = allPaths.find(
        (e) =>
          !e.dir &&
          e.p.includes(`${path.sep}eventSheets${path.sep}`) &&
          path.dirname(e.p) !== path.join(root, "eventSheets"),
      );
      expect(inSub, "precondition: a file inside an eventSheets subfolder").to.exist;
      fs.appendFileSync(inSub!.p, " ");
      await sleep(1500);
      expect(ctx.watcher.txId, "external append should bump +1").to.equal(base + 1);
      expect(ctx.extractedDirty).to.equal(true);
    } finally {
      probe?.close();
      ctx?.watcher?.stop();
      for (const o of ops) o.stop?.();
      __resetTestState();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
