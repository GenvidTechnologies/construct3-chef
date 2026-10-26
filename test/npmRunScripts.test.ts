import { describe, it } from "mocha";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Guards `src/` against telling the user to run an `npm run <name>` script
 * that `package.json` does not define.
 *
 * Why this exists: user-facing strings and comments in `src/` keep naming
 * scripts that were renamed or never existed, and nothing else reads that
 * prose. This is the fourth instance of the class: #240 (`sync-c3proj`),
 * #246 (`generate-dsl`), the `generate-c3` hint in `sidUtils`, and #286
 * (`generate-c3` in three `server.ts` messages). The hint is shown exactly
 * when the user is already stuck, so a dead command is worst there.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// A script name is word characters, `:` and `-`, so trailing punctuation
// (`npm run build.`, `npm run test,`) is not swallowed.
const NPM_RUN = /npm run ([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*)/g;

interface Occurrence {
  file: string;
  line: number;
  name: string;
}

function trackedSrcFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src/"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function occurrences(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of trackedSrcFiles()) {
    const lines = readFileSync(path.join(REPO_ROOT, file), "utf-8").split("\n");
    lines.forEach((text, i) => {
      for (const m of text.matchAll(NPM_RUN)) found.push({ file, line: i + 1, name: m[1] });
    });
  }
  return found;
}

describe("npm run references in src/", () => {
  it("G286-R3: every `npm run <name>` in src/ names a package.json script", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const scripts = new Set(Object.keys(pkg.scripts));
    const violations = occurrences()
      .filter((o) => !scripts.has(o.name))
      .map((o) => `${o.file}:${o.line} npm run ${o.name}`);
    expect(
      violations,
      `src/ names npm scripts that package.json does not define:\n  ${violations.join("\n  ")}`,
    ).to.deep.equal([]);
  });

  it("G286-R5: the scan found at least one `npm run` occurrence (an empty corpus cannot pass)", () => {
    expect(
      occurrences().length,
      "no `npm run` found in src/ — the walk or the pattern has gone stale",
    ).to.be.greaterThan(0);
  });
});
