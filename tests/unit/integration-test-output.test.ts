import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAILURE_LIMIT, formatFailureDiagnostics, parseArgs } from "../../scripts/integration-test-output.mjs";
import { formatSummary, formatTempDiagnostic, normalizeReport } from "../../scripts/integration-test-run.mjs";
import {
  acquireIntegrationRun,
  integrationLockPath,
  releaseIntegrationRun,
  runWithIntegrationSingleFlight
} from "../../scripts/integration-single-flight.mjs";

function temporaryRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "scwbs-integration-lock-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

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

  it("keeps the temp diagnostic to one bounded line", () => {
    const output = formatTempDiagnostic({ path: "/tmp", source: "wsl-linux-fallback" });
    expect(output).toBe("integration temp=/tmp tempSource=wsl-linux-fallback");
    expect(output.split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(output)).toBeLessThan(256);
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
    expect(parseArgs(["--verbose", "--wait", "--workers", "2"], {})).toMatchObject({ verbose: true, wait: true, workers: 2 });
    expect(parseArgs([], { SCWBS_INTEGRATION_WORKERS: "2" })).toMatchObject({ verbose: false, wait: false, workers: 2 });
    expect(() => parseArgs(["--verbose", "--report", "out.json"], {})).toThrow(/cannot be combined/);
  });

  it("shares one repository lock across direct and inherited required-check runs", async () => {
    const root = temporaryRepository();
    const lease = await acquireIntegrationRun(root, { mode: "default", workers: 4, env: {} });
    try {
      await expect(acquireIntegrationRun(root, { mode: "verbose", workers: 2, env: {} })).rejects.toThrow(
        /integration already active.*pid=.*startedAt=.*mode=default workers=4 elapsed=/
      );
      const inherited = await acquireIntegrationRun(root, {
        mode: "verbose",
        workers: 2,
        env: {
          SCWBS_REQUIRED_CHECK_RUN_ID: lease.runId,
          SCWBS_REQUIRED_CHECK_LOCK_PATH: lease.lockPath
        }
      });
      expect(inherited).toMatchObject({ owned: false, runId: lease.runId, state: { mode: "verbose", workers: 2 } });
      releaseIntegrationRun(inherited);
      expect(existsSync(lease.lockPath)).toBe(true);
    } finally {
      releaseIntegrationRun(lease);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for an active run and safely recovers a stale PID lock", async () => {
    const root = temporaryRepository();
    const first = await acquireIntegrationRun(root, { mode: "default", workers: 4, env: {} });
    const messages: string[] = [];
    setTimeout(() => releaseIntegrationRun(first), 20);
    const waited = await acquireIntegrationRun(root, {
      mode: "verbose",
      workers: 2,
      env: {},
      wait: true,
      waitPollMs: 5,
      waitReportMs: 5,
      onWait: (message: string) => messages.push(message)
    });
    expect(messages[0]).toMatch(/integration waiting.*mode=default workers=4/);
    releaseIntegrationRun(waited);

    const lockPath = integrationLockPath(root);
    writeFileSync(lockPath, JSON.stringify({
      runId: "stale",
      pid: 999_999_999,
      taskId: "direct-integration",
      startedAt: "2026-01-01T00:00:00.000Z",
      mode: "default",
      workers: 4
    }));
    const recovered = await acquireIntegrationRun(root, { mode: "default", workers: 4, env: {} });
    expect(recovered.owned).toBe(true);
    releaseIntegrationRun(recovered);
    rmSync(root, { recursive: true, force: true });
  });

  it("releases only its own lock after a failed fake integration action", async () => {
    const root = temporaryRepository();
    const lockPath = integrationLockPath(root);
    await expect(runWithIntegrationSingleFlight(root, { mode: "default", workers: 4, env: {} }, async () => {
      throw new Error("fake integration failure");
    })).rejects.toThrow("fake integration failure");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
