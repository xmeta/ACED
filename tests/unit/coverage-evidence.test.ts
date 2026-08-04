import { describe, expect, test } from "vitest";
import { buildCoverageReceipt, buildEvidenceSnapshot } from "../../scripts/coverage-evidence.mjs";

const coverageSummary = {
  total: {
    statements: { total: 100, covered: 78, skipped: 0, pct: 78 },
    branches: { total: 80, covered: 56, skipped: 0, pct: 70 },
    functions: { total: 40, covered: 33, skipped: 0, pct: 82.5 },
    lines: { total: 90, covered: 73, skipped: 0, pct: 81.11 }
  }
};

const testResults = {
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTodoTestSuites: 0,
  numTotalTests: 3,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 1,
  numTodoTests: 0,
  testResults: [
    {
      assertionResults: [
        { fullName: "suite passes", status: "passed" },
        { fullName: "suite skips one", status: "skipped" },
        { fullName: "suite passes twice", status: "passed" }
      ]
    }
  ]
};

const environment = {
  GITHUB_REPOSITORY: "xmeta/ACED",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "12345",
  GITHUB_SERVER_URL: "https://github.com",
  SCWBS_TASK_ID: "SCWBS-DRAFT-MSE58C8K",
  SCWBS_PULL_REQUEST: "393",
  SCWBS_ARTIFACT_NAME: "coverage-abc",
  SCWBS_GENERATED_AT: "2026-08-04T00:00:00.000Z"
};

describe("coverage Evidence receipt", () => {
  test("records machine-readable coverage, skips, and trusted CI provenance", () => {
    const receipt = buildCoverageReceipt({ coverageSummary, testResults, environment });

    expect(receipt).toMatchObject({
      schemaVersion: "1.0.0",
      taskId: "SCWBS-DRAFT-MSE58C8K",
      pullRequest: "393",
      subjectHeadCommit: "a".repeat(40),
      workflowPath: ".github/workflows/scwbs.yml",
      workflowRunUrl: "https://github.com/xmeta/ACED/actions/runs/12345",
      testFiles: { total: 1, passed: 1, failed: 0, skipped: 0 },
      tests: { total: 3, passed: 2, failed: 0, skipped: 1 },
      metrics: { statements: { percent: 78 }, lines: { covered: 73 } },
      skippedTests: [{ name: "suite skips one", reason: "excluded or skipped by test selection" }]
    });
    expect(receipt.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(buildEvidenceSnapshot(receipt)).toEqual({
      schemaVersion: "1.0.0",
      type: "evidence-snapshot",
      taskId: "SCWBS-DRAFT-MSE58C8K",
      subjectHeadCommit: "a".repeat(40),
      pullRequest: "393",
      coverageReceipt: receipt
    });
  });

  test("fails closed when coverage or test counts are incomplete", () => {
    expect(() =>
      buildCoverageReceipt({
        coverageSummary: { total: { ...coverageSummary.total, lines: undefined } },
        testResults,
        environment
      })
    ).toThrow(/coverage summary is missing total.lines/);
    expect(() =>
      buildCoverageReceipt({
        coverageSummary,
        testResults: { ...testResults, numPendingTests: 2 },
        environment
      })
    ).toThrow(/test result counts do not add up/);
  });
});
