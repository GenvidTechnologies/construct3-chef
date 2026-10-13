/**
 * Write ledger for a mutation that FAILED (non-cancel) part-way (#255).
 *
 * A mutation marks what it MAY have written, before it writes. The rule is
 * conservative: a mark means a write MAY have happened, not that one did.
 *
 * - `source` — set before any C3 source write (eventSheets/layouts/
 *   objectTypes/ts-defs).
 * - `manifest` — set before a `project.c3proj` write. That bumps the txId but
 *   does not dirty `extracted/`, following the existing c3proj convention
 *   (sync-addon-metadata bumps without marking dirty).
 * - `extracted` — set before generators run.
 *
 * Off-barrel deliberately: server-internal, not library API.
 */
export interface WriteLedger {
  source: boolean;
  manifest: boolean;
  extracted: boolean;
}

/** A fresh, all-false ledger (a new object each call). */
export function newWriteLedger(): WriteLedger {
  return { source: false, manifest: false, extracted: false };
}

/** What a FAILED (non-cancel) mutation must do, given what it MAY have written. */
export function failureEffects(w: WriteLedger): { bump: boolean; dirty: boolean } {
  return { bump: w.source || w.manifest, dirty: w.source || w.extracted };
}
