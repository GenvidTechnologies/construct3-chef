import { describe, it } from "mocha";
import { assert } from "chai";
import { hasEditorLocalSegment, isEditorLocalPathUnder } from "../../src/c3/editorLocal.js";

// EDITOR_LOCAL_EXCLUSIONS has three independent mechanisms — dirs (["uistate",
// "ts-defs"]), fileSuffixes ([".uistate.json"]), and exactNames
// (["tsconfig.json"]) — so tests are split one per dimension, following the
// pattern established in test/c3/includeTree.test.ts. A combined test could
// not say which mechanism regressed. See ADR docs/decisions/0016.

describe("hasEditorLocalSegment", () => {
  it("dirs: flags a uistate/ segment", () => {
    assert.isTrue(hasEditorLocalSegment("layouts/uistate/Main.instancesBar.json"));
  });

  it("dirs: flags a ts-defs/ segment", () => {
    assert.isTrue(hasEditorLocalSegment("scripts/ts-defs/instanceTypes.d.ts"));
  });

  it("fileSuffixes: flags a *.uistate.json basename", () => {
    assert.isTrue(hasEditorLocalSegment("eventSheets/Foo.uistate.json"));
  });

  it("exactNames: flags an exact tsconfig.json basename", () => {
    assert.isTrue(hasEditorLocalSegment("scripts/tsconfig.json"));
  });

  it("flags an editor-local segment nested neither first nor last", () => {
    assert.isTrue(hasEditorLocalSegment("layouts/uistate/sub/foo.json"));
  });

  it("does not flag ordinary source paths", () => {
    assert.isFalse(hasEditorLocalSegment("eventSheets/Foo.json"));
    assert.isFalse(hasEditorLocalSegment("layouts/Main.json"));
  });

  it("flags a normal basename under an editor-local directory (not basename-only)", () => {
    // Foo.json is itself an ordinary source-looking name; it is the uistate/
    // ancestor segment that must trip the classification.
    assert.isTrue(hasEditorLocalSegment("layouts/uistate/Foo.json"));
  });

  it("handles backslash-separated paths", () => {
    assert.isTrue(hasEditorLocalSegment("layouts\\uistate\\Main.instancesBar.json"));
    assert.isFalse(hasEditorLocalSegment("eventSheets\\Foo.json"));
  });

  it("fails open for a path outside the root (leading .. segments)", () => {
    assert.isFalse(hasEditorLocalSegment("../outside/Foo.json"));
  });
});

describe("isEditorLocalPathUnder", () => {
  it("relativizes an absolute path against the root, then classifies it", () => {
    assert.isTrue(isEditorLocalPathUnder("/project", "/project/layouts/uistate/Main.instancesBar.json"));
    assert.isFalse(isEditorLocalPathUnder("/project", "/project/layouts/Main.json"));
  });
});
