import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { buildCoverageReceipt, buildEvidenceSnapshot } from "../../scripts/coverage-evidence.mjs";
import { buildTestQualityObservation } from "../../src/core/evidence/test-quality-observation.js";
import type { CoverageReceipt } from "../../src/core/types.js";
import { makeTempRepo, writeText } from "../helpers.js";

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

  test("observes changed test files, added disabled markers, and coverage improvement", () => {
    const root = makeTempRepo();
    writeText(root, "tests/example.test.ts", "test('old', () => expect(true).toBe(true));\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const disabledMarker = ["test", "only"].join(".") + "('old', () => expect(true).toBe(true));\n";
    writeText(root, "tests/example.test.ts", disabledMarker);
    writeText(root, "tests/new.test.ts", "test('new', () => expect(true).toBe(true));\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "subject"], { cwd: root });
    const subjectHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const observation = buildTestQualityObservation({
      root,
      baseCommit,
      subjectHead,
      diffHash: "sha256:diff",
      changedFiles: ["tests/example.test.ts", "tests/new.test.ts"],
      baselineCoverage: { subjectHeadCommit: baseCommit, metrics: { lines: { percent: 78 } } } as unknown as CoverageReceipt,
      currentCoverage: { subjectHeadCommit: subjectHead, metrics: { lines: { percent: 79.5 } } } as unknown as CoverageReceipt
    });

    expect(observation).toMatchObject({
      status: "evaluated",
      tests: { filesAdded: 1, filesModified: 1, filesDeleted: 0, skippedMarkersAdded: 1 },
      coverage: { status: "evaluated", baselineLines: 78, subjectLines: 79.5, deltaLines: 1.5 }
    });
    const regressed = buildTestQualityObservation({
      root,
      baseCommit,
      subjectHead,
      diffHash: "sha256:diff",
      changedFiles: ["tests/example.test.ts", "tests/new.test.ts"],
      baselineCoverage: { subjectHeadCommit: baseCommit, metrics: { lines: { percent: 78 } } } as unknown as CoverageReceipt,
      currentCoverage: { subjectHeadCommit: subjectHead, metrics: { lines: { percent: 76 } } } as unknown as CoverageReceipt
    });
    expect(regressed.coverage.deltaLines).toBe(-2);
  }, 15000);

  test("does not invent coverage values when a verified baseline is unavailable", () => {
    const root = makeTempRepo();
    const observation = buildTestQualityObservation({
      root,
      baseCommit: "a".repeat(40),
      subjectHead: "b".repeat(40),
      diffHash: "sha256:diff",
      changedFiles: ["tests/example.test.ts"]
    });

    expect(observation.coverage).toEqual({
      status: "not-evaluated",
      reason: "verified base and subject coverage receipts are both required"
    });
    expect(observation.coverage.baselineLines).toBeUndefined();
    expect(observation.coverage.deltaLines).toBeUndefined();
  });
});
