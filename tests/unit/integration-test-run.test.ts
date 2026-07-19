import { describe, expect, it } from "vitest";
// @ts-expect-error The production runner is intentionally a dependency-free ESM script.
import {
  SERIAL_WITHIN_FILE,
  buildVitestArgs,
  defaultWorkerCount,
  formatSummary,
  normalizeReport,
  parseArgs
} from "../../scripts/integration-test-run.mjs";

describe("integration test runner", () => {
  it("uses fork isolation with serial file scheduling, at least two workers, and no retry", () => {
    const workers = defaultWorkerCount();
    const args = buildVitestArgs({ workers, outputFile: "/tmp/results.json" });
    expect(workers).toBeGreaterThanOrEqual(2);
    expect(args).toContain(`--maxWorkers=${workers}`);
    expect(args).toContain("--pool=forks");
    expect(args).toContain("--no-file-parallelism");
    expect(args.join(" ")).not.toMatch(/retry/i);
  });

  it("keeps representative process-global tests serial within their file", () => {
    expect(SERIAL_WITHIN_FILE["tests/integration/tasks.test.ts"]).toBe("process.chdir");
    expect(SERIAL_WITHIN_FILE["tests/integration/evidence.test.ts"]).toBe("stdout/stderr");
    expect(SERIAL_WITHIN_FILE["tests/integration/review.test.ts"]).toContain("process.env");
  });

  it("validates bounded runner options", () => {
    expect(parseArgs(["--workers", "2", "--slowest", "3", "--report", "out.json"], {})).toEqual({ workers: 2, slowest: 3, reportPath: "out.json" });
    expect(() => parseArgs(["--workers", "1"], {})).toThrow(/between 2 and 4/);
    expect(() => parseArgs(["--workers", "5"], {})).toThrow(/between 2 and 4/);
    expect(() => parseArgs(["--slowest", "21"], {})).toThrow(/between 0 and 20/);
  });

  it("creates a bounded summary and reproducible file/test duration report", () => {
    const raw = {
      success: true,
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: `${process.cwd()}/tests/integration/slow.test.ts`, status: "passed", startTime: 100, endTime: 2100,
          assertionResults: [{ fullName: "slow test", status: "passed", duration: 1900 }]
        },
        {
          name: `${process.cwd()}/tests/integration/fast.test.ts`, status: "passed", startTime: 100, endTime: 200,
          assertionResults: [{ fullName: "fast one", status: "passed", duration: 50 }, { fullName: "fast two", status: "passed", duration: 40 }]
        }
      ]
    };
    const report = normalizeReport(raw, 2500, 4);
    const summary = formatSummary(report, 1);
    expect(report.files.map((entry) => entry.file)).toEqual(["tests/integration/slow.test.ts", "tests/integration/fast.test.ts"]);
    expect(report.tests[0]).toMatchObject({ name: "slow test", durationMs: 1900 });
    expect(summary.split("\n")).toHaveLength(3);
    expect(summary).toContain("duration=2.50s");
    expect(summary).toContain("slow file=tests/integration/slow.test.ts");
    expect(summary).toContain("slow test=tests/integration/slow.test.ts :: slow test");
  });
});
