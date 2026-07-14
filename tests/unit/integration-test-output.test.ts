import { describe, expect, it } from "vitest";
// @ts-expect-error The production output controller is intentionally dependency-free ESM.
import { FAILURE_LIMIT, formatFailureDiagnostics, parseArgs } from "../../scripts/integration-test-output.mjs";
// @ts-expect-error The production runner is intentionally dependency-free ESM.
import { formatSummary, normalizeReport } from "../../scripts/integration-test-run.mjs";

function result(status: "passed" | "failed", count = 32) {
  return {
    success: status === "passed",
    numTotalTests: count,
    numPassedTests: status === "passed" ? count : count - 1,
    numFailedTests: status === "failed" ? 1 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{
      name: `${process.cwd()}/tests/integration/misc.test.ts`,
      status,
      startTime: 0,
      endTime: 1_500,
      assertionResults: Array.from({ length: count }, (_, index) => ({
        fullName: `representative test ${index + 1}`,
        status: status === "failed" && index === 0 ? "failed" : "passed",
        duration: 10,
        failureMessages: status === "failed" && index === 0 ? [`expected value\n${"x".repeat(2_000)}`] : []
      }))
    }]
  };
}

describe("integration output controller", () => {
  it("keeps a representative successful suite within the line and byte budget", () => {
    const output = formatSummary(normalizeReport(result("passed"), 2_000, 4), 5);
    expect(output.split("\n").length).toBeLessThanOrEqual(11);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2_048);
  });

  it("shows a bounded cause and copyable rerun command on failure", () => {
    const raw = result("failed");
    const output = formatFailureDiagnostics(raw, { totalBytes: 12_000, text: "stdout head\n... 8000 bytes omitted ...\nstdout tail" }, { totalBytes: 20, text: "stderr detail" });
    expect(output).toContain("failed test=tests/integration/misc.test.ts :: representative test 1");
    expect(output).toContain("cause=expected value");
    expect(output).toContain("rerun=npx vitest run tests/integration/misc.test.ts");
    expect(output).toContain("stdout bytes=12000");
    expect(output.split("\n").length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(6_000);
  });

  it("limits diagnostics when several tests fail", () => {
    const raw = result("passed", FAILURE_LIMIT + 2);
    raw.success = false;
    raw.numPassedTests = 0;
    raw.numFailedTests = FAILURE_LIMIT + 2;
    for (const assertion of raw.testResults[0].assertionResults) {
      assertion.status = "failed";
      assertion.failureMessages = ["failure"];
    }
    const output = formatFailureDiagnostics(raw, { totalBytes: 0, text: "" }, { totalBytes: 0, text: "" });
    expect(output).toContain("failed tests omitted=2");
    expect(output.match(/^failed test=/gm)).toHaveLength(FAILURE_LIMIT);
  });

  it("exposes full logs only through explicit verbose mode", () => {
    expect(parseArgs(["--verbose", "--workers", "2"], {})).toMatchObject({ verbose: true, workers: 2 });
    expect(parseArgs([], { SCWBS_INTEGRATION_WORKERS: "2" })).toMatchObject({ verbose: false, workers: 2 });
    expect(() => parseArgs(["--verbose", "--report", "out.json"], {})).toThrow(/cannot be combined/);
  });
});
