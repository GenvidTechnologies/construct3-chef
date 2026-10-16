import { describe, it, beforeEach, afterEach } from "mocha";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExpectedChanges, contentFingerprint, type WatcherFactory } from "@genvidtech/mcp-utils";
import {
  createSourceWatcher,
  countWatchedEntries,
  ledgerCapacity,
  editorLocalAwareFingerprint,
  routeWatcherLog,
} from "../../src/mcp/sourceWatcher.js";

/**
 * Verifies the OptimisticWatcher wiring before it replaces server.ts's inline
 * txId/suppress/expected machinery. Uses an injected factory so fs events are
 * simulated deterministically (no real fs.watch races).
 */
describe("createSourceWatcher", () => {
  let root: string;
  let expected: ExpectedChanges;
  let fired: string[];
  // Captured (target -> onEvent) from the injected factory.
  let onEventByTarget: Map<string, (filename: string) => void>;
  let factory: WatcherFactory;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "c3chef-watcher-"));
    mkdirSync(path.join(root, "eventSheets"));
    mkdirSync(path.join(root, "layouts"));
    mkdirSync(path.join(root, "objectTypes"));
    mkdirSync(path.join(root, "scripts"));
    // Deliberately omit families/ to exercise the existsSync filter (scripts/
    // is now needed to exercise the editor-local exactNames test below).
    writeFileSync(path.join(root, "project.c3proj"), "{}");

    expected = new ExpectedChanges();
    fired = [];
    onEventByTarget = new Map();
    factory = (target, onEvent) => {
      onEventByTarget.set(path.resolve(target), onEvent);
      return { close: () => {} };
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function build() {
    const watcher = createSourceWatcher({
      projectRoot: root,
      expected,
      onSourceChange: (p) => fired.push(p),
      watcherFactory: factory,
    });
    watcher.start();
    return watcher;
  }

  /** Simulate an fs event for `file` under watched `target`. */
  function emit(target: string, file: string) {
    const onEvent = onEventByTarget.get(path.resolve(root, target));
    assert.ok(onEvent, `no watcher registered for ${target}`);
    onEvent(path.resolve(root, target, file));
  }

  it("watches existing source dirs + project.c3proj, skips missing dirs", () => {
    build();
    const targets = [...onEventByTarget.keys()];
    assert.ok(targets.includes(path.resolve(root, "eventSheets")));
    assert.ok(targets.includes(path.resolve(root, "layouts")));
    assert.ok(targets.includes(path.resolve(root, "objectTypes")));
    assert.ok(targets.includes(path.resolve(root, "scripts")));
    assert.ok(targets.includes(path.resolve(root, "project.c3proj")));
    assert.ok(!targets.includes(path.resolve(root, "families")));
  });

  it("external source change bumps txId and fires onSourceChange", () => {
    const w = build();
    assert.equal(w.txId, 0);
    emit("eventSheets", "Foo.json");
    assert.equal(w.txId, 1);
    assert.deepEqual(fired, [path.resolve(root, "eventSheets", "Foo.json")]);
  });

  it("external project.c3proj change bumps txId but does NOT fire onSourceChange", () => {
    const w = build();
    const onEvent = onEventByTarget.get(path.resolve(root, "project.c3proj"));
    assert.ok(onEvent);
    // start() primed the baseline from "{}"; different bytes make this a change.
    writeFileSync(path.join(root, "project.c3proj"), '{"changed":true}');
    onEvent(path.resolve(root, "project.c3proj"));
    assert.equal(w.txId, 1);
    assert.deepEqual(fired, []);
  });

  // ADR 0018: editor-local paths are dropped at the watcher factory, before
  // OptimisticWatcher.handleEvent ever sees them, so neither txId bumps nor
  // onSourceChange fires. One test per isEditorLocalPath dimension — a
  // combined test could not say which mechanism regressed.

  it("editor-local uistate/ directory segment neither bumps txId nor fires onSourceChange", () => {
    const w = build();
    emit("layouts", path.join("uistate", "foo.json"));
    assert.equal(w.txId, 0);
    assert.deepEqual(fired, []);
  });

  it("editor-local *.uistate.json file suffix neither bumps txId nor fires onSourceChange", () => {
    const w = build();
    emit("layouts", "Main.uistate.json");
    assert.equal(w.txId, 0);
    assert.deepEqual(fired, []);
  });

  it("editor-local exact tsconfig.json name neither bumps txId nor fires onSourceChange", () => {
    const w = build();
    emit("scripts", "tsconfig.json");
    assert.equal(w.txId, 0);
    assert.deepEqual(fired, []);
  });

  it("a pre-registered (expected) self-write is suppressed", () => {
    const w = build();
    const target = path.resolve(root, "layouts", "Main.json");
    w.expect(target);
    emit("layouts", "Main.json");
    assert.equal(w.txId, 0, "expected self-write must not bump txId");
    assert.deepEqual(fired, []);
  });

  it("events during suppress() are dropped", async () => {
    const w = build();
    await w.suppress(async () => {
      emit("objectTypes", "Sprite.json");
    });
    assert.equal(w.txId, 0, "suppressed write must not bump txId");
    assert.deepEqual(fired, []);
  });

  it("bump() increments txId (cancelled-write idiom)", () => {
    const w = build();
    w.bump();
    assert.equal(w.txId, 1);
  });

  // mcp-utils 0.7.0 added Layer 3 to OptimisticWatcher — a per-path
  // content-fingerprint ledger (ObservedState) that collapses a duplicate
  // filesystem event for unchanged content, fixing a Windows/NTFS defect
  // where a single writeFileSync delivers two fs.watch events. Since 0.12.0
  // start() primes that ledger from the real directories, so a file that
  // exists before build() is baseline and an event for it unchanged is not a
  // change. Both tests below therefore write the file AFTER build().

  it("a duplicate event for unchanged content bumps txId only once", () => {
    const w = build();
    const target = path.join(root, "eventSheets", "Dup.json");
    writeFileSync(target, '{"a":1}');
    emit("eventSheets", "Dup.json");
    assert.equal(w.txId, 1);
    emit("eventSheets", "Dup.json");
    assert.equal(w.txId, 1, "duplicate event for unchanged content must not bump again");
    assert.equal(fired.length, 1);
  });

  // Deliberately fires no duplicate event: it guards against over-collapsing
  // (a genuinely changed write must still bump). Do not merge this with the
  // test above — keeping it duplicate-free is what makes "which assertion
  // went red" unambiguous.
  it("a genuinely changed write still bumps", () => {
    const w = build();
    const target = path.join(root, "eventSheets", "Changed.json");
    writeFileSync(target, '{"a":1}');
    emit("eventSheets", "Changed.json");
    assert.equal(w.txId, 1);
    writeFileSync(target, '{"a":2}');
    emit("eventSheets", "Changed.json");
    assert.equal(w.txId, 2);
  });
});

describe("sourceWatcher ledger helpers", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "c3chef-ledger-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("MU12-C1: countWatchedEntries counts files and subdirectories at any depth, and sizes the ledger", () => {
    mkdirSync(path.join(root, "eventSheets", "sub", "deep"), { recursive: true });
    writeFileSync(path.join(root, "eventSheets", "a.json"), "{}");
    writeFileSync(path.join(root, "eventSheets", "sub", "deep", "b.json"), "{}");
    writeFileSync(path.join(root, "eventSheets", "Foo.uistate.json"), "{}");
    mkdirSync(path.join(root, "scripts", "uistate"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "uistate", "s.json"), "{}");
    writeFileSync(path.join(root, "project.c3proj"), "{}");

    const targets = [
      path.join(root, "eventSheets"),
      path.join(root, "scripts"),
      path.join(root, "project.c3proj"),
      path.join(root, "missing"),
    ];
    // eventSheets/: a.json, sub, sub/deep, sub/deep/b.json, Foo.uistate.json = 5 (root itself not counted)
    // scripts/: uistate, uistate/s.json = 2 (editor-local paths are counted)
    // project.c3proj (file target) = 1
    // missing (nonexistent target) = 0
    assert.equal(countWatchedEntries(targets), 5 + 2 + 1 + 0);
    assert.equal(ledgerCapacity(99), 10000);
    assert.equal(ledgerCapacity(2741), 10964);
  });

  it("editorLocalAwareFingerprint hashes source files and reports editor-local ones absent", () => {
    mkdirSync(path.join(root, "eventSheets"));
    const src = path.join(root, "eventSheets", "a.json");
    const local = path.join(root, "eventSheets", "Foo.uistate.json");
    writeFileSync(src, "one");
    writeFileSync(local, "x");
    const fp = editorLocalAwareFingerprint(root);
    assert.equal(fp(local), "absent");
    assert.equal(fp(src), contentFingerprint(src));
    const before = fp(src);
    writeFileSync(src, "two");
    assert.notEqual(fp(src), before);
  });

  it("MU12-L1: routeWatcherLog routes baseline summary to info, incomplete/failed to warning, others to null", () => {
    assert.deepEqual(routeWatcherLog(["OptimisticWatcher baseline: 78 files, 20 directories"]), {
      level: "info",
      message: "OptimisticWatcher baseline: 78 files, 20 directories",
    });
    assert.equal(
      routeWatcherLog(["OptimisticWatcher baseline incomplete: size the ledger to at least files plus directories"])
        ?.level,
      "warning",
    );
    const failed = routeWatcherLog(["OptimisticWatcher baseline failed, continuing without:", new Error("boom")]);
    assert.equal(failed?.level, "warning");
    assert.match(failed!.message, /^OptimisticWatcher baseline failed, continuing without: .*boom/);
    assert.equal(routeWatcherLog(["suppressed (L1):", "x"]), null);
  });
});
