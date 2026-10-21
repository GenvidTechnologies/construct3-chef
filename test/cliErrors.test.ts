import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import yargs from "yargs";

import { formatCliError, guardAllHandlers } from "../src/cliErrors.js";

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
});
