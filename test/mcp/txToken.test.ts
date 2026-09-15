import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createProjectContext, type ProjectContext } from "../../src/mcp/projectContext.js";
import type { TxTokenParseFailure } from "@genvidtech/mcp-utils";
import { formatTxToken, compareTxToken, renderParseFailure } from "../../src/mcp/txToken.js";
import { ProjectRegistry } from "../../src/mcp/projectRegistry.js";

function errorText(r: CallToolResult): string {
  const block = r.content[0];
  return block && block.type === "text" ? (block as { type: "text"; text: string }).text : String(r);
}

/** Stand in for a real OptimisticWatcher: ProjectContext's `watcher` field is
 * declared `!:` for the caller to wire up post-construction (see
 * projectContext.ts), and compareTxToken only ever reads `.txId`. */
function withTxId(ctx: ProjectContext, txId: number): ProjectContext {
  (ctx as unknown as { watcher: { txId: number } }).watcher = { txId };
  return ctx;
}

describe("txToken", () => {
  describe("formatTxToken", () => {
    it("formats id:counter", () => {
      expect(formatTxToken("alpha", 5)).to.equal("alpha:5");
    });

    it("formats a zero counter", () => {
      expect(formatTxToken("alpha", 0)).to.equal("alpha:0");
    });
  });

  describe("renderParseFailure", () => {
    // One row per TxTokenParseFailure member (#217). Calls renderParseFailure
    // directly, never through parseTxToken/compareTxToken -- those still hold
    // the old local implementation at this commit.
    const sample = "alpha:5";
    const cases: Array<[reason: TxTokenParseFailure, message: string]> = [
      ["not-a-string", `Invalid txId '${sample}' — expected format '<projectId>:<counter>'`],
      ["no-separator", `Invalid txId '${sample}' — expected format '<projectId>:<counter>'`],
      [
        "invalid-project-id",
        `Invalid txId '${sample}' — the project id must be non-empty and contain no ':' or whitespace`,
      ],
      [
        "invalid-counter-shape",
        `Invalid txId '${sample}' — the counter must be a canonical non-negative integer (no leading zeros, no sign, no whitespace)`,
      ],
      ["counter-out-of-range", `Invalid txId '${sample}' — the counter exceeds the maximum safe integer (2^53 - 1)`],
    ];

    for (const [reason, message] of cases) {
      it(`renders '${reason}' with the exact expected wording`, () => {
        expect(renderParseFailure(sample, reason)).to.equal(message);
      });
    }
  });

  describe("compareTxToken", () => {
    let root: string;
    let ctx: ProjectContext;

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "c3chef-txToken-"));
      ctx = await createProjectContext("alpha", root);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("returns null when the token is undefined — the check stays opt-in", () => {
      withTxId(ctx, 12);
      expect(compareTxToken(ctx, undefined)).to.equal(null);
    });

    it("returns null when the token matches the context's current id and counter", () => {
      withTxId(ctx, 12);
      expect(compareTxToken(ctx, "alpha:12")).to.equal(null);
    });

    it("returns an error for a malformed token, never a thrown exception", () => {
      withTxId(ctx, 12);
      const result = compareTxToken(ctx, "not-a-token");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      expect(errorText(result!)).to.include("Invalid txId");
    });

    it("names BOTH the token's id and the context's id on an id mismatch", () => {
      withTxId(ctx, 12);
      const result = compareTxToken(ctx, "beta:12");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      const text = errorText(result!);
      expect(text).to.include("beta");
      expect(text).to.include("alpha");
    });

    it("uses the existing 'State changed' wording on a counter mismatch, naming both tokens", () => {
      withTxId(ctx, 12);
      const result = compareTxToken(ctx, "alpha:5");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      const text = errorText(result!);
      expect(text).to.include("State changed (expected alpha:5, got alpha:12) — re-validate");
    });

    it("reproduces each call site's trailing verb byte-identically when given an action", () => {
      withTxId(ctx, 12);
      // server.ts words this three ways across its six sites (applying / syncing /
      // scaffolding). The verb names the operation to redo, so threading it keeps
      // the token format the ONLY observable change at those sites.
      for (const action of ["applying", "syncing", "scaffolding"]) {
        const text = errorText(compareTxToken(ctx, "alpha:5", action)!);
        // Assert the whole payload, not just the first line: every rejection also
        // carries the current token as a footer, which is what each call site used
        // to append by hand. Matching only the message would let that footer
        // regress silently -- which is exactly how it was lost once already.
        expect(text).to.equal(
          `State changed (expected alpha:5, got alpha:12) — re-validate before ${action}\ntxId: alpha:12`,
        );
      }
    });

    it("carries the current token as a footer on every rejection path", () => {
      withTxId(ctx, 12);
      // Restores the pre-codec contract: each site rejected with
      // `{ extraLines: [txIdLine(ctx)] }` so a client could re-validate straight
      // away rather than making a second call to learn the value it was just
      // rejected against.
      for (const token of ["alpha:5", "beta:12", "not-a-token"]) {
        expect(errorText(compareTxToken(ctx, token)!), `rejection for ${token}`).to.match(/\ntxId: alpha:12$/);
      }
    });

    it("prefers the id-mismatch error over the counter-mismatch error when both would fire", () => {
      withTxId(ctx, 12);
      // beta:999 mismatches on BOTH id and counter — id mismatch must win, so
      // the message names 'beta' and 'alpha', not a "State changed" text.
      const result = compareTxToken(ctx, "beta:999");
      expect(result).to.not.equal(null);
      const text = errorText(result!);
      expect(text).to.not.include("State changed");
      expect(text).to.include("beta");
      expect(text).to.include("alpha");
    });

    // ── #217 boundary classes: the three observable MCP-boundary changes ────
    //
    // Class 1 and Class 3 are reject->reject (reworded/newly-classified);
    // Class 2 is the one disposition CHANGE the adoption makes (pre-change
    // this returned null and PASSED).

    it("Class 1: rejects a malformed id half with upstream's reworded message, not the old id-mismatch text", () => {
      withTxId(ctx, 5);
      // Pre-change this read `txId 'al pha:5' is for project 'al pha' but
      // this call targets project 'alpha'` — an id-mismatch message naming a
      // project the registry cannot hold (a space is invalid at
      // ProjectRegistry.add). Upstream rejects the malformed left half at
      // parse time instead.
      const result = compareTxToken(ctx, "al pha:5");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      expect(errorText(result!)).to.include("the project id must be non-empty");
    });

    it("Class 2: rejects a non-canonical counter shape the pre-adoption codec accepted", () => {
      withTxId(ctx, 5);
      // Pre-change `compareTxToken(ctx, "alpha:05")` returned null (passed).
      // Upstream's canonical-integer shape rejects the leading zero.
      const result = compareTxToken(ctx, "alpha:05");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      expect(errorText(result!)).to.include("canonical non-negative integer");
    });

    it("Class 3 / R8 (#221): rejects an out-of-range counter without falling through to 'State changed'", () => {
      withTxId(ctx, 5);
      // Pre-change the truncated counter fell through to the
      // counter-mismatch branch and produced `State changed (expected
      // alpha:9007199254740997, got alpha:5) — re-validate before
      // applying`. Upstream classifies this as counter-out-of-range at
      // parse time, before any counter comparison runs.
      const result = compareTxToken(ctx, "alpha:9007199254740993");
      expect(result).to.not.equal(null);
      expect(result!.isError).to.equal(true);
      const text = errorText(result!);
      expect(text).to.include("exceeds the maximum safe integer");
      expect(text).to.not.include("State changed");
    });
  });

  // ── R10 (#217): formatTxToken never throws at a site ProjectRegistry.add
  // admitted ──────────────────────────────────────────────────────────────
  //
  // formatTxToken now throws a TypeError on an invalid projectId or a
  // non-safe-integer counter (upstream's deliberate exception to its
  // otherwise never-throw contract). This guards the claim that chef's own
  // emission sites — which only ever mint a token for an id
  // ProjectRegistry.add already admitted, and a counter the watcher itself
  // produced — can never hit that throw path.
  //
  // Every row below asserts BOTH columns unconditionally, regardless of
  // which branch it would take. A conditional `if (admitted)
  // expect(isValidProjectId(id)).to.be.true` form is a TAUTOLOGY here: both
  // ProjectRegistry.add and formatTxToken call the same isValidProjectId, so
  // it would be true by construction and could never fail — and would
  // contribute NO assertion at all for the rejected rows, which is exactly
  // the mistake this table exists to not repeat.
  describe("R10: formatTxToken throws exactly where ProjectRegistry.add would already have rejected", () => {
    function addId(id: string): () => void {
      const registry = new ProjectRegistry();
      const fake = { id, root: "/fake", extractedDir: "/fake/extracted" } as unknown as ProjectContext;
      return () => registry.add(fake);
    }

    const idCases: Array<[id: string, addAdmits: boolean, formatThrows: boolean]> = [
      ["alpha", true, false],
      ["al pha", false, true],
      ["al\tpha", false, true],
      ["", false, true],
      ["al:pha", false, true],
      // isValidProjectId permits '/' and '=' — EXPLICIT_ID_RE (splitSpec)
      // excludes them only from what the explicit `<id>=<path>` branch can
      // PRODUCE, a different enforcement point. A row asserting these two
      // are rejected would be wrong.
      ["al/pha", true, false],
      ["al=pha", true, false],
    ];

    for (const [id, addAdmits, formatThrows] of idCases) {
      it(`id ${JSON.stringify(id)}: add admits=${addAdmits}, formatTxToken throws=${formatThrows}`, () => {
        if (addAdmits) {
          expect(addId(id), `add(${JSON.stringify(id)})`).to.not.throw();
        } else {
          expect(addId(id), `add(${JSON.stringify(id)})`).to.throw();
        }
        if (formatThrows) {
          expect(() => formatTxToken(id, 0), `formatTxToken(${JSON.stringify(id)}, 0)`).to.throw();
        } else {
          expect(() => formatTxToken(id, 0), `formatTxToken(${JSON.stringify(id)}, 0)`).to.not.throw();
        }
      });
    }

    // Independent throw path: the counter half, given a valid id.
    const counterCases: Array<[n: number, formatThrows: boolean]> = [
      [0, false],
      [5, false],
      [-1, true],
      [1.5, true],
      [NaN, true],
      [2 ** 53, true],
    ];

    for (const [n, formatThrows] of counterCases) {
      it(`counter ${n}: formatTxToken throws=${formatThrows}`, () => {
        if (formatThrows) {
          expect(() => formatTxToken("alpha", n), `formatTxToken("alpha", ${n})`).to.throw();
        } else {
          expect(() => formatTxToken("alpha", n), `formatTxToken("alpha", ${n})`).to.not.throw();
        }
      });
    }
  });
});
