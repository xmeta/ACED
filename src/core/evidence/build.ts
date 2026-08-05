import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { listEvidence, readEvidence, readTask } from "../contracts.js";
import { buildCheckCacheKey, buildCheckCacheSubject } from "../check-cache.js";
import { resolveCheckCommand } from "../check-catalog.js";
import { collectCheckReceiptProvenance, readCheckReceipt } from "../check-receipt.js";
import {
  branchChangedFiles,
  branchDiffHash,
  buildPatchArtifact,
  changedFilesBetween,
  currentBranch,
  headCommit,
  isCommitAncestor,
  mergeBase,
  resolveCommit
} from "../git.js";
import { stringifySimpleYaml } from "../yaml.js";
import type { CiReceipt, CoverageReceipt, Evidence, EvidenceCheckStatus } from "../types.js";
import { summarizeCheckOutput } from "../check-output-summary.js";
import { collectSubmoduleProvenance } from "../submodule-provenance.js";
import { taskLifecycleMetadataPaths } from "../managed-contract-paths.js";
import { resolveSpawnCommand } from "../../commands/checks-run.js";
import {
  acquireRequiredCheckRun,
  formatRequiredCheckProgress,
  releaseRequiredCheckRun,
  requiredCheckChildEnv,
  startRequiredCheckHeartbeat,
  stopRequiredCheckHeartbeat,
  updateRequiredCheckRun,
  type RequiredCheckRunLease
} from "../required-check-run.js";
import { verifyCiReceipt } from "./ci-receipt.js";
import { verifyCoverageReceipt } from "./coverage-receipt.js";

export type TestQualityOptions = NonNullable<Evidence["testQuality"]>;

export type EvidenceBuildOptions = {
  baseRef?: string;
  pullRequest?: string;
  testQuality?: TestQualityOptions;
  rerunChecks?: boolean;
  ciReceipt?: CiReceipt;
  coverageReceipt?: CoverageReceipt;
};

function postEvidenceMetadataFiles(taskId: string): string[] {
  return taskLifecycleMetadataPaths(taskId);
}

export function detectOpenPullRequest(root: string, branchName?: string): string | undefined {
  if (!branchName) return undefined;
  try {
    const command = resolveSpawnCommand(["gh", "pr", "list", "--head", branchName, "--state", "open", "--json", "number"]);
    const result = spawnSync(command[0] ?? "gh", command.slice(1), {
      cwd: root,
      encoding: "utf8",
      shell: false
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
  const spawnCommand = resolveSpawnCommand(command);
  updateRequiredCheckRun(lease, check, checkIndex);
  process.stderr.write(`${formatRequiredCheckProgress(lease.state, "executed")}\n`);
  const heartbeat = startRequiredCheckHeartbeat(lease);
  const startedAt = performance.now();
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(spawnCommand[0] ?? "npm", spawnCommand.slice(1), {
      cwd: root,
      encoding: "utf8",
      env: requiredCheckChildEnv(lease),
      shell: false
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

export function buildCollectedEvidence(root: string, taskId: string, options: EvidenceBuildOptions = {}): Evidence {
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
  const branch = currentBranch(root);
  if (
    existingEvidence?.git?.changedFilesBasis === "branch-diff"
    && existingEvidence.changedFiles.length > 0
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
  const coverageReceipt = options.coverageReceipt
    ? verifyCoverageReceipt(root, task, taskId, options.coverageReceipt, {
      pullRequest,
      subjectHead: subjectHead ?? ""
    })
    : existingEvidence?.coverageReceipt
      && existingEvidence.coverageReceipt.subjectHeadCommit === subjectHead
      && (!pullRequest
        || !existingEvidence.coverageReceipt.pullRequest
        || existingEvidence.coverageReceipt.pullRequest.replace(/^#/, "") === pullRequest.replace(/^#/, ""))
      ? existingEvidence.coverageReceipt
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
  const patchArtifact = subjectHead && baseCommit
    ? buildPatchArtifact(root, taskId, baseCommit, subjectHead)
    : undefined;
  return {
    id: `EVD-${taskId}`,
    type: "evidence",
    taskId,
    ...(subjectHead ? { commit: subjectHead } : {}),
    ...(subjectHead ? { subjectHeadCommit: subjectHead } : {}),
    diffHash,
    ...(subjectHead && patchArtifact ? {
      provenance: {
        schemaVersion: "1.0.0" as const,
        subject: {
          commit: subjectHead,
          treeHash: patchArtifact.treeHash,
          diffHash,
          canonicalization: "git-diff-binary-v1" as const
        },
        retention: patchArtifact ? {
          mode: "patch-artifact" as const,
          locator: patchArtifact.locator,
          manifestHash: patchArtifact.manifestHash
        } : {
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
    ...(coverageReceipt ? { coverageReceipt } : {}),
    checks,
    ...(testQuality ? { testQuality } : {})
  };
}

export function buildCollectedEvidenceYaml(root: string, taskId: string, options: EvidenceBuildOptions = {}): string {
  return stringifySimpleYaml(buildCollectedEvidence(root, taskId, options) as unknown as Record<string, unknown>);
}
