import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import yargs from "yargs";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { formatCliError, guardAllHandlers } from "../src/cliErrors.js";
import { runCli } from "./helpers/runCli.js";

// #266: CLI handler errors are rendered as a single "Error: <message>" line with exit 1,
// never a stack trace.

describe("cliErrors", () => {
  describe("unit", () => {
    it("CE15: formatCliError renders the message verbatim, never the stack or cause", () => {
      expect(formatCliError(new Error("a\nb"))).to.equal("Error: a\nb");
      expect(formatCliError("plain")).to.equal("Error: plain");

      const withCause = formatCliError(new Error("x", { cause: new Error("SECRET") }));
      expect(withCause).to.equal("Error: x");
      expect(withCause).to.not.include("SECRET");
      expect(withCause).to.not.match(/^\s+at /m);

      expect(formatCliError(new TypeError("bad type"))).to.equal("Error: bad type");
    });

    describe("late registration", () => {
      const savedExitCode = process.exitCode;
      afterEach(() => {
        process.exitCode = savedExitCode;
      });

      async function runLate(name: string, handler: () => void | Promise<void>): Promise<string[]> {
        const sink: string[] = [];
        const y = guardAllHandlers(yargs([]).exitProcess(false), (err) => sink.push(formatCliError(err)));
        y.command(name, "late command", {}, handler);
        await y.parseAsync([name]);
        return sink;
      }

      it("CE16: a command registered after the guard is covered (sync throw and async reject)", async () => {
        const before = process.exitCode;

        const syncSink = await runLate("late", () => {
          throw new Error("late boom");
        });
        expect(syncSink).to.deep.equal(["Error: late boom"]);

        const asyncSink = await runLate("late-async", async () => {
          throw new Error("late async");
        });
        expect(asyncSink).to.deep.equal(["Error: late async"]);

        expect(process.exitCode).to.equal(before);
      });
    });
  });

  describe("spawn", function () {
    this.timeout(60000);

    const created: string[] = [];
    afterEach(() => {
      while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
    });

    function tmp(): string {
      const d = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "c3chef-clierr-"));
      created.push(d);
      return d;
    }

    function lines(s: string): string[] {
      return s
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => l !== "");
    }

    function lastLine(s: string): string {
      const l = lines(s);
      return l[l.length - 1];
    }

    function errCount(s: string): number {
      return (s.replace(/\r\n/g, "\n").match(/^Error: /gm) ?? []).length;
    }

    function writeOp(d: string): void {
      mkdirSync(path.join(d, "ops"));
      writeFileSync(path.join(d, "ops", "noop.json"), '{"description":"x","params":[],"recipe":{"files":{}}}');
    }

    it("CE1: sync-project on a project with no manifest renders one Error line", () => {
      const d = tmp();
      const r = runCli(["sync-project", "--project-dir", d]);
      expect({ exitCode: r.exitCode, stderr: r.stderr.trimEnd(), stdout: r.stdout }).to.deep.equal({
        exitCode: 1,
        stderr: "Error: Could not read " + path.join(d, "project.c3proj"),
        stdout: "",
      });
    });

    it("CE2: list-templates renders an errno failure as one line", () => {
      const d = tmp();
      const r = runCli(["list-templates", "--project-dir", d]);
      const stderr = r.stderr.replace(/\r\n/g, "\n").trimEnd();
      expect({
        exitCode: r.exitCode,
        oneLine: !stderr.includes("\n"),
        matches: /^Error: ENOENT: no such file or directory, scandir '.+layouts'$/.test(stderr),
        hasErrno: r.stderr.includes("errno:"),
      }).to.deep.equal({ exitCode: 1, oneLine: true, matches: true, hasErrno: false });
    });

    it("CE3: apply-recipe with a missing file renders one Error line, no help", () => {
      const d = tmp();
      const r = runCli(["apply-recipe", path.join(d, "missing.json"), "--project-dir", d]);
      expect({
        exitCode: r.exitCode,
        stderr: r.stderr.trimEnd(),
        hasOptions: r.stderr.includes("Options:"),
      }).to.deep.equal({
        exitCode: 1,
        stderr: "Error: ENOENT: no such file or directory, open '" + path.join(d, "missing.json") + "'",
        hasOptions: false,
      });
    });

    it("CE4: generate keeps its stdout header and reports one Error line", () => {
      const d = tmp();
      const r = runCli(["generate", "--project-dir", d]);
      const errLines = lines(r.stderr);
      expect({
        exitCode: r.exitCode,
        stdoutHead: r.stdout.startsWith("=== Generating C3 extracted files ==="),
        stderrLines: errLines.length,
        first: errLines[0]?.startsWith("Error: ENOENT"),
      }).to.deep.equal({ exitCode: 1, stdoutHead: true, stderrLines: 1, first: true });
    });

    const yargsShape = (r: { exitCode: number; stderr: string }) => {
      const l = lines(r.stderr);
      return {
        exitCode: r.exitCode,
        hasOptions: r.stderr.includes("Options:"),
        last: l[l.length - 1],
        errorPrefixed: errCount(r.stderr),
      };
    };

    it("CE5: an unknown argument keeps yargs' usage output", () => {
      const d = tmp();
      const r = runCli(["list-addons", "--bogus", "--project-dir", d]);
      expect(yargsShape(r)).to.deep.equal({
        exitCode: 1,
        hasOptions: true,
        last: "Unknown argument: bogus",
        errorPrefixed: 0,
      });
    });

    it("CE6: a failed .check() keeps yargs' usage output", () => {
      const d = tmp();
      const r = runCli(["rename-symbol", "--project-dir", d]);
      expect(yargsShape(r)).to.deep.equal({
        exitCode: 1,
        hasOptions: true,
        last: "Provide either <from> <to> arguments or --replacements <file>",
        errorPrefixed: 0,
      });
    });

    it("CE7: a coerce failure keeps yargs' usage output", () => {
      const d = tmp();
      const r = runCli(["validate-addons", "--skip-gate", "nope", "--project-dir", d]);
      expect(yargsShape(r)).to.deep.equal({
        exitCode: 1,
        hasOptions: true,
        last: "Invalid --skip-gate value(s): 'nope'. Valid families: metadata, integrity, package-consistency, lang.",
        errorPrefixed: 0,
      });
    });

    it("CE8: an empty replacement 'from' is reported with a single Error prefix", () => {
      const d = tmp();
      const rf = path.join(d, "r.json");
      writeFileSync(rf, '[{"from":"","to":"x"}]');
      const r = runCli(["rename-symbol", "--replacements", rf, "--project-dir", d]);
      expect({ exitCode: r.exitCode, stderr: r.stderr.trimEnd() }).to.deep.equal({
        exitCode: 1,
        stderr: "Error: replacement 'from' field must be non-empty",
      });
      const src = readFileSync(path.resolve("src/c3/recipeApplier.ts"), "utf-8");
      expect({
        prefixed: src.split("Error: replacement 'from'").length - 1,
        message: src.split("replacement 'from' field must be non-empty").length - 1 >= 1,
      }).to.deep.equal({ prefixed: 0, message: true });
    });

    it("CE9: server startup failure is prefixed and writes nothing to stdout", () => {
      const d = tmp();
      const r = runCli(["server", "--project-dir", d, "--default-project", "bogus"]);
      expect({ exitCode: r.exitCode, stdout: r.stdout, last: lastLine(r.stderr) }).to.deep.equal({
        exitCode: 1,
        stdout: "",
        last: "Error: Cannot set defaultId to unregistered project id 'bogus'.",
      });
    });

    it("CE10: validate-project keeps its local report-then-continue behaviour", () => {
      const d = tmp();
      const r = runCli(["validate-project", "--project-dir", d]);
      expect({
        exitCode: r.exitCode,
        stderr: r.stderr.trimEnd(),
        images: r.stdout.includes("[images]"),
        strays: r.stdout.includes("[strays]"),
      }).to.deep.equal({
        exitCode: 1,
        stderr: "Could not read " + path.join(d, "project.c3proj"),
        images: true,
        strays: true,
      });
    });

    it("CE11: apply-op with a malformed --param renders one Error line, no help", () => {
      const d = tmp();
      writeOp(d);
      const r = runCli(["apply-op", "noop", "--param", "novalue", "--project-dir", d]);
      expect({
        exitCode: r.exitCode,
        stderr: r.stderr.trimEnd(),
        hasOptions: r.stderr.includes("Options:"),
      }).to.deep.equal({
        exitCode: 1,
        stderr: 'Error: --param "novalue" is not in KEY=VALUE format',
        hasOptions: false,
      });
    });

    it("CE12: apply-op for an unknown op lists the available ones", () => {
      const d = tmp();
      writeOp(d);
      const r = runCli(["apply-op", "nope", "--project-dir", d]);
      expect({ exitCode: r.exitCode, stderr: r.stderr.trimEnd() }).to.deep.equal({
        exitCode: 1,
        stderr: 'Error: op "nope" not found. Available: noop',
      });
    });

    it("CE13: search-dsl reports an invalid regex through its own handler", () => {
      const d = tmp();
      const r = runCli(["search-dsl", "(", "--project-dir", d]);
      expect({ exitCode: r.exitCode, stderrLines: lines(r.stderr) }).to.deep.equal({
        exitCode: 1,
        stderrLines: ["Invalid regex: (", "Invalid regular expression: /(/: Unterminated group"],
      });
    });

    it("CE18: the guard is installed on the root yargs instance", () => {
      const src = readFileSync(path.resolve("src/cli.ts"), "utf-8");
      expect(src.split("guardAllHandlers(yargs(hideBin(process.argv)))").length - 1).to.equal(1);
    });
  });
});
