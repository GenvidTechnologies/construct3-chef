import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { diffAddonAces, formatAceDiff, resolveAceSource } from "../../src/c3/addonAceDiff.js";
import type { AceEntry } from "../../src/c3/c3Reference.js";

const ACE_DIFF_FIXTURE_ROOT = path.resolve("test/fixtures/addon-ace-diff");

function ace(over: Partial<AceEntry> & Pick<AceEntry, "id" | "kind" | "objectClass">): AceEntry {
  return {
    source: "addon",
    params: [],
    ...over,
  };
}

describe("addonAceDiff", () => {
  describe("diffAddonAces", () => {
    it("D1: added-only — B has an extra ACE", () => {
      const a: AceEntry[] = [ace({ id: "foo", kind: "action", objectClass: "Widget" })];
      const b: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget" }),
        ace({ id: "bar", kind: "action", objectClass: "Widget" }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.added.map((e) => e.id)).to.deep.equal(["bar"]);
      expect(diff.removed).to.deep.equal([]);
      expect(diff.changed).to.deep.equal([]);
      expect(diff.unchangedCount).to.equal(1);
    });

    it("D2: removed-only — A has an ACE missing from B", () => {
      const a: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget" }),
        ace({ id: "bar", kind: "action", objectClass: "Widget" }),
      ];
      const b: AceEntry[] = [ace({ id: "foo", kind: "action", objectClass: "Widget" })];

      const diff = diffAddonAces(a, b);
      expect(diff.added).to.deep.equal([]);
      expect(diff.removed.map((e) => e.id)).to.deep.equal(["bar"]);
      expect(diff.changed).to.deep.equal([]);
      expect(diff.unchangedCount).to.equal(1);
    });

    it("D3: param added — same ACE, B has an extra param", () => {
      const a: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget", params: [{ name: "rate", type: "number" }] }),
      ];
      const b: AceEntry[] = [
        ace({
          id: "foo",
          kind: "action",
          objectClass: "Widget",
          params: [
            { name: "rate", type: "number" },
            { name: "unit", type: "string" },
          ],
        }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.changed).to.have.length(1);
      expect(diff.changed[0].before.params).to.deep.equal([{ name: "rate", type: "number" }]);
      expect(diff.changed[0].after.params).to.deep.equal([
        { name: "rate", type: "number" },
        { name: "unit", type: "string" },
      ]);
      expect(diff.unchangedCount).to.equal(0);
    });

    it("D4: param removed — same ACE, B drops a param", () => {
      const a: AceEntry[] = [
        ace({
          id: "foo",
          kind: "action",
          objectClass: "Widget",
          params: [
            { name: "rate", type: "number" },
            { name: "unit", type: "string" },
          ],
        }),
      ];
      const b: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget", params: [{ name: "rate", type: "number" }] }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.changed).to.have.length(1);
      expect(diff.changed[0].before.params).to.have.length(2);
      expect(diff.changed[0].after.params).to.have.length(1);
    });

    it("D5: param type changed — same name, different type", () => {
      const a: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget", params: [{ name: "rate", type: "number" }] }),
      ];
      const b: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget", params: [{ name: "rate", type: "string" }] }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.changed).to.have.length(1);
      expect(diff.changed[0].before.params[0].type).to.equal("number");
      expect(diff.changed[0].after.params[0].type).to.equal("string");
    });

    it("D6: param reordered — same set, different order counts as changed", () => {
      const a: AceEntry[] = [
        ace({
          id: "foo",
          kind: "action",
          objectClass: "Widget",
          params: [
            { name: "rate", type: "number" },
            { name: "unit", type: "string" },
          ],
        }),
      ];
      const b: AceEntry[] = [
        ace({
          id: "foo",
          kind: "action",
          objectClass: "Widget",
          params: [
            { name: "unit", type: "string" },
            { name: "rate", type: "number" },
          ],
        }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.changed).to.have.length(1);
      expect(diff.unchangedCount).to.equal(0);
    });

    it("D7: fully unchanged — identical lists yield only unchangedCount", () => {
      const a: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget", params: [{ name: "rate", type: "number" }] }),
        ace({ id: "is-ready", kind: "condition", objectClass: "Widget" }),
      ];
      const b: AceEntry[] = [
        ace({ id: "foo", kind: "action", objectClass: "Widget", params: [{ name: "rate", type: "number" }] }),
        ace({ id: "is-ready", kind: "condition", objectClass: "Widget" }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.added).to.deep.equal([]);
      expect(diff.removed).to.deep.equal([]);
      expect(diff.changed).to.deep.equal([]);
      expect(diff.unchangedCount).to.equal(2);
    });

    it("D8: mixed — added, removed, changed, and unchanged all present, sorted by key", () => {
      const a: AceEntry[] = [
        ace({ id: "gone", kind: "action", objectClass: "Widget" }),
        ace({ id: "same", kind: "condition", objectClass: "Widget" }),
        ace({ id: "tweak", kind: "action", objectClass: "Widget", params: [{ name: "x", type: "number" }] }),
      ];
      const b: AceEntry[] = [
        ace({ id: "same", kind: "condition", objectClass: "Widget" }),
        ace({ id: "tweak", kind: "action", objectClass: "Widget", params: [{ name: "x", type: "string" }] }),
        ace({ id: "fresh", kind: "expression", objectClass: "Widget" }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.added.map((e) => e.id)).to.deep.equal(["fresh"]);
      expect(diff.removed.map((e) => e.id)).to.deep.equal(["gone"]);
      expect(diff.changed.map((c) => c.after.id)).to.deep.equal(["tweak"]);
      expect(diff.unchangedCount).to.equal(1);
    });

    it("D9: distinguishes ACEs of the same id but different kind", () => {
      const a: AceEntry[] = [ace({ id: "value", kind: "expression", objectClass: "Widget" })];
      const b: AceEntry[] = [
        ace({ id: "value", kind: "expression", objectClass: "Widget" }),
        ace({ id: "value", kind: "condition", objectClass: "Widget" }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.added).to.have.length(1);
      expect(diff.added[0].kind).to.equal("condition");
      expect(diff.unchangedCount).to.equal(1);
    });

    // ── Regression: objectClass must NOT participate in identity ────────────
    //
    // readAddonAces/mapAcesJsonToEntries stamp every ACE in an aces.json with
    // the addon's *name* (the .c3addon filename basename, or discovered id)
    // as objectClass — constant within one addon, but commonly differing
    // between two versions of the same addon (e.g. GCore-1.0.c3addon vs
    // GCore-2.0.c3addon). Keying on objectClass too would make every ACE of a
    // renamed/re-versioned addon show as removed+added instead of
    // unchanged/changed. Lock (kind, id)-only identity here.

    it("D10: same (kind,id) with DIFFERENT objectClass on each side is unchanged, not added+removed", () => {
      const a: AceEntry[] = [
        ace({
          id: "login",
          kind: "action",
          objectClass: "GCore-1.0",
          params: [{ name: "token", type: "string" }],
        }),
      ];
      const b: AceEntry[] = [
        ace({
          id: "login",
          kind: "action",
          objectClass: "GCore-2.0",
          params: [{ name: "token", type: "string" }],
        }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.added).to.deep.equal([]);
      expect(diff.removed).to.deep.equal([]);
      expect(diff.changed).to.deep.equal([]);
      expect(diff.unchangedCount).to.equal(1);
    });

    it("D11: same (kind,id) with DIFFERENT objectClass AND different params is changed-by-params, not added+removed", () => {
      const a: AceEntry[] = [
        ace({
          id: "login",
          kind: "action",
          objectClass: "GCore-1.0",
          params: [
            { name: "token", type: "string" },
            { name: "region", type: "string" },
          ],
        }),
      ];
      const b: AceEntry[] = [
        ace({
          id: "login",
          kind: "action",
          objectClass: "GCore-2.0",
          params: [{ name: "token", type: "string" }],
        }),
      ];

      const diff = diffAddonAces(a, b);
      expect(diff.added).to.deep.equal([]);
      expect(diff.removed).to.deep.equal([]);
      expect(diff.changed).to.have.length(1);
      expect(diff.changed[0].before.objectClass).to.equal("GCore-1.0");
      expect(diff.changed[0].after.objectClass).to.equal("GCore-2.0");
      expect(diff.changed[0].before.params).to.deep.equal([
        { name: "token", type: "string" },
        { name: "region", type: "string" },
      ]);
      expect(diff.changed[0].after.params).to.deep.equal([{ name: "token", type: "string" }]);
      expect(diff.unchangedCount).to.equal(0);
    });
  });

  describe("formatAceDiff", () => {
    it("F1: empty diff renders the single no-differences line", () => {
      const diff = diffAddonAces([], []);
      expect(formatAceDiff(diff, "A", "B")).to.equal("No ACE differences.");
    });

    it("F2: renders header + sections for a mixed diff", () => {
      const a: AceEntry[] = [
        ace({ id: "gone", kind: "action", objectClass: "Widget" }),
        ace({ id: "tweak", kind: "action", objectClass: "Widget", params: [{ name: "x", type: "number" }] }),
      ];
      const b: AceEntry[] = [
        ace({ id: "tweak", kind: "action", objectClass: "Widget", params: [{ name: "x", type: "string" }] }),
        ace({ id: "fresh", kind: "expression", objectClass: "Widget" }),
      ];

      const diff = diffAddonAces(a, b);
      const output = formatAceDiff(diff, "OldAddon", "NewAddon");

      expect(output).to.include("diff-addon-aces: OldAddon → NewAddon");
      expect(output).to.include("+1 added, -1 removed, ~1 changed");
      expect(output).to.include("Added (A):");
      expect(output).to.include("[expression] Widget.fresh()");
      expect(output).to.include("Removed (R):");
      expect(output).to.include("[action] Widget.gone()");
      expect(output).to.include("Changed (C):");
      expect(output).to.include("[action] Widget.tweak");
      expect(output).to.include("- (x)");
      expect(output).to.include("+ (x)");
    });
  });

  describe("resolveAceSource", () => {
    it("S1: an unresolvable argument returns an error, never throws", () => {
      expect(() => resolveAceSource(process.cwd(), "definitely-not-a-real-addon-id")).to.not.throw();
      const result = resolveAceSource(process.cwd(), "definitely-not-a-real-addon-id");
      expect(result).to.deep.equal({ error: "addon source not found: definitely-not-a-real-addon-id" });
    });
  });

  // ── Integration: real .c3addon archives via resolveAceSource + diffAddonAces ──
  //
  // GCoreV1.c3addon / GCoreV2.c3addon (test/fixtures/addon-ace-diff/) share the
  // same addon.json `id` ("GCore") but are packaged under version-suffixed
  // filenames, so resolveAceSource resolves both sides' objectClass to the
  // real stable id "GCore" — proving (kind,id) keying works end-to-end even
  // when the two archives could ALSO have resolved to differing objectClass
  // values (the GCore-1.0.c3addon vs GCore-2.0.c3addon motivating case).

  describe("resolveAceSource + diffAddonAces (fixture archives)", () => {
    const v1Path = path.join(ACE_DIFF_FIXTURE_ROOT, "addons", "plugin", "GCoreV1.c3addon");
    const v2Path = path.join(ACE_DIFF_FIXTURE_ROOT, "addons", "plugin", "GCoreV2.c3addon");

    it("I1: resolveAceSource reads real aces.json out of both archives via the zip path", () => {
      const v1 = resolveAceSource(ACE_DIFF_FIXTURE_ROOT, v1Path);
      const v2 = resolveAceSource(ACE_DIFF_FIXTURE_ROOT, v2Path);

      expect("error" in v1).to.be.false;
      expect("error" in v2).to.be.false;
      const okV1 = v1 as { label: string; aces: AceEntry[] };
      const okV2 = v2 as { label: string; aces: AceEntry[] };

      expect(okV1.label).to.equal("GCoreV1.c3addon");
      expect(okV2.label).to.equal("GCoreV2.c3addon");
      expect(okV1.aces.length).to.be.greaterThan(0);
      expect(okV2.aces.length).to.be.greaterThan(0);

      // Both resolve to the same real addon id, despite the version-suffixed
      // archive filenames — this is what makes the (kind,id)-only identity
      // key necessary rather than incidental.
      expect(okV1.aces.every((a) => a.objectClass === "GCore")).to.be.true;
      expect(okV2.aces.every((a) => a.objectClass === "GCore")).to.be.true;
    });

    it("I2: diffAddonAces over the two real archives reports every expected bucket", () => {
      const v1 = resolveAceSource(ACE_DIFF_FIXTURE_ROOT, v1Path) as { label: string; aces: AceEntry[] };
      const v2 = resolveAceSource(ACE_DIFF_FIXTURE_ROOT, v2Path) as { label: string; aces: AceEntry[] };

      const diff = diffAddonAces(v1.aces, v2.aces);

      // Added: sdk-version expression, V2-only.
      expect(diff.added.map((a) => a.id)).to.deep.equal(["sdk-version"]);
      expect(diff.added[0].kind).to.equal("expression");

      // Removed: is-legacy-account condition, V1-only.
      expect(diff.removed.map((a) => a.id)).to.deep.equal(["is-legacy-account"]);
      expect(diff.removed[0].kind).to.equal("condition");

      // Changed: login action drops its `region` param in V2.
      expect(diff.changed).to.have.length(1);
      const loginChange = diff.changed[0];
      expect(loginChange.before.id).to.equal("login");
      expect(loginChange.before.params).to.deep.equal([
        { name: "token", type: "string" },
        { name: "region", type: "string" },
      ]);
      expect(loginChange.after.params).to.deep.equal([{ name: "token", type: "string" }]);

      // Unchanged: sync action, identical (empty) params on both sides.
      expect(diff.unchangedCount).to.be.at.least(1);
    });

    it("I3: formatAceDiff renders the fixture diff's section headers + before/after param lines", () => {
      const v1 = resolveAceSource(ACE_DIFF_FIXTURE_ROOT, v1Path) as { label: string; aces: AceEntry[] };
      const v2 = resolveAceSource(ACE_DIFF_FIXTURE_ROOT, v2Path) as { label: string; aces: AceEntry[] };

      const diff = diffAddonAces(v1.aces, v2.aces);
      const output = formatAceDiff(diff, v1.label, v2.label);

      expect(output).to.include("diff-addon-aces: GCoreV1.c3addon → GCoreV2.c3addon");
      expect(output).to.include("Added (A):");
      expect(output).to.include("[expression] GCore.sdk-version()");
      expect(output).to.include("Removed (R):");
      expect(output).to.include("[condition] GCore.is-legacy-account()");
      expect(output).to.include("Changed (C):");
      expect(output).to.include("[action] GCore.login");
      expect(output).to.include("- (token, region)");
      expect(output).to.include("+ (token)");
    });
  });
});
