import { describe, it } from "mocha";
import { expect } from "chai";
import type { AcesModel, AceExpression, ExpressionReferenceToken } from "@genvidtech/c3source";
import { createPluginUsageMatcher, createBehaviorUsageMatcher } from "../../src/c3/addonAceUsage.js";
import type { ObjectDefn } from "../../src/c3/projectObjects.js";

// ── Synthetic-data helpers ────────────────────────────────────────────────────

function expr(id: string, expressionName: string): AceExpression {
  return { kind: "expression", category: "account", id, expressionName, returnType: "number", params: [] };
}

function model(...expressions: AceExpression[]): AcesModel {
  return { actions: [], conditions: [], expressions };
}

/** Build a synthetic reference token (the fields matchExpression reads). */
function ref(objectName: string, memberName: string, behaviorName?: string): ExpressionReferenceToken {
  return { kind: "reference", objectName, behaviorName, memberName, isCall: true, start: 0, end: 0 };
}

const accountObject: ObjectDefn = {
  name: "Account",
  kind: "objectType",
  pluginId: "GCore",
  members: [],
  behaviors: [],
  effectTypes: [],
};

// A family carrying its own GTrack behavior instance named "Track", with member "Text".
const trackedFamily: ObjectDefn = {
  name: "TextFamily",
  kind: "family",
  pluginId: "Text",
  members: ["Text"],
  behaviors: [{ behaviorId: "GTrack", name: "Track" }],
  effectTypes: [],
};

describe("UsageMatcher.matchExpression (unit, synthetic tokens/model)", () => {
  describe("plugin matcher", () => {
    const matcher = () =>
      createPluginUsageMatcher(
        "GCore",
        [accountObject],
        new Set<string>(),
        model(expr("session-length", "SessionLength")),
      );

    it("resolves Object.expr on a presence object to the expression ACE id", () => {
      expect(matcher().matchExpression(ref("Account", "SessionLength"))).to.equal("session-length");
    });

    it("does NOT match a non-presence object", () => {
      expect(matcher().matchExpression(ref("SomethingElse", "SessionLength"))).to.be.undefined;
    });

    it("never matches a behavior expression (behaviorName present)", () => {
      expect(matcher().matchExpression(ref("Account", "SessionLength", "SomeBehavior"))).to.be.undefined;
    });

    it("returns undefined when the memberName names no expression the addon declares", () => {
      expect(matcher().matchExpression(ref("Account", "NotAnExpression"))).to.be.undefined;
    });

    it("resolves by expressionName (PascalCase), NOT by the dash-cased id", () => {
      // The token carries the PascalCase name; passing the id must NOT resolve.
      expect(matcher().matchExpression(ref("Account", "session-length"))).to.be.undefined;
    });
  });

  describe("behavior matcher", () => {
    const matcher = () =>
      createBehaviorUsageMatcher(
        "GTrack",
        [trackedFamily],
        new Set<string>(),
        model(expr("tracked-time", "TrackedTime")),
      );

    it("resolves Object.Behavior.expr on a family MEMBER, attributing via the instance name", () => {
      // Text is a member of TextFamily, which carries the "Track" instance of GTrack.
      expect(matcher().matchExpression(ref("Text", "TrackedTime", "Track"))).to.equal("tracked-time");
    });

    it("resolves Object.Behavior.expr on the family host itself", () => {
      expect(matcher().matchExpression(ref("TextFamily", "TrackedTime", "Track"))).to.equal("tracked-time");
    });

    it("does NOT match when behaviorName is absent (a bare Object.expr is not a behavior expr)", () => {
      expect(matcher().matchExpression(ref("Text", "TrackedTime"))).to.be.undefined;
    });

    it("does NOT match a wrong instance name", () => {
      expect(matcher().matchExpression(ref("Text", "TrackedTime", "WrongInstance"))).to.be.undefined;
    });

    it("does NOT match an object that is neither a presence host nor a member", () => {
      expect(matcher().matchExpression(ref("Unrelated", "TrackedTime", "Track"))).to.be.undefined;
    });

    it("returns undefined when the memberName names no expression the addon declares", () => {
      expect(matcher().matchExpression(ref("Text", "NotAnExpression", "Track"))).to.be.undefined;
    });
  });
});
