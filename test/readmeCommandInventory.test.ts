import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards the README's CLI inventory against `src/cli.ts`.
 *
 * Why this exists: `README.md` is what npmjs.com renders for the published
 * package, and its command table had silently fallen three commands behind
 * (`list-addons`, `diff-addon-aces`, `scan-addon-usage` — the whole read-only
 * half of the #100 addon-tooling cluster) while claiming "17 subcommands"
 * against an actual 21. Adding a subcommand touches ~6 sites; four of them
 * drifted without anything going red.
 *
 * `CLAUDE.md` documents the analogous "adding a generator touches ~10 sites in
 * lockstep" — and that lockstep is documented and *still* drifts. Documentation
 * alone demonstrably does not hold this invariant, so it is asserted instead.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "cli.ts");
const README_PATH = path.join(REPO_ROOT, "README.md");

/**
 * Command names registered via yargs in `src/cli.ts`.
 *
 * The registrations are **multi-line** — `.command(` sits on its own line and
 * the command string is on the next — which is exactly why casual grepping
 * missed the drift. Match across the newline, then keep the leading token so
 * positional args (`diff-addon-aces <from> <to>`) reduce to the bare name.
 */
function registeredCommands(): string[] {
  const src = readFileSync(CLI_PATH, "utf-8");
  const names = [...src.matchAll(/\.command\(\s*\n\s*"([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]);
  return [...new Set(names)].sort();
}

/**
 * Command names in the README's `## CLI Overview` table.
 *
 * Scoped to that section deliberately: the file also carries an MCP **tool**
 * table, whose names overlap but are a different surface (`read-dsl`,
 * `resolve-anchor`, … are tools, never subcommands). Matching table rows
 * file-wide would conflate the two and make this assertion meaningless.
 */
function readmeCommands(): string[] {
  const readme = readFileSync(README_PATH, "utf-8");
  const start = readme.indexOf("## CLI Overview");
  expect(start, "README is missing its '## CLI Overview' heading").to.be.greaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);

  const names = [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1].split(/\s+/)[0]);
  return [...new Set(names)].sort();
}

describe("README CLI inventory", () => {
  it("documents every command src/cli.ts registers", () => {
    const missing = registeredCommands().filter((c) => !readmeCommands().includes(c));
    expect(
      missing,
      `Registered in src/cli.ts but absent from the README '## CLI Overview' table: ${missing.join(", ")}. ` +
        `Add a row for each, and update the subcommand count in the same section.`,
    ).to.deep.equal([]);
  });

  it("does not document a command src/cli.ts no longer registers", () => {
    const stale = readmeCommands().filter((c) => !registeredCommands().includes(c));
    expect(
      stale,
      `Listed in the README '## CLI Overview' table but not registered in src/cli.ts: ${stale.join(", ")}. ` +
        `Remove the row, or restore the registration if the removal was accidental.`,
    ).to.deep.equal([]);
  });

  it("states a subcommand count matching the registered total", () => {
    const readme = readFileSync(README_PATH, "utf-8");
    const stated = readme.match(/^(\d+) subcommands\b/m);
    expect(stated, "README's '## CLI Overview' no longer states an 'N subcommands' count").to.not.equal(null);
    expect(
      Number(stated![1]),
      `README says "${stated![1]} subcommands" but src/cli.ts registers ${registeredCommands().length}.`,
    ).to.equal(registeredCommands().length);
  });

  it("finds a plausible number of commands on both sides (guards the parsers themselves)", () => {
    // Without this, a regex that silently stops matching — a formatting change
    // in either file — would make both set comparisons above pass vacuously on
    // two empty sets. Same trap as the uistate assertions in #149.
    expect(
      registeredCommands().length,
      "parsed no commands out of src/cli.ts — the regex has gone stale",
    ).to.be.greaterThan(15);
    expect(
      readmeCommands().length,
      "parsed no commands out of the README table — the regex has gone stale",
    ).to.be.greaterThan(15);
  });
});
