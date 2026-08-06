import { expect } from "chai";
import { runCli } from "./runCli.js";

// Smoke test for the runCli process-boundary helper (see its docstring for
// scope/rationale). Each case spawns a real `tsx src/cli.ts` subprocess, so
// keep the invocation count low.
describe("runCli helper (smoke)", function () {
  this.timeout(15000);

  it("returns exit code 0 and expected stdout for a known-good, read-only invocation", () => {
    const result = runCli(["list-addons", "--project-dir", "test/fixtures/addon-validate"]);
    expect(result.exitCode).to.equal(0);
    expect(result.stdout).to.match(/addon\(s\):/);
  });

  it("returns a non-zero exit code for an unknown subcommand", () => {
    const result = runCli(["totally-not-a-command", "--project-dir", "test/fixtures/addon-validate"]);
    expect(result.exitCode).to.not.equal(0);
    expect(result.stderr).to.match(/Unknown argument/);
  });
});
