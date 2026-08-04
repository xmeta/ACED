import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { collectCheckCoverageIssues, collectCheckCoveragePolicyIssues } from "../core/check-coverage.js";
import { listTasks, readApproval, readEvidence, readRegistry, readReview, readTask } from "../core/contracts.js";
import {
  branchChangedFiles,
  branchDiffHash,
  headCommit,
  isCommitAncestor,
  isShallowRepository,
  mergeBase,
  resolveCommit
} from "../core/git.js";
import { taskLifecycleMetadataPaths } from "../core/managed-contract-paths.js";
import { approvalPath, resolveFrom, reviewPath } from "../core/paths.js";
import { collectTaskAuthorityIssues, taskAuthorityFingerprint, verifyTaskBootstrapAuthority } from "../core/task-authority.js";
import { matchesAny } from "../core/glob.js";
import { readWbs } from "../core/wbs.js";
import type { Issue, TaskContract } from "../core/types.js";
import { collectDiffIssues } from "./check-diff.js";

export type CiPlanReason = {
  code: string;
  message: string;
};

export type CiPlanCommit = {
  sha: string;
  changedFiles: string[];
};

export type CiPlan = {
  schemaVersion: "1.0.0";
  decision: "full" | "metadata-candidate";
  taskId: string | null;
  baseRef: string;
  baseCommit: string | null;
  headCommit: string | null;
  subjectHeadCommit: string | null;
  diffHash: string | null;
  authorityFingerprint: string | null;
  metadataFiles: string[];
  metadataAncestry: CiPlanCommit[];
  changedFilesSinceSubject: string[];
  reasons: CiPlanReason[];
  classification: TaskClassificationReport;
};

export { taskAuthorityFingerprint };

export type TaskClassificationReport = {
  schemaVersion: "1.0.0";
  status: "classified" | "unavailable";
  projectProfile: "Lean" | "Standard" | "Strict" | null;
  executionClass: "routine" | "standard" | "high-risk" | null;
  enforcement: "read-only";
  bootstrapAuthority: { verified: boolean; introductionCommit: string | null };
  consideredFiles: string[];
  excludedBootstrapFiles: string[];
  reasons: CiPlanReason[];
};

export type CiPlanOptions = {
  taskId?: string;
  branch?: string;
  baseRef?: string;
  json?: boolean;
};

function reason(code: string, message: string): CiPlanReason {
  return { code, message };
}

function issueReasons(issues: Issue[], prefix: string): CiPlanReason[] {
  return issues.map((issue) => reason(`${prefix}.${issue.code}`, issue.message));
}

function uniqueReasons(reasons: CiPlanReason[]): CiPlanReason[] {
  const seen = new Set<string>();
  return reasons.filter((item) => {
    const key = `${item.code}\0${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveTask(root: string, options: CiPlanOptions): { task?: TaskContract; reasons: CiPlanReason[] } {
  if (options.taskId) {
    const result = readTask(root, options.taskId);
    return result.task
      ? { task: result.task, reasons: [] }
      : { reasons: issueReasons(result.issues, "task") };
  }
  if (!options.branch) {
    return { reasons: [reason("task.branch.missing", "No task id or branch was supplied for CI task discovery")] };
  }
  const matches = listTasks(root).filter((entry) => entry.task?.branchName === options.branch);
  if (matches.length !== 1 || !matches[0]?.task) {
    return {
      reasons: [reason(
        matches.length === 0 ? "task.branch.notFound" : "task.branch.ambiguous",
        matches.length === 0
          ? `No Task Contract declares branchName ${options.branch}`
          : `Multiple Task Contracts declare branchName ${options.branch}`
      )]
    };
  }
  return { task: matches[0].task, reasons: [] };
}

function optionalRecordIssues(root: string, taskId: string): Issue[] {
  const issues: Issue[] = [];
  if (existsSync(resolveFrom(root, approvalPath(taskId)))) issues.push(...readApproval(root, taskId).issues);
  if (existsSync(resolveFrom(root, reviewPath(taskId)))) issues.push(...readReview(root, taskId).issues);
  return issues;
}

function emptyPlan(root: string, baseRef: string, taskId: string | null, reasons: CiPlanReason[]): CiPlan {
  return {
    schemaVersion: "1.0.0",
    decision: "full",
    taskId,
    baseRef,
    baseCommit: resolveCommit(root, baseRef) ?? null,
    headCommit: null,
    subjectHeadCommit: null,
    diffHash: null,
    authorityFingerprint: null,
    metadataFiles: taskId ? taskLifecycleMetadataPaths(taskId) : [],
    metadataAncestry: [],
    changedFilesSinceSubject: [],
    reasons,
    classification: {
      schemaVersion: "1.0.0", status: "unavailable", projectProfile: null, executionClass: null, enforcement: "read-only",
      bootstrapAuthority: { verified: false, introductionCommit: null }, consideredFiles: [], excludedBootstrapFiles: [], reasons
    }
  };
}

function collectMetadataAncestry(root: string, subjectHead: string, currentHead: string): {
  ancestry: CiPlanCommit[];
  changedFiles: string[];
} {
  const result = spawnSync("git", ["log", "--format=%H", "--name-only", "--no-renames", `${subjectHead}..${currentHead}`], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr || "git log failed");
  const ancestry: CiPlanCommit[] = [];
  let current: CiPlanCommit | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    if (/^[0-9a-f]{40}$/.test(value)) {
      if (current) ancestry.push(current);
      current = { sha: value, changedFiles: [] };
    } else if (current) {
      current.changedFiles.push(value);
    }
  }
  if (current) ancestry.push(current);
  return {
    ancestry,
    changedFiles: Array.from(new Set(ancestry.flatMap((commit) => commit.changedFiles))).sort()
  };
}

function profile(root: string): "Lean" | "Standard" | "Strict" {
  const value = readWbs(root).extensions?.scwbs;
  const candidate = typeof value === "object" && value !== null ? (value as Record<string, unknown>).profile : undefined;
  return candidate === "Lean" || candidate === "Strict" || candidate === "Standard" ? candidate : "Standard";
}

function classifyTask(root: string, task: TaskContract, baseRef: string, branchFiles: string[], issues: CiPlanReason[]): TaskClassificationReport {
  const ownTaskPath = `contracts/tasks/${task.id}.yaml`;
  const bootstrap = branchFiles.includes(ownTaskPath)
    ? verifyTaskBootstrapAuthority(root, baseRef, task)
    : { verified: true, reasons: [], introductionCommit: undefined, bootstrapFiles: [] };
  const bootstrapFiles = bootstrap.verified ? bootstrap.bootstrapFiles : [];
  const consideredFiles = branchFiles.filter((file) => !bootstrapFiles.includes(file)).sort();
  const reasons: CiPlanReason[] = bootstrap.reasons.map((item) => reason(item.code, item.message));
  if (issues.some((item) => ["git.shallow", "git.base.missing", "git.mergeBase.missing", "git.diff.failed"].includes(item.code))) {
    reasons.push(reason("classification.provenance.unverified", "Repository history or the classified branch diff cannot be verified"));
  }
  if (issues.some((item) => item.code.includes("taskAuthority") || item.code.includes("checkCoverage.unclassified"))) {
    reasons.push(reason("classification.authorityOrCoverage.unverified", "Authority or implementation coverage cannot be verified"));
  }
  if (consideredFiles.some((file) => matchesAny(file, task.humanGateRequiredPaths))) {
    reasons.push(reason("classification.path.humanGate", "A Human Gate path is in the classified change set"));
  }
  if (consideredFiles.some((file) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|.*schema.*|.*migration.*|.*auth.*|.*permission.*|.*release.*)$/.test(file) || file.startsWith(".github/") || file.startsWith("wjs/"))) {
    reasons.push(reason("classification.path.highRisk", "A dependency, schema, migration, authority, release, workflow, or submodule path is in the classified change set"));
  }
  const executionClass = reasons.length > 0 ? "high-risk"
    : consideredFiles.some((file) => file.startsWith("src/") || file.startsWith("tests/")) ? "standard"
      : "routine";
  if (reasons.length === 0) reasons.push(reason(`classification.${executionClass}`, executionClass === "routine" ? "Only non-implementation, non-gated files remain after verified bootstrap metadata exclusion" : "Implementation or test files require the Standard execution class"));
  return {
    schemaVersion: "1.0.0", status: "classified", projectProfile: profile(root), executionClass, enforcement: "read-only",
    bootstrapAuthority: { verified: bootstrap.verified, introductionCommit: bootstrap.introductionCommit ?? null },
    consideredFiles, excludedBootstrapFiles: bootstrapFiles.filter((file) => branchFiles.includes(file)).sort(), reasons: uniqueReasons(reasons)
  };
}

export function buildCiPlan(root: string, options: CiPlanOptions = {}): CiPlan {
  const baseRef = options.baseRef ?? "origin/main";
  const taskResult = resolveTask(root, options);
  const task = taskResult.task;
  const currentHead = headCommit(root) ?? null;
  const baseCommit = resolveCommit(root, baseRef) ?? null;
  if (!task) {
    return {
      ...emptyPlan(root, baseRef, options.taskId ?? null, taskResult.reasons),
      baseCommit,
      headCommit: currentHead
    };
  }

  const metadataFiles = taskLifecycleMetadataPaths(task.id);
  const reasons: CiPlanReason[] = [...taskResult.reasons];
  let branchFiles: string[] = [];
  if (isShallowRepository(root)) reasons.push(reason("git.shallow", "Repository history is shallow; provenance cannot be verified"));
  if (!baseCommit) reasons.push(reason("git.base.missing", `${baseRef} does not resolve to a commit`));
  if (baseCommit && !mergeBase(root, baseRef, "HEAD")) {
    reasons.push(reason("git.mergeBase.missing", `${baseRef} and HEAD have no resolvable merge base`));
  }
  try {
    branchFiles = branchChangedFiles(root, baseRef);
  } catch (error) {
    reasons.push(reason("git.diff.failed", error instanceof Error ? error.message : String(error)));
  }

  const registry = readRegistry(root);
  reasons.push(...issueReasons(registry.issues, "schema"));
  reasons.push(...issueReasons(optionalRecordIssues(root, task.id), "schema"));
  reasons.push(...issueReasons(collectCheckCoveragePolicyIssues(root), "coverage"));
  if (branchFiles.length > 0) {
    reasons.push(...issueReasons(collectTaskAuthorityIssues(root, task, baseRef, branchFiles), "authority"));
    const diffIssues = collectDiffIssues(root, task, branchFiles)
      .filter((issue) => issue.code !== "diff.humanGate");
    reasons.push(...issueReasons(diffIssues, "scope"));
    reasons.push(...issueReasons(collectCheckCoverageIssues(root, task, branchFiles), "coverage"));
  }

  const evidenceResult = readEvidence(root, task.id);
  const evidence = evidenceResult.evidence;
  if (!evidence) reasons.push(...issueReasons(evidenceResult.issues, "schema"));
  const subjectHead = evidence?.subjectHeadCommit
    ?? evidence?.git?.subjectHeadCommit
    ?? evidence?.git?.headCommit
    ?? evidence?.commit
    ?? null;
  const recordedDiffHash = evidence?.diffHash ?? evidence?.git?.diffHash ?? null;
  let metadataAncestry: CiPlanCommit[] = [];
  let changedFilesSinceSubject: string[] = [];

  if (evidence && evidence.taskId !== task.id) {
    reasons.push(reason("provenance.taskId", `Evidence taskId ${evidence.taskId} does not match ${task.id}`));
  }
  if (!subjectHead) reasons.push(reason("provenance.subject.missing", "Evidence has no implementation subjectHeadCommit"));
  if (!recordedDiffHash) reasons.push(reason("provenance.diffHash.missing", "Evidence has no implementation diffHash"));
  if (subjectHead && !resolveCommit(root, subjectHead)) {
    reasons.push(reason("provenance.subject.unknown", `Evidence subject ${subjectHead} is not available in repository history`));
  }
  if (subjectHead && currentHead && resolveCommit(root, subjectHead)) {
    if (!isCommitAncestor(root, subjectHead, currentHead)) {
      reasons.push(reason("provenance.subject.notAncestor", `Evidence subject ${subjectHead} is not an ancestor of HEAD ${currentHead}`));
    } else if (subjectHead === currentHead) {
      reasons.push(reason("provenance.noMetadataDescendant", "HEAD is the implementation subject, so full CI is required"));
    } else {
      try {
        const collected = collectMetadataAncestry(root, subjectHead, currentHead);
        changedFilesSinceSubject = collected.changedFiles;
        metadataAncestry = collected.ancestry;
      } catch (error) {
        reasons.push(reason("provenance.ancestry.failed", error instanceof Error ? error.message : String(error)));
      }
      const unexpected = changedFilesSinceSubject.filter((file) => !metadataFiles.includes(file));
      if (unexpected.length > 0) {
        reasons.push(reason(
          "provenance.nonMetadataDescendant",
          `Files changed after the implementation subject are not approved metadata: ${unexpected.join(", ")}`
        ));
      }
    }
  }
  if (recordedDiffHash && baseCommit) {
    try {
      const currentDiffHash = branchDiffHash(root, baseRef, metadataFiles);
      if (currentDiffHash !== recordedDiffHash) {
        reasons.push(reason(
          "provenance.diffHash.mismatch",
          `Evidence diffHash ${recordedDiffHash} does not match current implementation diffHash ${currentDiffHash}`
        ));
      }
    } catch (error) {
      reasons.push(reason("provenance.diffHash.failed", error instanceof Error ? error.message : String(error)));
    }
  }

  const normalizedReasons = uniqueReasons(reasons);
  const decision = normalizedReasons.length === 0 ? "metadata-candidate" : "full";
  const classification = classifyTask(root, task, baseRef, branchFiles, normalizedReasons);
  return {
    schemaVersion: "1.0.0",
    decision,
    taskId: task.id,
    baseRef,
    baseCommit,
    headCommit: currentHead,
    subjectHeadCommit: subjectHead,
    diffHash: recordedDiffHash,
    authorityFingerprint: taskAuthorityFingerprint(task),
    metadataFiles,
    metadataAncestry,
    changedFilesSinceSubject,
    reasons: decision === "metadata-candidate"
      ? [reason("provenance.metadataOnly", "Only approved metadata files changed after the verified implementation subject")]
      : normalizedReasons,
    classification
  };
}

function formatPlan(plan: CiPlan): string {
  const lines = [
    `CI plan: ${plan.decision}`,
    `task: ${plan.taskId ?? "(not resolved)"}`,
    `subject: ${plan.subjectHeadCommit ?? "(not recorded)"}`,
    "reasons:"
  ];
  for (const item of plan.reasons) lines.push(`- ${item.code}: ${item.message}`);
  return `${lines.join("\n")}\n`;
}

export function runCiPlan(root: string, options: CiPlanOptions = {}): number {
  try {
    const plan = buildCiPlan(root, options);
    process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan));
    return 0;
  } catch (error) {
    const plan = emptyPlan(root, options.baseRef ?? "origin/main", options.taskId ?? null, [
      reason("planner.error", error instanceof Error ? error.message : String(error))
    ]);
    process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan));
    return 0;
  }
}
