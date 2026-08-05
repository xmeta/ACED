import { CI_WORKFLOW_PATH, isRecord, originRepository, validRunUrl } from "./ci-receipt.js";
import type { CoverageReceipt, TaskContract } from "../../core/types.js";

export function verifyCoverageReceipt(
  root: string,
  task: TaskContract,
  taskId: string,
  receiptValue: unknown,
  expected: { pullRequest?: string; subjectHead: string }
): CoverageReceipt {
  const failures: string[] = [];
  if (!isRecord(receiptValue)) throw new Error("Coverage receipt rejected: JSON root must be an object");
  const receipt = receiptValue as Partial<CoverageReceipt>;
  const requiredStrings = [
    "repository", "command", "scope", "subjectHeadCommit", "workflowRunId", "workflowRunUrl", "artifactName", "payloadDigest", "generatedAt"
  ] as const;
  for (const key of requiredStrings) {
    if (typeof receipt[key] !== "string" || receipt[key].length === 0) failures.push(`${key} is missing`);
  }
  if (receipt.schemaVersion !== "1.0.0") failures.push("schemaVersion must be 1.0.0");
  if (receipt.workflowPath !== CI_WORKFLOW_PATH) failures.push(`workflowPath must be ${CI_WORKFLOW_PATH}`);
  if (receipt.taskId !== taskId) failures.push("taskId does not match the current Task");
  const expectedPullRequest = expected.pullRequest?.replace(/^#/, "");
  if (!expectedPullRequest || receipt.pullRequest !== expectedPullRequest) failures.push("pullRequest does not match the current PR");
  if (receipt.subjectHeadCommit !== expected.subjectHead) failures.push("subjectHeadCommit is stale or does not match the Evidence subject");
  if (typeof receipt.workflowRunId === "string" && !validRunUrl(receipt.workflowRunUrl, receipt.workflowRunId)) {
    failures.push("workflowRunUrl is invalid or does not identify workflowRunId");
  }
  if (typeof receipt.generatedAt === "string" && Number.isNaN(Date.parse(receipt.generatedAt))) failures.push("generatedAt is not a valid timestamp");
  if (typeof receipt.repository === "string") {
    try {
      if (receipt.repository !== originRepository(root)) failures.push("repository does not match origin");
    } catch (error) {
      failures.push(error instanceof Error ? error.message.replace(/^CI receipt rejected:\s*/, "") : "origin repository cannot be verified");
    }
  }
  if (typeof receipt.payloadDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.payloadDigest)) {
    failures.push("payloadDigest is not a valid SHA-256 digest");
  }
  if (!receipt.testFiles || !receipt.tests || !receipt.metrics) {
    failures.push("test counts and coverage metrics are required");
  } else {
    if (receipt.tests.failed !== 0 || receipt.testFiles.failed !== 0) failures.push("coverage receipt contains failed tests");
    for (const metric of ["statements", "branches", "functions", "lines"] as const) {
      const value = receipt.metrics[metric];
      if (!value || ![value.total, value.covered, value.skipped, value.percent].every((number) => typeof number === "number" && Number.isFinite(number))) {
        failures.push(`metrics.${metric} is incomplete`);
      }
    }
  }
  if (!Array.isArray(receipt.skippedTests) || receipt.skippedTests.some((entry) => !isRecord(entry) || typeof entry.name !== "string" || typeof entry.reason !== "string")) {
    failures.push("skippedTests must contain named reasons");
  }
  if (failures.length > 0) throw new Error(`Coverage receipt rejected:\n- ${failures.join("\n- ")}`);
  return receipt as CoverageReceipt;
}
