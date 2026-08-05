import { spawnSync } from "node:child_process";
import { changedFilesBetween, isCommitAncestor, resolveCommit } from "../../core/git.js";
import { taskAuthorityFingerprint } from "../../commands/ci-plan.js";
import { taskLifecycleMetadataPaths } from "../../core/managed-contract-paths.js";
import type { CiReceipt, TaskContract } from "../../core/types.js";

export const CI_WORKFLOW_PATH = ".github/workflows/scwbs.yml";
export const CI_JOB_NAMES = ["core", "integration", "wjs", "validate"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validRunUrl(value: unknown, runId: string): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.includes(`/actions/runs/${runId}`);
  } catch {
    return false;
  }
}

function normalizedGithubRepository(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return match?.[1];
}

export function originRepository(root: string): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("CI receipt rejected: origin repository cannot be verified");
  const repository = normalizedGithubRepository(result.stdout);
  if (!repository) throw new Error("CI receipt rejected: origin is not a GitHub repository");
  return repository;
}

export function verifyCiReceipt(
  root: string,
  task: TaskContract,
  taskId: string,
  receiptValue: unknown,
  expected: { pullRequest?: string; head: string; baseRef: string; baseCommit: string; diffHash: string }
): CiReceipt {
  const failures: string[] = [];
  if (!isRecord(receiptValue)) throw new Error("CI receipt rejected: JSON root must be an object");
  const receipt = receiptValue as Partial<CiReceipt>;
  const requiredStrings = [
    "repository", "pullRequest", "taskId", "headCommit", "baseRef", "baseCommit", "diffHash",
    "authorityFingerprint", "workflowPath", "workflowRunId", "workflowRunUrl", "trustedCommit", "retrievedAt"
  ] as const;
  for (const key of requiredStrings) {
    if (typeof receipt[key] !== "string" || receipt[key].length === 0) failures.push(`${key} is missing`);
  }
  if (receipt.schemaVersion !== "1.0.0") failures.push("schemaVersion must be 1.0.0");
  if (receipt.verifiedBy !== "github-actions-provenance") failures.push("verifiedBy is not the GitHub provenance verifier");
  if (receipt.taskId !== taskId) failures.push("taskId does not match the current Task");
  if (receipt.pullRequest !== expected.pullRequest || !expected.pullRequest) failures.push("pullRequest does not match the current PR");
  if (receipt.headCommit !== expected.head) failures.push("headCommit is stale or does not match HEAD");
  if (receipt.baseRef !== expected.baseRef) failures.push("baseRef does not match the requested base");
  if (receipt.baseCommit !== expected.baseCommit) failures.push("baseCommit does not match the verified merge base");
  if (receipt.diffHash !== expected.diffHash) failures.push("diffHash does not match the current implementation diff");
  if (receipt.authorityFingerprint !== taskAuthorityFingerprint(task)) failures.push("authorityFingerprint does not match the current Task authority");
  if (receipt.workflowPath !== CI_WORKFLOW_PATH) failures.push(`workflowPath must be ${CI_WORKFLOW_PATH}`);
  if (typeof receipt.workflowRunId === "string" && !validRunUrl(receipt.workflowRunUrl, receipt.workflowRunId)) {
    failures.push("workflowRunUrl is invalid or does not identify workflowRunId");
  }
  if (typeof receipt.retrievedAt === "string" && Number.isNaN(Date.parse(receipt.retrievedAt))) failures.push("retrievedAt is not a valid timestamp");
  if (typeof receipt.repository === "string") {
    try {
      if (receipt.repository !== originRepository(root)) failures.push("repository does not match origin");
    } catch (error) {
      failures.push(error instanceof Error ? error.message.replace(/^CI receipt rejected:\s*/, "") : "origin repository cannot be verified");
    }
  }

  if (!Array.isArray(receipt.jobs)) {
    failures.push("jobs must be an array");
  } else {
    const names = receipt.jobs.map((job) => isRecord(job) ? job.name : undefined);
    if (receipt.jobs.length !== CI_JOB_NAMES.length || new Set(names).size !== CI_JOB_NAMES.length || !CI_JOB_NAMES.every((name) => names.includes(name))) {
      failures.push("jobs must contain exactly core, integration, wjs, and validate once each");
    }
    const jobIds = new Set<string>();
    const checkNames: string[] = [];
    for (const [index, jobValue] of receipt.jobs.entries()) {
      if (!isRecord(jobValue)) {
        failures.push(`jobs[${index}] must be an object`);
        continue;
      }
      const job = jobValue as Partial<CiReceipt["jobs"][number]>;
      if (typeof job.jobId !== "string" || job.jobId.length === 0 || jobIds.has(job.jobId)) failures.push(`jobs[${index}].jobId must be unique`);
      else jobIds.add(job.jobId);
      if (job.conclusion !== "success") failures.push(`jobs[${index}] did not conclude successfully`);
      if (job.workflowRunId !== receipt.workflowRunId) failures.push(`jobs[${index}] belongs to a different workflow run`);
      if (job.workflowPath !== CI_WORKFLOW_PATH) failures.push(`jobs[${index}] belongs to a different workflow`);
      if (typeof job.url !== "string" || typeof receipt.workflowRunId !== "string" || !validRunUrl(job.url, receipt.workflowRunId)) failures.push(`jobs[${index}].url is invalid`);
      if (!Array.isArray(job.checkNames) || job.checkNames.some((name) => typeof name !== "string") || new Set(job.checkNames).size !== (job.checkNames?.length ?? 0)) {
        failures.push(`jobs[${index}].checkNames must be unique strings`);
      } else {
        checkNames.push(...job.checkNames);
      }
    }
    const required = [...task.requiredChecks].sort();
    const mapped = [...checkNames].sort();
    if (required.length !== mapped.length || required.some((name, index) => mapped[index] !== name)) failures.push("required checks do not have an exact one-to-one job mapping");
  }

  if (typeof receipt.trustedCommit === "string") {
    if (!resolveCommit(root, receipt.trustedCommit)) failures.push("trustedCommit is not available locally");
    else if (!isCommitAncestor(root, receipt.trustedCommit, expected.head)) failures.push("trustedCommit is not an ancestor of the current head");
    else {
      const unexpected = changedFilesBetween(root, receipt.trustedCommit, expected.head)
        .filter((file) => !taskLifecycleMetadataPaths(taskId).includes(file));
      if (unexpected.length > 0) failures.push(`trustedCommit range contains non-metadata files: ${unexpected.join(", ")}`);
    }
  }
  if (failures.length > 0) throw new Error(`CI receipt rejected:\n- ${failures.join("\n- ")}`);
  return receipt as CiReceipt;
}
