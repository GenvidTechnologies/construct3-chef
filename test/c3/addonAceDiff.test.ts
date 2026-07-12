import { describe, it } from "mocha";
import { expect } from "chai";
import { diffAddonAces, formatAceDiff, resolveAceSource } from "../../src/c3/addonAceDiff.js";
import type { AceEntry } from "../../src/c3/c3Reference.js";

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
});
