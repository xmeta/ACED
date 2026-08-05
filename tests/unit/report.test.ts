import { describe, expect, test } from "vitest";
import { createBufferedStdoutReporter, printIssues, type Reporter } from "../../src/core/report.js";

describe("Reporter", () => {
  test("buffers stdout without replacing global output functions", () => {
    const originalLog = console.log;
    const originalWrite = process.stdout.write;
    const { reporter, output } = createBufferedStdoutReporter();

    reporter.log("one");
    reporter.write("two");
    reporter.write(new Uint8Array([116, 104, 114, 101, 101]));

    expect(output()).toBe("one\ntwothree");
    expect(console.log).toBe(originalLog);
    expect(process.stdout.write).toBe(originalWrite);
  });

  test("printIssues writes through the injected Reporter", () => {
    const lines: string[] = [];
    const reporter: Reporter = {
      log: (message) => lines.push(String(message)),
      error: () => undefined,
      write: () => undefined
    };

    printIssues([{
      severity: "error",
      code: "example.failure",
      message: "repair required",
      fixCommand: "npm run fix"
    }], reporter);

    expect(lines).toEqual([
      "ERROR example.failure: repair required",
      "  fixCommand: npm run fix"
    ]);
  });
});
