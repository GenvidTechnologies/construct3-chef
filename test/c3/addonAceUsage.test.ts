import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { scanAddonUsage, formatAddonUsage, type AddonUsageResult, type CallSite } from "../../src/c3/addonAceUsage.js";

const FIXTURE_ROOT = path.resolve("test/fixtures/addon-ace-usage");
const GCORE_OLD_SOURCE = path.join("archive-sources", "GCoreOld");

function ok(result: ReturnType<typeof scanAddonUsage>): AddonUsageResult {
  expect("error" in result).to.be.false;
  return result as AddonUsageResult;
}

function findSite(sites: CallSite[], kind: CallSite["kind"], objectClass: string, id: string): CallSite | undefined {
  return sites.find((s) => s.kind === kind && s.objectClass === objectClass && s.id === id);
}

describe("addonAceUsage", () => {
  describe("scanAddonUsage", () => {
    it("U1: presence includes Account + Leaderboard (objectTypes) + GCoreFamily (family), excludes Hero", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));

      const names = result.presence.map((p) => p.name);
      expect(names).to.include.members(["Account", "Leaderboard", "GCoreFamily"]);
      expect(names).to.not.include("Hero");

      const account = result.presence.find((p) => p.name === "Account");
      expect(account?.kind).to.equal("objectType");

      const family = result.presence.find((p) => p.name === "GCoreFamily");
      expect(family?.kind).to.equal("family");
    });

    it("U2: Leaderboard is instantiated but has zero call sites", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const leaderboard = result.presence.find((p) => p.name === "Leaderboard");
      expect(leaderboard).to.not.be.undefined;
      expect(leaderboard?.callSiteCount).to.equal(0);
    });

    it("U3: Account.is-logged-in condition call site has exact sid + jsonPath", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const site = findSite(result.callSites, "condition", "Account", "is-logged-in");
      expect(site).to.deep.equal({
        sheet: "Events",
        eventNumber: 1,
        jsonPath: "events[0]",
        kind: "condition",
        objectClass: "Account",
        id: "is-logged-in",
        sid: 820000000000001,
      });
    });

    it("U4: Account.login action call site has exact sid + jsonPath", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const site = findSite(result.callSites, "action", "Account", "login");
      expect(site).to.deep.equal({
        sheet: "Events",
        eventNumber: 1,
        jsonPath: "events[0]",
        kind: "action",
        objectClass: "Account",
        id: "login",
        sid: 820000000000002,
      });
    });

    it("U5: System.* conditions/actions produce no call site", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      expect(findSite(result.callSites, "condition", "System", "compare-two-values")).to.be.undefined;
      expect(findSite(result.callSites, "action", "System", "wait")).to.be.undefined;
    });

    it("U6: Hero.set-position produces no call site (Hero is not an instance of the scanned addon)", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      expect(findSite(result.callSites, "action", "Hero", "set-position")).to.be.undefined;
    });

    it("U7: (kind,id) identity — condition 'login' and action 'login' are both matched, independently", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const cond = findSite(result.callSites, "condition", "Account", "login");
      const action = findSite(result.callSites, "action", "Account", "login");
      expect(cond).to.not.be.undefined;
      expect(action).to.not.be.undefined;
      expect(cond?.sid).to.equal(820000000000004);
      expect(action?.sid).to.equal(820000000000002);
    });

    it("U8: family-named call site (GCoreFamily.is-logged-in) is found and attributed to the family row", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const site = findSite(result.callSites, "condition", "GCoreFamily", "is-logged-in");
      expect(site).to.deep.equal({
        sheet: "Events",
        eventNumber: 3,
        jsonPath: "events[2]",
        kind: "condition",
        objectClass: "GCoreFamily",
        id: "is-logged-in",
        sid: 820000000000007,
      });

      const family = result.presence.find((p) => p.name === "GCoreFamily");
      expect(family?.callSiteCount).to.equal(1);
    });

    it("U9: Account.logout action call is NOT found — 'logout' was removed from the addon's current ACEs", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      expect(findSite(result.callSites, "action", "Account", "logout")).to.be.undefined;
    });

    it("U10: Account's total call-site count is 3 (is-logged-in cond + login cond + login action)", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const account = result.presence.find((p) => p.name === "Account");
      expect(account?.callSiteCount).to.equal(3);
    });

    it("U11: an unresolvable addon argument returns an error, never throws", () => {
      expect(() => scanAddonUsage(FIXTURE_ROOT, "NoSuchAddon")).to.not.throw();
      const result = scanAddonUsage(FIXTURE_ROOT, "NoSuchAddon");
      expect(result).to.deep.equal({ error: "addon source not found: NoSuchAddon" });
    });
  });

  describe("formatAddonUsage", () => {
    it("F1: renders the header, summary, presence rows, and a call-site line", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore");
      const output = formatAddonUsage(result);

      expect(output).to.include("scan-addon-usage: GCore");
      expect(output).to.include("Object types:");
      expect(output).to.include("Families:");
      expect(output).to.include("Account   3 call site(s)");
      expect(output).to.include("Leaderboard   0 call site(s) (instantiated, no ACE calls)");
      expect(output).to.include("GCoreFamily   1 call site(s)");
      expect(output).to.include("Call sites:");
      expect(output).to.include("Events");
      expect(output).to.include("event #1  events[0]   [condition] Account.is-logged-in()");
      expect(output).to.include("event #1  events[0]   [action] Account.login(token)");
    });

    it("F2: renders the error-value case consistently, without throwing", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "NoSuchAddon");
      const output = formatAddonUsage(result);
      expect(output).to.equal("scan-addon-usage: addon source not found: NoSuchAddon");
    });

    it("F3: renders the empty-usage sentence when an addon has no presence and no call sites", () => {
      // Leaderboard is present but every other addon match is what drives the
      // non-empty branch, so exercise the empty case directly against the
      // formatter with a synthetic zero-usage result.
      const empty: AddonUsageResult = {
        addonId: "Nowhere",
        addonLabel: "Nowhere",
        presence: [],
        callSites: [],
        aces: [],
      };
      expect(formatAddonUsage(empty)).to.equal('No usage of addon "Nowhere" found.');
    });
  });

  // ── Blast-radius mode (--from) — P4, #110 ─────────────────────────────────
  //
  // archive-sources/GCoreOld -> GCore.c3addon (built from GCoreNew, see
  // build-archive.mjs) exercises every diff bucket the blast-radius match
  // widening + markers rely on:
  //   - "is-logged-in" condition / "login" condition: UNCHANGED
  //   - "login" action: CHANGED (New drops the `region` param)
  //   - "logout" action: REMOVED in New — the fixture's Events.json still
  //     calls it (Account.logout, sid 820000000000005), which is exactly the
  //     dangling "reimport didn't migrate this event sheet" call a plain scan
  //     silently drops (see U9) and blast mode must surface.

  describe("scanAddonUsage — blast radius (--from)", () => {
    it("B1 (red-first against plain P3 matching): Account.logout dangling call site is FOUND when --from is given", () => {
      // Under the plain (no-blast) match rule this is exactly U9's case
      // (findSite(...) undefined) — widening the match set with diff.removed
      // is what makes this call site appear at all.
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE));
      const site = findSite(result.callSites, "action", "Account", "logout");
      expect(site).to.not.be.undefined;
      expect(site?.sid).to.equal(820000000000005);
    });

    it("B2: blast.removedKeys contains action:logout, blast.changedKeys contains action:login", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE));
      expect(result.blast).to.not.be.undefined;
      expect(result.blast?.removedKeys).to.include("action:logout");
      expect(result.blast?.changedKeys).to.include("action:login");
      expect(result.blast?.fromLabel).to.equal("GCoreOld");
    });

    it("B3: blast.affectedCount counts the changed login call site + the removed logout call site (2)", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE));
      expect(result.blast?.affectedCount).to.equal(2);
    });

    it("B4: self-diff (from === current) yields an empty diff — zero affected, no changed/removed keys", () => {
      const result = ok(scanAddonUsage(FIXTURE_ROOT, "GCore", "GCore"));
      expect(result.blast).to.not.be.undefined;
      expect(result.blast?.changedKeys).to.deep.equal([]);
      expect(result.blast?.removedKeys).to.deep.equal([]);
      expect(result.blast?.affectedCount).to.equal(0);
    });

    it("B5: an unresolvable --from source returns an error, never throws", () => {
      expect(() => scanAddonUsage(FIXTURE_ROOT, "GCore", "NoSuchSource")).to.not.throw();
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", "NoSuchSource");
      expect(result).to.deep.equal({ error: "addon source not found: NoSuchSource" });
    });

    it("B6: --from resolving a .c3addon source OUTSIDE the fixture root works without a containment error", () => {
      // Mirrors addonAceDiff.test.ts's own non-containment coverage (I1/I2):
      // a --from source may live under a completely different fixture root
      // than the project being scanned — deliberately not path-contained to
      // FIXTURE_ROOT, per resolveAceSource's docstring.
      const outsideC3Addon = path.join(
        path.resolve("test/fixtures/addon-ace-diff"),
        "addons",
        "plugin",
        "GCoreV1.c3addon",
      );
      expect(() => scanAddonUsage(FIXTURE_ROOT, "GCore", outsideC3Addon)).to.not.throw();
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", outsideC3Addon);
      expect("error" in result).to.be.false;
      const okResult = result as AddonUsageResult;
      expect(okResult.blast).to.not.be.undefined;
      expect(okResult.blast?.fromLabel).to.equal("GCoreV1.c3addon");
    });
  });

  describe("formatAddonUsage — blast radius", () => {
    it("FB1: renders the blast radius header line", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE);
      const output = formatAddonUsage(result);
      expect(output).to.include("blast radius (vs GCoreOld): 2 affected call site(s)");
    });

    it("FB2: marks a changed-signature call site (Account.login, region dropped) with ⚠ CHANGED", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE);
      const output = formatAddonUsage(result);
      expect(output).to.include("[action] Account.login(token) ⚠ CHANGED");
    });

    it("FB3: marks the dangling removed-ACE call site (Account.logout) with ⚠ REMOVED", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE);
      const output = formatAddonUsage(result);
      expect(output).to.include("[action] Account.logout() ⚠ REMOVED");
    });

    it("FB4: every present object-type/family row gets ⚠ exposed when the diff has any changed/removed entries", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", GCORE_OLD_SOURCE);
      const output = formatAddonUsage(result);
      // Account's total call-site count grows from 3 (plain scan, U10) to 4
      // in blast mode — the widened match set also picks up the dangling
      // logout action as a genuine call site, not just an "affected" one.
      expect(output).to.include("Account   4 call site(s) ⚠ exposed");
      expect(output).to.include("Leaderboard   0 call site(s) (instantiated, no ACE calls) ⚠ exposed");
      expect(output).to.include("GCoreFamily   1 call site(s) ⚠ exposed");
    });

    it("FB5: self-diff (from === current) renders zero affected and no exposed/CHANGED/REMOVED markers", () => {
      const result = scanAddonUsage(FIXTURE_ROOT, "GCore", "GCore");
      const output = formatAddonUsage(result);
      expect(output).to.include("blast radius (vs GCore): 0 affected call site(s)");
      expect(output).to.not.include("⚠ exposed");
      expect(output).to.not.include("⚠ CHANGED");
      expect(output).to.not.include("⚠ REMOVED");
    });

    it("FB6: no --from produces output byte-identical to the plain P3 scan", () => {
      const plain = formatAddonUsage(scanAddonUsage(FIXTURE_ROOT, "GCore"));
      const explicitUndefined = formatAddonUsage(scanAddonUsage(FIXTURE_ROOT, "GCore", undefined));
      expect(explicitUndefined).to.equal(plain);
      expect(plain).to.not.include("blast radius");
      expect(plain).to.not.include("⚠ exposed");
      expect(plain).to.not.include("⚠ CHANGED");
      expect(plain).to.not.include("⚠ REMOVED");
    });
  });
});
