import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import type { AcesModel, AceExpression, ExpressionReferenceToken } from "@genvidtech/c3source";
import {
  createPluginUsageMatcher,
  createBehaviorUsageMatcher,
  scanAddonUsage,
  formatAddonUsage,
  type AddonUsageResult,
} from "../../src/c3/addonAceUsage.js";
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

// ── End-to-end: scanAddonUsage over the addon-ace-usage fixture (AC1–AC7) ─────

describe("scanAddonUsage — expression usage (against addon-ace-usage fixture)", () => {
  const FIXTURE_ROOT = path.resolve("test/fixtures/addon-ace-usage");
  const GCORE_OLD = path.join("archive-sources", "GCoreOld");

  function ok(result: ReturnType<typeof scanAddonUsage>): AddonUsageResult {
    expect("error" in result).to.be.false;
    return result as AddonUsageResult;
  }

  it("E1 (AC1): resolves a plugin Object.expr to its expression ACE id, param key + span, and renders it", () => {
    const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
    const sites = (result.expressionSites ?? []).filter(
      (s) => s.objectName === "Account" && s.memberName === "SessionLength",
    );
    expect(sites.length).to.be.greaterThan(0);
    expect(sites[0].id).to.equal("session-length");
    expect(sites[0].behaviorName).to.be.undefined;
    expect(sites[0].paramKey).to.equal("seconds");
    expect(sites[0].end).to.be.greaterThan(sites[0].start);

    const out = formatAddonUsage(result);
    expect(out).to.include("Expression references:");
    expect(out).to.include("Account.SessionLength   [expression] session-length");
  });

  it("E2 (AC3/AC4): a quoted string literal yields no reference; a nested call yields exactly one", () => {
    const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
    // The fixture references Account.SessionLength three ways: bare, inside a
    // quoted literal ("...") — a false positive that must NOT resolve — and
    // inside max(...). So exactly two sites survive (bare + nested), not three.
    const sites = (result.expressionSites ?? []).filter((s) => s.memberName === "SessionLength");
    expect(sites.length).to.equal(2);
  });

  it("E3 (AC5): a numeric parameter (comparison) is skipped without a bogus reference or a crash", () => {
    // The fixture's compare-two-values condition carries comparison:0 (a number)
    // — collectExpressionSites must skip non-string params. Rank also does not
    // resolve in the current (New) model, so a plain scan yields no Rank site.
    const result = scanAddonUsage(FIXTURE_ROOT, "GCore");
    expect("error" in result).to.be.false;
    const rank = ((result as AddonUsageResult).expressionSites ?? []).filter((s) => s.memberName === "Rank");
    expect(rank.length).to.equal(0);
  });

  it("E4 (AC2): a behavior Object.Behavior.expr on a family member attributes to the family; the site keeps the member name", () => {
    const result = ok(scanAddonUsage(FIXTURE_ROOT, "GTrack"));
    const site = (result.expressionSites ?? []).find((s) => s.memberName === "TrackedTime");
    expect(site).to.not.be.undefined;
    expect(site!.id).to.equal("tracked-time");
    expect(site!.behaviorName).to.equal("Track");
    expect(site!.objectName).to.equal("Leaderboard"); // the member, NOT the family

    const family = result.presence.find((p) => p.name === "GCoreFamily");
    expect(family?.expressionSiteCount).to.equal(1);

    // An expression-only host no longer reads "(instantiated, no ACE calls)".
    const out = formatAddonUsage(result);
    expect(out).to.include("GCoreFamily [Track]   0 call site(s), 1 expression ref(s)");
    expect(out).to.not.include("(instantiated, no ACE calls)");
  });

  it("E5 (AC6): --from blast flags a CHANGED and a dangling REMOVED expression reference", () => {
    const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD));
    const out = formatAddonUsage(result);
    expect(out).to.include("Account.SessionLength   [expression] session-length ⚠ CHANGED");
    // Rank was removed in New; the widened blast model still resolves the
    // dangling reference so it surfaces with a REMOVED marker.
    expect(out).to.include("Account.Rank   [expression] rank ⚠ REMOVED");
  });

  it("E6 (AC7): blast.affectedCount includes affected expression sites and drives the exit-1 gate", () => {
    expect(ok(scanAddonUsage(FIXTURE_ROOT, "GCore")).blast).to.be.undefined; // plain scan never gates

    const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD));
    // 2 affected call sites (login CHANGED, logout REMOVED) + 3 affected
    // expression refs (SessionLength CHANGED ×2, Rank REMOVED ×1).
    expect(result.blast?.affectedCount).to.equal(5);
    // The CLI's exit-1 condition is `blast !== undefined && affectedCount > 0`.
    expect(result.blast !== undefined && result.blast.affectedCount > 0).to.be.true;
  });
});
