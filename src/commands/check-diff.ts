import { approvalExists, readTask } from "../core/contracts.js";
import { changedFiles } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { hasErrors, printIssues } from "../core/report.js";
import type { Issue, TaskContract } from "../core/types.js";

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

export function runCheckDiff(root: string, taskId: string): number {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    printIssues(issues);
    return 1;
  }
  const files = changedFiles(root);
  const diffIssues = collectDiffIssues(root, task, files);
  if (diffIssues.length === 0) {
    console.log(`PASS check-diff ${taskId}`);
    return 0;
  }
  printIssues(diffIssues);
  return hasErrors(diffIssues) ? 1 : 0;
}
