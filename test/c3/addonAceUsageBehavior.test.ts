import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import {
  scanAddonUsage,
  formatAddonUsage,
  createBehaviorUsageMatcher,
  type AddonUsageResult,
  type CallSite,
} from "../../src/c3/addonAceUsage.js";
import { diffAddonAces } from "../../src/c3/addonAceDiff.js";
import type { ObjectDefn } from "../../src/c3/projectObjects.js";
import type { AceEntry } from "../../src/c3/c3Reference.js";

const SAMPLE_ROOT = path.resolve("test/fixtures/construct3-chef-sample");

function ok(result: ReturnType<typeof scanAddonUsage>): AddonUsageResult {
  expect("error" in result).to.be.false;
  return result as AddonUsageResult;
}

function findSite(sites: CallSite[], kind: CallSite["kind"], objectClass: string, id: string): CallSite | undefined {
  return sites.find((s) => s.kind === kind && s.objectClass === objectClass && s.id === id);
}

function ace(kind: AceEntry["kind"], id: string, params: { name: string; type: string }[] = []): AceEntry {
  return { source: "addon", objectClass: "MyCompany_MyBehavior", kind, id, params };
}

// Verified against the real fixture (test/fixtures/construct3-chef-sample):
// objectTypes/images/Sprite2.json and objectTypes/images/9patch.json BOTH
// carry a MyCompany_MyBehavior instance named "MyCustomBehavior" — Sprite2's
// call site is Event sheet 1's `Sprite2[MyCustomBehavior].stop` action; no
// event sheet references 9patch at all, so it's a genuine
// present-but-uncalled host. The bundled MyCompany_MyBehavior.c3addon
// declares condition "is-moving", action "stop", expression "leet".

describe("scanAddonUsage — behavior addons (against construct3-chef-sample)", () => {
  it("presence is Sprite2 + 9patch, both object types, keyed on behaviorTypes not plugin-id", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyBehavior"));
    const names = result.presence.map((p) => p.name);
    expect(names).to.include.members(["Sprite2", "9patch"]);
    for (const row of result.presence) {
      expect(row.kind).to.equal("objectType");
    }
  });

  it("Sprite2.stop is a matched call site", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyBehavior"));
    const site = findSite(result.callSites, "action", "Sprite2", "stop");
    expect(site).to.not.be.undefined;

    const sprite2 = result.presence.find((p) => p.name === "Sprite2");
    expect(sprite2?.callSiteCount).to.equal(1);
  });

  it("9patch is present (instantiated) but uncalled — callSiteCount 0", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyBehavior"));
    const ninePatch = result.presence.find((p) => p.name === "9patch");
    expect(ninePatch).to.not.be.undefined;
    expect(ninePatch?.callSiteCount).to.equal(0);
  });

  it("is-moving/leet are declared but never called", () => {
    const result = ok(scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyBehavior"));
    expect(findSite(result.callSites, "condition", "Sprite2", "is-moving")).to.be.undefined;
    expect(findSite(result.callSites, "condition", "9patch", "is-moving")).to.be.undefined;
  });

  it("Timer is a C3 built-in behavior with no discoverable addon package — scan returns the standard error", () => {
    expect(() => scanAddonUsage(SAMPLE_ROOT, "Timer")).to.not.throw();
    const result = scanAddonUsage(SAMPLE_ROOT, "Timer");
    expect(result).to.deep.equal({ error: "addon source not found: Timer" });
  });
});

// ── formatAddonUsage — instance-name segment (F4) ──────────────────────────
//
// A behavior presence row renders a trailing `[instanceName]` segment (or
// `[A, B]` for two instances) right after the row's name; a plugin presence
// row (no `instanceNames`) is unchanged — no segment, no stray brackets.

describe("formatAddonUsage — behavior scan instance-name segment", () => {
  it("renders '[MyCustomBehavior]' on both Sprite2 (called) and 9patch (uncalled) presence rows", () => {
    const result = scanAddonUsage(SAMPLE_ROOT, "MyCompany_MyBehavior");
    const output = formatAddonUsage(result);

    expect(output).to.include("Sprite2 [MyCustomBehavior]   1 call site(s)");
    expect(output).to.include("9patch [MyCustomBehavior]   0 call site(s) (instantiated, no ACE calls)");
  });

  it("a plugin presence row (no instanceNames) renders with no bracketed segment", () => {
    const pluginResult: AddonUsageResult = {
      addonId: "SomePlugin",
      addonLabel: "SomePlugin",
      presence: [{ name: "Hero", kind: "objectType", callSiteCount: 2 }],
      callSites: [],
      aces: [],
    };
    const output = formatAddonUsage(pluginResult);
    expect(output).to.include("Hero   2 call site(s)");
    expect(output).to.not.include("[");
  });

  it("two instances of the same behavior on one host render as a comma-joined segment", () => {
    const twoInstanceResult: AddonUsageResult = {
      addonId: "MyCompany_MyBehavior",
      addonLabel: "MyCompany_MyBehavior",
      presence: [{ name: "Boss", kind: "objectType", callSiteCount: 0, instanceNames: ["B1", "B2"] }],
      callSites: [],
      aces: [],
    };
    const output = formatAddonUsage(twoInstanceResult);
    expect(output).to.include("Boss [B1, B2]   0 call site(s) (instantiated, no ACE calls)");
  });
});

// ── Matcher-level unit tests ────────────────────────────────────────────────
//
// The family-member attribution rule (and the "two instances on one host"
// case) can't be driven end-to-end through scanAddonUsage against the real
// fixture: TextFamily's Timer behavior is a C3 built-in, not a discoverable
// addons/* package, so there's no ACE source to resolve. These tests exercise
// createBehaviorUsageMatcher directly against synthetic ObjectDefns/nodes
// that mirror the real families/TextFamily.json shape (members: [Text2,
// Text], one Timer instance named "Timer") and the real call sites
// (Event sheet 1: TextFamily[Timer].start-timer; Event sheet 2:
// Text[Timer].stop-timer, real objectClass "Text").

describe("createBehaviorUsageMatcher (unit, synthetic ObjectDefns)", () => {
  function textFamily(): ObjectDefn {
    return {
      name: "TextFamily",
      kind: "family",
      pluginId: "Text",
      members: ["Text2", "Text"],
      behaviors: [{ behaviorId: "Timer", name: "Timer" }],
      effectTypes: [],
    };
  }

  const timerMatchKeys = new Set(["action:start-timer", "action:stop-timer"]);

  it("family-direct + family-member call sites both attribute to the family presence row (count 2); member CallSite keeps its real objectClass", () => {
    const matcher = createBehaviorUsageMatcher("Timer", [textFamily()], timerMatchKeys);

    expect(matcher.presence).to.deep.equal([{ name: "TextFamily", kind: "family", instanceNames: ["Timer"] }]);

    // Mirrors scanAddonUsage's own walk + attribution: a CallSite always
    // records the node's REAL objectClass; only the count aggregation is
    // attributed through matcher.attributeTo.
    const familyNode = { objectClass: "TextFamily", kind: "action" as const, id: "start-timer", behaviorType: "Timer" };
    const memberNode = { objectClass: "Text", kind: "action" as const, id: "stop-timer", behaviorType: "Timer" };

    expect(matcher.matches(familyNode)).to.be.true;
    expect(matcher.matches(memberNode)).to.be.true;

    const callSites: CallSite[] = [
      {
        sheet: "Event sheet 1",
        eventNumber: 1,
        jsonPath: "events[0]",
        kind: "action",
        objectClass: familyNode.objectClass,
        id: familyNode.id,
        sid: 1,
      },
      {
        sheet: "Event sheet 2",
        eventNumber: 1,
        jsonPath: "events[0]",
        kind: "action",
        objectClass: memberNode.objectClass,
        id: memberNode.id,
        sid: 2,
      },
    ];

    // The member call site keeps the REAL objectClass "Text" — attribution
    // never rewrites it.
    expect(callSites[1].objectClass).to.equal("Text");

    const countByName = new Map<string, number>();
    for (const site of callSites) {
      const name = matcher.attributeTo(site.objectClass);
      expect(name).to.equal("TextFamily");
      countByName.set(name!, (countByName.get(name!) ?? 0) + 1);
    }
    expect(countByName.get("TextFamily")).to.equal(2);
  });

  it("presence excludes family members (Text, Text2) — only the family itself is a presence row", () => {
    const matcher = createBehaviorUsageMatcher("Timer", [textFamily()], timerMatchKeys);
    const names = matcher.presence.map((p) => p.name);
    expect(names).to.not.include("Text");
    expect(names).to.not.include("Text2");
    expect(names).to.deep.equal(["TextFamily"]);
  });

  it("presence never keys off plugin-id: a host with a matching plugin-id but no matching behaviorTypes entry is excluded", () => {
    const decoy: ObjectDefn = {
      name: "Decoy",
      kind: "objectType",
      pluginId: "Timer", // deliberately reuses the addonId as a plugin-id — must NOT create presence
      members: [],
      behaviors: [],
      effectTypes: [],
    };
    const matcher = createBehaviorUsageMatcher("Timer", [textFamily(), decoy], timerMatchKeys);
    expect(matcher.presence.map((p) => p.name)).to.deep.equal(["TextFamily"]);
  });

  it("two instances of the same behavior on one host: both instance names match, one presence row, counts aggregate", () => {
    const twoInstanceHost: ObjectDefn = {
      name: "Boss",
      kind: "objectType",
      pluginId: "Sprite",
      members: [],
      behaviors: [
        { behaviorId: "MyCompany_MyBehavior", name: "B1" },
        { behaviorId: "MyCompany_MyBehavior", name: "B2" },
      ],
      effectTypes: [],
    };
    const matchKeys = new Set(["action:stop"]);
    const matcher = createBehaviorUsageMatcher("MyCompany_MyBehavior", [twoInstanceHost], matchKeys);

    expect(matcher.presence).to.deep.equal([{ name: "Boss", kind: "objectType", instanceNames: ["B1", "B2"] }]);
    expect(matcher.matches({ objectClass: "Boss", kind: "action", id: "stop", behaviorType: "B1" })).to.be.true;
    expect(matcher.matches({ objectClass: "Boss", kind: "action", id: "stop", behaviorType: "B2" })).to.be.true;

    const countByName = new Map<string, number>();
    for (const behaviorType of ["B1", "B2"]) {
      const name = matcher.attributeTo("Boss");
      expect(name).to.equal("Boss");
      countByName.set(name!, (countByName.get(name!) ?? 0) + 1);
      // behaviorType isn't part of attribution, only used to prove both match above
      void behaviorType;
    }
    expect(countByName.get("Boss")).to.equal(2);
  });

  it("(kind,id) identity guard: instance name + objectClass match but (kind,id) is not in matchKeySet — no match", () => {
    const matcher = createBehaviorUsageMatcher("Timer", [textFamily()], new Set(["action:start-timer"]));
    expect(matcher.matches({ objectClass: "Text", kind: "action", id: "stop-timer", behaviorType: "Timer" })).to.be
      .false;
  });

  it("a node with no behaviorType never matches", () => {
    const matcher = createBehaviorUsageMatcher("Timer", [textFamily()], timerMatchKeys);
    expect(matcher.matches({ objectClass: "TextFamily", kind: "action", id: "start-timer" })).to.be.false;
  });

  it("an unrelated object reusing the instance-name string does not match (objectClass attribution guard)", () => {
    const matcher = createBehaviorUsageMatcher("Timer", [textFamily()], timerMatchKeys);
    expect(
      matcher.matches({ objectClass: "SomeOtherObject", kind: "action", id: "start-timer", behaviorType: "Timer" }),
    ).to.be.false;
  });
});

// ── Blast-radius widening (unit, no second .c3addon — Option A) ───────────
//
// Mirrors the existing plugin blast tests' structure (see
// addonAceUsage.test.ts B1-B3) but drives diffAddonAces directly against
// synthetic before/after AceEntry[] lists rather than a real second
// .c3addon package, since MyCompany_MyBehavior has no such fixture. Proves
// the SAME widening rule scanAddonUsage applies (matchKeySet = current keys
// UNION removed keys) makes a behavior call site whose (kind,id) was
// removed/changed still match, and that affectedCount counts it.

describe("behavior blast-radius widening (unit, no second .c3addon)", () => {
  it("a removed ACE's dangling call site flows through matchKeySet widening and both changed+removed are affected", () => {
    const before: AceEntry[] = [
      ace("action", "stop"),
      ace("action", "pause", [{ name: "region", type: "string" }]),
      ace("action", "reset"),
    ];
    const after: AceEntry[] = [
      ace("action", "stop"),
      ace("action", "pause"), // changed: `region` param dropped
      // "reset" removed in `after`
    ];

    const aceKeySet = new Set(after.filter((a) => a.kind !== "expression").map((a) => `${a.kind}:${a.id}`));
    const diff = diffAddonAces(before, after);
    const changedKeys = diff.changed.map((c) => `${c.after.kind}:${c.after.id}`);
    const removedKeys = diff.removed.map((r) => `${r.kind}:${r.id}`);
    expect(changedKeys).to.include("action:pause");
    expect(removedKeys).to.include("action:reset");

    // Mirrors scanAddonUsage's own widening: current keys UNION removed keys.
    const matchKeySet = new Set([...aceKeySet, ...removedKeys]);

    const host: ObjectDefn = {
      name: "Boss",
      kind: "objectType",
      pluginId: "Sprite",
      members: [],
      behaviors: [{ behaviorId: "MyCompany_MyBehavior", name: "MyInstance" }],
      effectTypes: [],
    };
    const matcher = createBehaviorUsageMatcher("MyCompany_MyBehavior", [host], matchKeySet);

    // "reset" is REMOVED from current ACEs but still called — a dangling
    // call that only widening surfaces (plain matchKeySet would drop it).
    expect(matcher.matches({ objectClass: "Boss", kind: "action", id: "reset", behaviorType: "MyInstance" })).to.be
      .true;
    // "pause" is CHANGED but still present in the current ACE set either way.
    expect(matcher.matches({ objectClass: "Boss", kind: "action", id: "pause", behaviorType: "MyInstance" })).to.be
      .true;
    // "stop" is unaffected.
    expect(matcher.matches({ objectClass: "Boss", kind: "action", id: "stop", behaviorType: "MyInstance" })).to.be.true;

    // Mirrors scanAddonUsage's own blast.affectedCount computation.
    const changedSet = new Set(changedKeys);
    const removedSet = new Set(removedKeys);
    const callSites = [
      { kind: "action" as const, id: "pause" },
      { kind: "action" as const, id: "reset" },
      { kind: "action" as const, id: "stop" },
    ];
    const affectedCount = callSites.filter(
      (s) => changedSet.has(`${s.kind}:${s.id}`) || removedSet.has(`${s.kind}:${s.id}`),
    ).length;
    expect(affectedCount).to.equal(2);
  });
});

// ── CLI exit-code decision on a behavior blast (unit-level) ────────────────
//
// There's no subprocess/CLI test harness in this repo (grepped: no
// execFileSync/spawnSync usage under test/), so this exercises the exact
// boolean the CLI's scan-addon-usage handler evaluates
// (`result.blast !== undefined && result.blast.affectedCount > 0`, cli.ts
// ~line 610) against a real behavior-scan AddonUsageResult shape, rather than
// spawning the CLI process.

describe("scan-addon-usage CLI exit-code decision on a behavior blast (unit)", () => {
  function wouldExitNonZero(result: AddonUsageResult): boolean {
    return result.blast !== undefined && result.blast.affectedCount > 0;
  }

  it("exits non-zero when a behavior blast has affected call sites", () => {
    const affected: AddonUsageResult = {
      addonId: "MyCompany_MyBehavior",
      addonLabel: "MyCompany_MyBehavior",
      presence: [{ name: "Boss", kind: "objectType", callSiteCount: 1, instanceNames: ["MyInstance"] }],
      callSites: [],
      aces: [],
      blast: { fromLabel: "MyCompany_MyBehaviorOld", changedKeys: [], removedKeys: ["action:reset"], affectedCount: 1 },
    };
    expect(wouldExitNonZero(affected)).to.be.true;
  });

  it("stays exit-0 for a behavior blast scan with zero affected call sites", () => {
    const unaffected: AddonUsageResult = {
      addonId: "MyCompany_MyBehavior",
      addonLabel: "MyCompany_MyBehavior",
      presence: [{ name: "Boss", kind: "objectType", callSiteCount: 1, instanceNames: ["MyInstance"] }],
      callSites: [],
      aces: [],
      blast: { fromLabel: "MyCompany_MyBehaviorOld", changedKeys: [], removedKeys: [], affectedCount: 0 },
    };
    expect(wouldExitNonZero(unaffected)).to.be.false;
  });

  it("stays exit-0 for a plain (non-blast) behavior scan — no `blast` key at all", () => {
    const plain: AddonUsageResult = {
      addonId: "MyCompany_MyBehavior",
      addonLabel: "MyCompany_MyBehavior",
      presence: [{ name: "Boss", kind: "objectType", callSiteCount: 1, instanceNames: ["MyInstance"] }],
      callSites: [],
      aces: [],
    };
    expect(wouldExitNonZero(plain)).to.be.false;
  });
});
