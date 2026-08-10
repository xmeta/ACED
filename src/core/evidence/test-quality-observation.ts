import { spawnSync } from "node:child_process";
import type { CoverageReceipt, TestQualityObservation } from "../types.js";

const testFilePattern = /(^|\/|\\)(tests?|__tests__)(\/|\\)|\.(test|spec)\.[cm]?[jt]sx?$/;
const addedMarkerPattern = /(?:\.skip|\.only|\.todo\b|\bskip\(|\bonly\(|\btodo\()/;

export type TestQualityObservationInput = {
  root: string;
  baseCommit?: string;
  subjectHead?: string;
  diffHash?: string;
  changedFiles: string[];
  currentCoverage?: CoverageReceipt;
  baselineCoverage?: CoverageReceipt;
};

function runGit(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout;
}

function changedTestFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((file) => testFilePattern.test(file.replace(/\\/g, "/")));
}

function testFileCounts(root: string, baseCommit: string | undefined, subjectHead: string | undefined, changedFiles: string[]) {
  const files = changedTestFiles(changedFiles);
  const counts = { filesAdded: 0, filesModified: 0, filesDeleted: 0 };
  if (!baseCommit || !subjectHead) return counts;
  const status = runGit(root, ["diff", "--name-status", "--find-renames", baseCommit, subjectHead, "--"]);
  for (const line of status.split("\n")) {
    const fields = line.split("\t");
    const code = fields[0]?.[0];
    const path = fields.at(-1)?.replace(/\\/g, "/");
    if (!code || !path || !testFilePattern.test(path)) continue;
    if (code === "A") counts.filesAdded += 1;
    else if (code === "D") counts.filesDeleted += 1;
    else counts.filesModified += 1;
  }
  if (files.length === 0) return counts;
  return counts;
}

function addedSkippedMarkers(root: string, baseCommit: string | undefined, subjectHead: string | undefined): number {
  if (!baseCommit || !subjectHead) return 0;
  const diff = runGit(root, ["diff", "--no-ext-diff", "--unified=0", "--no-color", baseCommit, subjectHead, "--"]);
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++")).filter((line) => addedMarkerPattern.test(line)).length;
}

function evaluatedCoverage(
  baseCommit: string | undefined,
  subjectHead: string | undefined,
  currentCoverage: CoverageReceipt | undefined,
  baselineCoverage: CoverageReceipt | undefined
): TestQualityObservation["coverage"] {
  if (!currentCoverage || !baselineCoverage || !baseCommit || !subjectHead) {
    return { status: "not-evaluated", reason: "verified base and subject coverage receipts are both required" };
  }
  if (currentCoverage.subjectHeadCommit !== subjectHead || baselineCoverage.subjectHeadCommit !== baseCommit) {
    return { status: "not-evaluated", reason: "coverage receipt provenance does not match the Evidence subject and base" };
  }
  const baselineLines = baselineCoverage.metrics.lines.percent;
  const subjectLines = currentCoverage.metrics.lines.percent;
  return {
    status: "evaluated",
    baselineSubjectHeadCommit: baselineCoverage.subjectHeadCommit,
    baselineLines,
    subjectLines,
    deltaLines: Number((subjectLines - baselineLines).toFixed(4)),
    source: "coverage-receipt"
  };
}

export function buildTestQualityObservation(input: TestQualityObservationInput): TestQualityObservation {
  const testCounts = testFileCounts(input.root, input.baseCommit, input.subjectHead, input.changedFiles);
  const skippedMarkersAdded = addedSkippedMarkers(input.root, input.baseCommit, input.subjectHead);
  const coverage = evaluatedCoverage(input.baseCommit, input.subjectHead, input.currentCoverage, input.baselineCoverage);
  const status = input.baseCommit && input.subjectHead && input.diffHash ? "evaluated" : "not-evaluated";
  return {
    version: "1",
    status,
    subject: {
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(input.subjectHead ? { headCommit: input.subjectHead } : {}),
      ...(input.diffHash ? { diffHash: input.diffHash } : {})
    },
    tests: { ...testCounts, skippedMarkersAdded },
    coverage,
    assertionDelta: { status: "not-evaluated", method: "phase-2-out-of-scope" }
  };
}
