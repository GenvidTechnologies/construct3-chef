import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  findLayoutScaffoldConflicts,
  findSpriteScaffoldConflicts,
  formatScaffoldRefusal,
  type ScaffoldConflict,
} from "../../src/c3/scaffoldGuard.js";

// #254: scaffold-layout / scaffold-sprite must refuse to overwrite or collide with existing
// project content. These are the unit rows for the conflict collectors and the shared
// formatter; every row builds a synthetic temp project (the canonical fixture is never touched).

describe("scaffoldGuard (#254)", () => {
  let root: string;
  const layoutsDir = () => path.join(root, "layouts");
  const objectTypesDir = () => path.join(root, "objectTypes");
  const imagesDir = () => path.join(root, "images");

  /** Write a file (relative to root) with throwaway content, creating parent dirs. */
  function put(rel: string, content = "{}"): string {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-scaffold-guard-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("findLayoutScaffoldConflicts", () => {
    it("U1: an existing output path is an output-exists conflict", () => {
      mkdirSync(layoutsDir(), { recursive: true });
      const out = put("eventSheets/S.json");

      const got = findLayoutScaffoldConflicts(root, layoutsDir(), out);

      expect(got).to.deep.equal([{ relPath: "eventSheets/S.json", reason: "output-exists" }]);
    });

    it("U2: a different layout with the same basename in another folder is a layout-name conflict", () => {
      put("layouts/Gameplay/Main Layout.json");
      const out = path.join(layoutsDir(), "New", "Main Layout.json");
      expect(existsSync(out)).to.be.false;

      const got = findLayoutScaffoldConflicts(root, layoutsDir(), out);

      expect(got).to.deep.equal([{ relPath: "layouts/Gameplay/Main Layout.json", reason: "layout-name" }]);
    });

    it("U3: output == an existing layout reports exactly one output-exists entry (deduped)", () => {
      const out = put("layouts/A/X.json");

      const got = findLayoutScaffoldConflicts(root, layoutsDir(), out);

      expect(got).to.have.length(1);
      expect(got[0]).to.deep.equal({ relPath: "layouts/A/X.json", reason: "output-exists" });
    });
  });

  describe("findSpriteScaffoldConflicts", () => {
    it("U5: an existing flat objectTypes/<name>.json is an output-exists conflict (even for an editor-local name)", () => {
      put("objectTypes/tsconfig.json");

      const got = findSpriteScaffoldConflicts(root, objectTypesDir(), imagesDir(), "Src", "tsconfig");

      expect(got).to.deep.equal([{ relPath: "objectTypes/tsconfig.json", reason: "output-exists" }]);
    });

    it("U5b: on a case-insensitive filesystem, Text.json collides with name 'text'", function () {
      put("objectTypes/CaseProbe.json");
      if (!existsSync(path.join(objectTypesDir(), "caseprobe.json"))) {
        this.skip(); // case-sensitive filesystem: the flat existsSync does not match
      }
      put("objectTypes/Text.json");

      const got = findSpriteScaffoldConflicts(root, objectTypesDir(), imagesDir(), "Src", "text");

      expect(got).to.have.length(1);
      expect(got[0].reason).to.equal("output-exists");
      expect(got[0].relPath.toLowerCase()).to.equal("objecttypes/text.json");
    });

    it("U6: an objectType with the same name in a subfolder is an objectType-name conflict", () => {
      put("objectTypes/sub/Dup.json");

      const got = findSpriteScaffoldConflicts(root, objectTypesDir(), imagesDir(), "Src", "Dup");

      expect(got).to.deep.equal([{ relPath: "objectTypes/sub/Dup.json", reason: "objectType-name" }]);
    });

    it("U7: an existing image-copy target is an image-target conflict (name 'Dst' and 'DST' alike)", () => {
      put("images/src-a-000.png", "x");
      put("images/dst-a-000.png", "y");

      const expected: ScaffoldConflict[] = [{ relPath: "images/dst-a-000.png", reason: "image-target" }];
      expect(findSpriteScaffoldConflicts(root, objectTypesDir(), imagesDir(), "Src", "Dst")).to.deep.equal(expected);
      expect(findSpriteScaffoldConflicts(root, objectTypesDir(), imagesDir(), "Src", "DST")).to.deep.equal(expected);
    });

    it("U8: a project with no images/ directory does not throw and reports no image conflicts", () => {
      put("objectTypes/Src.json");
      expect(existsSync(imagesDir())).to.be.false;

      const got = findSpriteScaffoldConflicts(root, objectTypesDir(), imagesDir(), "Src", "Fresh");

      expect(got).to.deep.equal([]);
    });
  });

  describe("formatScaffoldRefusal", () => {
    it("U9: lists every conflict with a count header, POSIX paths and the nothing-written line", () => {
      const conflicts: ScaffoldConflict[] = [
        { relPath: "objectTypes/sub/Dup.json", reason: "objectType-name" },
        { relPath: "images/dst-a-000.png", reason: "image-target" },
        { relPath: "objectTypes/Dup.json", reason: "output-exists" },
      ];

      const msg = formatScaffoldRefusal("scaffold-sprite", conflicts);

      expect(msg).to.include("scaffold-sprite refused: 3 conflicting path(s)");
      expect(msg).to.include("Nothing was written.");
      const bullets = msg.split("\n").filter((l) => l.startsWith("  - "));
      expect(bullets).to.have.length(3);
      for (const c of conflicts) expect(msg, `message must name ${c.relPath}`).to.include(c.relPath);
      expect(msg).to.not.include("\\");
    });
  });
});
