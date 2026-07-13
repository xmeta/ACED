import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { branchChangedFiles, currentBranch } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { collectCheckCoverageIssues } from "../core/check-coverage.js";
import { hasErrors, printIssues, withDefaultFixCommand } from "../core/report.js";
import type { Issue, TaskContract } from "../core/types.js";
import { runWjsValidate } from "../core/wbs.js";
import { collectWbsChangesetGateIssues } from "./check.js";

const SENSITIVE_META_PATHS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  ".gitignore",
  ".github/**"
];

function requiresMetaFileGuard(file: string): boolean {
  return matchesAny(file, SENSITIVE_META_PATHS);
}

/**
 * M2-019: managedContractPaths are CLI-generated contract files (Evidence,
 * Approval, Review, registry.yaml, the task's own contract file, etc). They
 * are exempt from allowedPaths and the sensitive meta-file guard, but never
 * from forbiddenPaths or humanGateRequiredPaths, which always take priority.
 */
function isManagedContractPath(task: TaskContract, file: string): boolean {
  return matchesAny(file, task.managedContractPaths ?? []);
}

export function collectDiffIssues(root: string, task: TaskContract, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const evidence = readEvidence(root, task.id).evidence;
  const nestedFiles = (evidence?.submodules ?? []).flatMap((submodule) => submodule.changedFiles.map((file) => `${submodule.path}/${file}`));
  const effectiveFiles = Array.from(new Set([...files, ...nestedFiles]));
  const gate = validateHumanGateApproval(task, evidence, readApproval(root, task.id).approval, effectiveFiles, root);
  for (const dependency of task.submoduleDependencies ?? []) {
    if (files.includes(dependency.path) && !evidence?.submodules?.some((submodule) => submodule.path === dependency.path)) {
      issues.push({ severity: "error", code: "diff.submodule.evidence.missing", message: `${dependency.path} gitlink changed but nested Evidence is missing` });
    }
  }
  for (const submodule of evidence?.submodules ?? []) {
    if (!submodule.upstreamReachable) {
      issues.push({ severity: "error", code: "diff.submodule.upstreamReachable", message: `${submodule.path} head ${submodule.headCommit} is not reachable from upstream target ${submodule.upstreamRef}` });
    }
    for (const check of submodule.checks ?? []) {
      if (check.status !== "passed") issues.push({ severity: "error", code: "diff.submodule.check", message: `${submodule.path} check ${check.name} is ${check.status}` });
    }
  }
  for (const issue of collectWbsChangesetGateIssues(effectiveFiles)) {
    issues.push({ ...issue, code: `diff.${issue.code}`, message: `${issue.message} (for ${task.id})` });
  }
  const wbsChangeSets = files.filter((file) => /^contracts\/changesets\/.+\.json$/.test(file.replace(/\\/g, "/")));
  for (const changeSet of wbsChangeSets) {
    issues.push(...runWjsValidate(root, changeSet, "operations").map((issue) => ({
      ...issue,
      code: `diff.wbsOperations.${issue.code}`,
      message: `${changeSet}: ${issue.message}`
    })));
  }
  for (const file of effectiveFiles) {
    const managed = isManagedContractPath(task, file);
    if (task.allowedPaths.length > 0 && !matchesAny(file, task.allowedPaths) && !managed) {
      issues.push({
        severity: "error",
        code: "diff.allowedPaths",
        message: `${file} is outside allowedPaths for ${task.id}`,
        fixCommand: `Move this change out of the diff, or add ${file} to allowedPaths/managedContractPaths in contracts/tasks/${task.id}.yaml if it is CLI-generated`
      });
    }
    if (matchesAny(file, task.forbiddenPaths)) {
      issues.push({
        severity: "error",
        code: "diff.forbiddenPaths",
        message: `${file} is forbidden by ${task.id}`,
        fixCommand: `Revert changes to ${file}; forbiddenPaths always takes priority over allowedPaths/managedContractPaths`
      });
    }
    const explicitlyAllowed = matchesAny(file, task.allowedPaths);
    const humanGateRequired = matchesAny(file, task.humanGateRequiredPaths);
    if (requiresMetaFileGuard(file) && !explicitlyAllowed && !humanGateRequired && !managed) {
      issues.push({
        severity: "error",
        code: "diff.metaFile",
        message: `${file} is a sensitive meta/config file and must be explicitly allowed for ${task.id}`,
        fixCommand: `Add ${file} to allowedPaths/humanGateRequiredPaths/managedContractPaths in contracts/tasks/${task.id}.yaml if this change is intentional`
      });
    }
  }
  issues.push(...gate.issues.map((issue) => ({
    ...issue,
    code: "diff.humanGate",
    message: `${issue.message} (${issue.code})`
  })));
  issues.push(...collectCheckCoverageIssues(root, task, effectiveFiles).map((issue) => ({
    ...issue,
    code: `diff.${issue.code}`
  })));
  return issues;
}

export function collectBranchIssues(task: TaskContract, branch: string | undefined): Issue[] {
  if (!task.branchName || !branch) return [];
  if (task.branchName === branch) return [];
  return [{
    severity: "error",
    code: "diff.branchName",
    message: `current branch ${branch} does not match ${task.id} branchName ${task.branchName}`,
    fixCommand: `git checkout -b ${task.branchName}`
  }];
}

export function collectEvidenceGateIssues(root: string, task: TaskContract): Issue[] {
  const { evidence, issues } = readEvidence(root, task.id);
  if (!evidence) {
    return issues.map((issue) => ({
      ...issue,
      code: `diff.${issue.code}`,
      message: issue.message,
      fixCommand: `npm run scwbs -- evidence collect --task ${task.id} before opening a PR`
    }));
  }
  return issues.map((issue) => ({
    ...issue,
    code: `diff.${issue.code}`
  }));
}

export function runCheckDiff(root: string, taskId: string, options: { baseRef?: string; json?: boolean } = {}): number {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    const taskIssues = withDefaultFixCommand(issues, `Create the task contract: npm run scwbs -- task new "<title>" (or fix contracts/tasks/${taskId}.yaml)`);
    if (options.json) console.log(JSON.stringify({ status: "fail", taskId, issues: taskIssues }, null, 2));
    else printIssues(taskIssues);
    return 1;
  }
  const baseRef = options.baseRef ?? "origin/main";
  let files: string[] = [];
  try {
    files = branchChangedFiles(root, baseRef);
  } catch (error) {
    const baseIssues = [{
      severity: "error",
      code: "diff.git.base",
      message: error instanceof Error ? error.message : String(error),
      fixCommand: `npm run scwbs -- check-diff --task ${taskId} --base <a-valid-ref>`
    }] as Issue[];
    if (options.json) console.log(JSON.stringify({ status: "fail", taskId, issues: baseIssues }, null, 2));
    else printIssues(baseIssues);
    return 1;
  }
  const diffIssues = withDefaultFixCommand([
    ...collectBranchIssues(task, currentBranch(root)),
    ...collectEvidenceGateIssues(root, task),
    ...collectDiffIssues(root, task, files)
  ], `npm run scwbs -- check-diff --task ${taskId} --base ${baseRef}`);
  if (diffIssues.length === 0) {
    if (options.json) console.log(JSON.stringify({ status: "pass", taskId, issues: [] }, null, 2));
    else console.log(`PASS check-diff ${taskId}`);
    return 0;
  }
  if (options.json) console.log(JSON.stringify({ status: hasErrors(diffIssues) ? "fail" : "warn", taskId, issues: diffIssues }, null, 2));
  else printIssues(diffIssues);
  return hasErrors(diffIssues) ? 1 : 0;
}
