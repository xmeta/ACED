import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readEvidence, readTask } from "../core/contracts.js";
import { buildCheckCacheKey, buildCheckCacheSubject } from "../core/check-cache.js";
import { resolveCheckCommand } from "../core/check-catalog.js";
import { collectCheckReceiptProvenance, readCheckReceipt } from "../core/check-receipt.js";
import { branchChangedFiles, branchDiffHash, changedFilesBetween, commitTreeHash, currentBranch, headCommit, isCommitAncestor, mergeBase, resolveCommit } from "../core/git.js";
import { evidencePath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { CiReceipt, Evidence, EvidenceCheckStatus, TaskContract } from "../core/types.js";
import { summarizeCheckOutput } from "../core/check-output-summary.js";
import { collectSubmoduleProvenance } from "../core/submodule-provenance.js";
import { printIssues } from "../core/report.js";
import { evaluateWorkingTreeGuard } from "./check-diff.js";
import { taskAuthorityFingerprint } from "./ci-plan.js";
import { syncRegistry } from "./registry-rebuild.js";
import {
  acquireRequiredCheckRun,
  formatRequiredCheckProgress,
  releaseRequiredCheckRun,
  requiredCheckChildEnv,
  startRequiredCheckHeartbeat,
  stopRequiredCheckHeartbeat,
  updateRequiredCheckRun,
  type RequiredCheckRunLease
} from "../core/required-check-run.js";

export function detectOpenPullRequest(root: string, branchName?: string): string | undefined {
  if (!branchName) return undefined;
  try {
    const result = spawnSync("gh", ["pr", "list", "--head", branchName, "--state", "open", "--json", "number"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    const parsed = JSON.parse(result.stdout.trim()) as Array<{ number?: number }>;
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0]?.number === "number") {
      return String(parsed[0].number);
    }
  } catch {
    // gh CLI missing, invalid output, or failed
  }
  return undefined;
}

type TestQualityOptions = NonNullable<Evidence["testQuality"]>;

export type EvidenceCollectSummary = {
  schemaVersion: "1.0.0";
  status: "pass";
  taskId: string;
  path: string;
  checks: {
    total: number;
    passed: number;
    failed: number;
  };
  changedFiles: number;
  pullRequest: string | null;
  ciReceipt?: {
    verified: true;
    workflowRunId: string;
    jobCount: number;
  };
};

export type EvidenceCollectOptions = {
  force: boolean;
  baseRef?: string;
  pullRequest?: string;
  testQuality?: TestQualityOptions;
  rerunChecks?: boolean;
  json?: boolean;
  verbose?: boolean;
  output?: string;
  quiet?: boolean;
  ciReceipt?: string;
};

function postEvidenceMetadataFiles(taskId: string): string[] {
  return [
    `contracts/evidence/${taskId}.yaml`,
    `contracts/approvals/${taskId}.yaml`,
    `contracts/reviews/${taskId}.yaml`,
    "contracts/registry.yaml"
  ];
}

const CI_WORKFLOW_PATH = ".github/workflows/scwbs.yml";
const CI_JOB_NAMES = ["core", "integration", "wjs", "validate"];

function normalizedGithubRepository(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return match?.[1];
}

function originRepository(root: string): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("CI receipt rejected: origin repository cannot be verified");
  const repository = normalizedGithubRepository(result.stdout);
  if (!repository) throw new Error("CI receipt rejected: origin is not a GitHub repository");
  return repository;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRunUrl(value: unknown, runId: string): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.includes(`/actions/runs/${runId}`);
  } catch {
    return false;
  }
}

function verifyCiReceipt(
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
        .filter((file) => !postEvidenceMetadataFiles(taskId).includes(file));
      if (unexpected.length > 0) failures.push(`trustedCommit range contains non-metadata files: ${unexpected.join(", ")}`);
    }
  }
  if (failures.length > 0) throw new Error(`CI receipt rejected:\n- ${failures.join("\n- ")}`);
  return receipt as CiReceipt;
}

function stableSubjectHead(
  root: string,
  currentHead: string | undefined,
  diffHash: string,
  existingEvidence: Evidence | undefined,
  metadataFiles: string[]
): string | undefined {
  const previousHead = existingEvidence?.subjectHeadCommit
    ?? existingEvidence?.git?.subjectHeadCommit
    ?? existingEvidence?.git?.headCommit
    ?? existingEvidence?.commit;
  const previousDiffHash = existingEvidence?.diffHash ?? existingEvidence?.git?.diffHash;
  if (
    !currentHead
    || !previousHead
    || previousHead === currentHead
    || previousDiffHash !== diffHash
    || !isCommitAncestor(root, previousHead, currentHead)
  ) {
    return currentHead;
  }
  const allowedMetadata = new Set(metadataFiles);
  return changedFilesBetween(root, previousHead, currentHead).every((file) => allowedMetadata.has(file))
    ? previousHead
    : currentHead;
}

function commandForCheck(check: string): string[] {
  return resolveCheckCommand(check);
}

function runCheck(root: string, check: string, cacheKey: string, lease: RequiredCheckRunLease, checkIndex: number): Evidence["checks"][number] {
  const command = commandForCheck(check);
  updateRequiredCheckRun(lease, check, checkIndex);
  process.stderr.write(`${formatRequiredCheckProgress(lease.state, "executed")}\n`);
  const heartbeat = startRequiredCheckHeartbeat(lease);
  const startedAt = performance.now();
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(command[0] ?? "npm", command.slice(1), {
      cwd: root,
      encoding: "utf8",
      env: requiredCheckChildEnv(lease),
      shell: process.platform === "win32"
    });
  } finally {
    stopRequiredCheckHeartbeat(heartbeat);
  }
  const status: EvidenceCheckStatus = result.status === 0 ? "passed" : "failed";
  process.stderr.write(`${formatRequiredCheckProgress(lease.state, status)}\n`);
  const record: Evidence["checks"][number] = {
    name: check,
    status,
    source: "local",
    command: command.join(" "),
    cacheKey,
    durationMilliseconds: Math.max(0, Math.round(performance.now() - startedAt)),
    executedAt: new Date().toISOString()
  };
  if (status === "passed") return record;
  const stdoutSummary = summarizeCheckOutput(result.stdout);
  const stderrSummary = summarizeCheckOutput(result.stderr);
  return {
    ...record,
    ...(typeof result.status === "number" ? { exitStatus: result.status } : {}),
    ...(stdoutSummary ? { stdoutSummary } : {}),
    ...(stderrSummary ? { stderrSummary } : {})
  };
}

export function buildCollectedEvidence(root: string, taskId: string, options: { baseRef?: string; pullRequest?: string; testQuality?: TestQualityOptions; rerunChecks?: boolean; ciReceipt?: CiReceipt } = {}): Evidence {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const baseRef = options.baseRef ?? "origin/main";
  const head = headCommit(root);
  const baseCommit = mergeBase(root, baseRef) ?? resolveCommit(root, baseRef);
  const metadataFiles = postEvidenceMetadataFiles(taskId);
  const diffHash = branchDiffHash(root, baseRef, metadataFiles);
  const { evidence: existingEvidence } = readEvidence(root, taskId);
  const changedFiles = branchChangedFiles(root, baseRef);
  const subjectHead = stableSubjectHead(root, head, diffHash, existingEvidence, metadataFiles);
  const subjectTreeHash = subjectHead ? commitTreeHash(root, subjectHead) : undefined;
  if (subjectHead && !subjectTreeHash) {
    throw new Error(`Unable to resolve tree hash for Evidence subject ${subjectHead}`);
  }
  const branch = currentBranch(root);
  if (
    existingEvidence?.git?.changedFilesBasis === "branch-diff"
    && existingEvidence.changedFiles.length > 0
    && changedFiles.length === 0
    && branch !== task.branchName
  ) {
    throw new Error(
      `Refusing to replace ${taskId} implementation provenance with an empty diff on ${branch ?? "detached HEAD"}. `
      + `Use npm run scwbs -- evidence annotate --task ${taskId} for metadata-only updates.`
    );
  }
  const pullRequest = options.pullRequest
    ?? existingEvidence?.git?.pullRequest
    ?? detectOpenPullRequest(root, branch ?? task.branchName);
  const testQuality = options.testQuality ?? existingEvidence?.testQuality;
  const ciReceipt = options.ciReceipt
    ? verifyCiReceipt(root, task, taskId, options.ciReceipt, {
      pullRequest,
      head: head ?? "",
      baseRef,
      baseCommit: baseCommit ?? "",
      diffHash
    })
    : undefined;
  const cacheSubject = task.requiredChecks.length > 0
    ? buildCheckCacheSubject(root, { baseRef, excludedMetadataFiles: postEvidenceMetadataFiles(taskId) })
    : undefined;
  const receipt = head && cacheSubject
    ? readCheckReceipt(root, {
      taskId,
      headCommit: head,
      subjectFingerprint: cacheSubject.fingerprint,
      provenance: collectCheckReceiptProvenance(root)
    }).receipt
    : undefined;
  const lease = !ciReceipt && task.requiredChecks.length > 0 ? acquireRequiredCheckRun(root, taskId, task.requiredChecks.length) : undefined;
  let checks: Evidence["checks"];
  try {
    checks = ciReceipt
      ? task.requiredChecks.map((check) => {
        const job = ciReceipt.jobs.find((candidate) => candidate.checkNames.includes(check));
        if (!job) throw new Error(`CI receipt rejected: no job mapping for ${check}`);
        return {
          name: check,
          status: "passed",
          source: "ci",
          runId: ciReceipt.workflowRunId,
          url: job.url,
          executedAt: ciReceipt.retrievedAt,
          verifiedBy: ciReceipt.verifiedBy
        };
      })
      : task.requiredChecks.map((check, index) => {
      const command = commandForCheck(check);
      const cacheKey = buildCheckCacheKey(cacheSubject ?? { fingerprint: "", reusable: false }, check, command);
      const existing = existingEvidence?.checks.find((candidate) =>
        candidate.name === check
        && candidate.status === "passed"
        && candidate.command === command.join(" ")
        && candidate.cacheKey === cacheKey
      );
      const received = receipt?.checks.find((candidate) =>
        candidate.name === check
        && candidate.status === "passed"
        && candidate.command === command.join(" ")
        && candidate.cacheKey === cacheKey
      );
      const reusable = received?.durationMilliseconds !== undefined ? received : existing ?? received;
      if (!options.rerunChecks && cacheSubject?.reusable && reusable) {
        if (lease) {
          updateRequiredCheckRun(lease, check, index + 1);
          process.stderr.write(`${formatRequiredCheckProgress(lease.state, "cache-hit")}\n`);
        }
        return reusable;
      }
      if (!lease) throw new Error(`Required-check lease missing for ${check}`);
      return runCheck(root, check, cacheKey, lease, index + 1);
      });
  } finally {
    if (lease) releaseRequiredCheckRun(lease);
  }
  const submodules = collectSubmoduleProvenance(root, baseRef, task);
  return {
    id: `EVD-${taskId}`,
    type: "evidence",
    taskId,
    ...(subjectHead ? { commit: subjectHead } : {}),
    ...(subjectHead ? { subjectHeadCommit: subjectHead } : {}),
    diffHash,
    ...(subjectHead && subjectTreeHash ? {
      provenance: {
        schemaVersion: "1.0.0" as const,
        subject: {
          commit: subjectHead,
          treeHash: subjectTreeHash,
          diffHash,
          canonicalization: "git-diff-binary-v1" as const
        },
        retention: {
          mode: "git-object" as const,
          locator: `git:${subjectHead}`
        }
      }
    } : {}),
    git: {
      ...(branch ? { branch } : {}),
      base: baseRef,
      ...(baseCommit ? { baseCommit } : {}),
      changedFilesBasis: "branch-diff",
      ...(pullRequest ? { pullRequest } : {}),
      ...(subjectHead ? { subjectHeadCommit: subjectHead } : {}),
      diffHash,
      ...(subjectHead ? { headCommit: subjectHead } : {})
    },
    changedFiles,
    ...(submodules.length > 0 ? { submodules } : {}),
    ...(ciReceipt ? { ciReceipt } : {}),
    checks,
    ...(testQuality ? { testQuality } : {})
  };
}

export function buildCollectedEvidenceYaml(root: string, taskId: string, options: { baseRef?: string; pullRequest?: string; testQuality?: TestQualityOptions; rerunChecks?: boolean; ciReceipt?: CiReceipt } = {}): string {
  return stringifySimpleYaml(buildCollectedEvidence(root, taskId, options) as unknown as Record<string, unknown>);
}

export function buildEvidenceCollectSummary(taskId: string, relativePath: string, evidence: Evidence): EvidenceCollectSummary {
  const passed = evidence.checks.filter((check) => check.status === "passed").length;
  const failed = evidence.checks.length - passed;
  return {
    schemaVersion: "1.0.0",
    status: "pass",
    taskId,
    path: relativePath,
    checks: {
      total: evidence.checks.length,
      passed,
      failed
    },
    changedFiles: evidence.changedFiles.length,
    pullRequest: evidence.git?.pullRequest ?? null,
    ...(evidence.ciReceipt ? {
      ciReceipt: { verified: true as const, workflowRunId: evidence.ciReceipt.workflowRunId, jobCount: evidence.ciReceipt.jobs.length }
    } : {})
  };
}

export function formatEvidenceCollectSummary(summary: EvidenceCollectSummary): string {
  return [
    "PASS evidence collected",
    `path: ${summary.path}`,
    `checks: ${summary.checks.passed} passed, ${summary.checks.failed} failed`,
    `changedFiles: ${summary.changedFiles}`,
    `pullRequest: ${summary.pullRequest ?? "(not recorded)"}`,
    ...(summary.ciReceipt ? [`ciReceipt: verified ${summary.ciReceipt.workflowRunId} (${summary.ciReceipt.jobCount} jobs)`] : [])
  ].join("\n") + "\n";
}

export function runEvidenceCollect(root: string, taskId: string, options: EvidenceCollectOptions): number {
  try {
    const outputModes = [options.json, options.verbose, options.output !== undefined].filter(Boolean).length;
    if (outputModes > 1) {
      console.error("Choose one of --json, --verbose, or --output -");
      return 2;
    }
    if (options.output !== undefined && options.output !== "-") {
      console.error("--output target must be -");
      return 2;
    }
    const workingTree = evaluateWorkingTreeGuard(root, taskId);
    if (workingTree.issues.length > 0) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          schemaVersion: "1.0.0",
          status: "blocked",
          taskId,
          workingTree: workingTree.state,
          issues: workingTree.issues
        }, null, 2)}\n`);
      } else {
        printIssues(workingTree.issues);
      }
      return 1;
    }
    const relativePath = evidencePath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const ciReceipt = options.ciReceipt
      ? JSON.parse(readFileSync(path.isAbsolute(options.ciReceipt) ? options.ciReceipt : resolveFrom(root, options.ciReceipt), "utf8")) as CiReceipt
      : undefined;
    const evidence = buildCollectedEvidence(root, taskId, {
      baseRef: options.baseRef,
      pullRequest: options.pullRequest,
      testQuality: options.testQuality,
      rerunChecks: options.rerunChecks,
      ciReceipt
    });
    const yaml = stringifySimpleYaml(evidence as unknown as Record<string, unknown>);
    writeFileSync(fullPath, yaml, "utf8");
    syncRegistry(root);
    const summary = buildEvidenceCollectSummary(taskId, relativePath, evidence);
    if (!options.quiet) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else if (options.output === "-") {
        process.stdout.write(yaml);
      } else {
        process.stdout.write(formatEvidenceCollectSummary(summary));
        if (options.verbose) process.stdout.write(yaml);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
