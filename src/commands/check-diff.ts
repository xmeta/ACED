import { approvalExists, readEvidence, readTask } from "../core/contracts.js";
import { changedFiles, currentBranch } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { hasErrors, printIssues } from "../core/report.js";
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

export function collectDiffIssues(root: string, task: TaskContract, files: string[]): Issue[] {
  const issues: Issue[] = [];
  for (const issue of collectWbsChangesetGateIssues(files)) {
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
  for (const file of files) {
    if (task.allowedPaths.length > 0 && !matchesAny(file, task.allowedPaths)) {
      issues.push({ severity: "error", code: "diff.allowedPaths", message: `${file} is outside allowedPaths for ${task.id}` });
    }
    if (matchesAny(file, task.forbiddenPaths)) {
      issues.push({ severity: "error", code: "diff.forbiddenPaths", message: `${file} is forbidden by ${task.id}` });
    }
    const explicitlyAllowed = matchesAny(file, task.allowedPaths);
    const humanGateRequired = matchesAny(file, task.humanGateRequiredPaths);
    if (requiresMetaFileGuard(file) && !explicitlyAllowed && !humanGateRequired) {
      issues.push({ severity: "error", code: "diff.metaFile", message: `${file} is a sensitive meta/config file and must be explicitly allowed for ${task.id}` });
    }
    if (humanGateRequired && !approvalExists(root, task.id)) {
      issues.push({ severity: "warn", code: "diff.humanGate", message: `${file} requires human gate approval for ${task.id}` });
    }
  }
  return issues;
}

export function collectBranchIssues(task: TaskContract, branch: string | undefined): Issue[] {
  if (!task.branchName || !branch) return [];
  if (task.branchName === branch) return [];
  return [{
    severity: "error",
    code: "diff.branchName",
    message: `current branch ${branch} does not match ${task.id} branchName ${task.branchName}`
  }];
}

export function collectEvidenceGateIssues(root: string, task: TaskContract): Issue[] {
  const { evidence, issues } = readEvidence(root, task.id);
  if (!evidence) {
    return issues.map((issue) => ({
      ...issue,
      code: `diff.${issue.code}`,
      message: `${issue.message}; run npm run scwbs -- evidence collect --task ${task.id} before opening a PR`
    }));
  }
  return issues.map((issue) => ({
    ...issue,
    code: `diff.${issue.code}`
  }));
}

export function runCheckDiff(root: string, taskId: string): number {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    printIssues(issues);
    return 1;
  }
  const files = changedFiles(root);
  const diffIssues = [
    ...collectBranchIssues(task, currentBranch(root)),
    ...collectEvidenceGateIssues(root, task),
    ...collectDiffIssues(root, task, files)
  ];
  if (diffIssues.length === 0) {
    console.log(`PASS check-diff ${taskId}`);
    return 0;
  }
  printIssues(diffIssues);
  return hasErrors(diffIssues) ? 1 : 0;
}
