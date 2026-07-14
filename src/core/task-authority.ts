import { readApproval, readEvidence, readTask } from "./contracts.js";
import { commitChangedFiles, fileIntroductionCommit, gitObject, isShallowRepository, mergeBase } from "./git.js";
import { matchesAny } from "./glob.js";
import { validateHumanGateApproval } from "./human-gate.js";
import { matchesManagedContractPath } from "./managed-contract-paths.js";
import { asTaskContract, validateTaskContract, validateTaskContractSchema } from "./schema.js";
import type { Issue, TaskContract } from "./types.js";
import { parseSimpleYaml } from "./yaml.js";

export const TASK_AUTHORITY_FIELDS = [
  "allowedPaths",
  "forbiddenPaths",
  "humanGateRequiredPaths",
  "requiredChecks",
  "managedContractPaths",
  "checkCoverageWaivers"
] as const;

const REQUIRED_NEW_TASK_HUMAN_GATES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  ".github/**"
];

const UNSAFE_NEW_TASK_GLOBS = new Set(["**", "src/**", "tests/**", "docs/**", "contracts/**"]);

type AuthorityField = typeof TASK_AUTHORITY_FIELDS[number];
type AuthoritySnapshot = Record<AuthorityField, unknown>;

function normalizedStrings(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function taskAuthoritySnapshot(task: TaskContract): AuthoritySnapshot {
  return {
    allowedPaths: normalizedStrings(task.allowedPaths),
    forbiddenPaths: normalizedStrings(task.forbiddenPaths),
    humanGateRequiredPaths: normalizedStrings(task.humanGateRequiredPaths),
    requiredChecks: normalizedStrings(task.requiredChecks),
    managedContractPaths: normalizedStrings(task.managedContractPaths),
    checkCoverageWaivers: [...(task.checkCoverageWaivers ?? [])]
      .map((waiver) => ({ check: waiver.check, reason: waiver.reason }))
      .sort((left, right) => `${left.check}\0${left.reason}`.localeCompare(`${right.check}\0${right.reason}`))
  };
}

export function changedTaskAuthorityFields(base: TaskContract, head: TaskContract): AuthorityField[] {
  const baseSnapshot = taskAuthoritySnapshot(base);
  const headSnapshot = taskAuthoritySnapshot(head);
  return TASK_AUTHORITY_FIELDS.filter((field) => JSON.stringify(baseSnapshot[field]) !== JSON.stringify(headSnapshot[field]));
}

function taskAtRef(root: string, ref: string, relativePath: string): { task?: TaskContract; issues: Issue[] } {
  const source = gitObject(root, ref, relativePath);
  if (source === undefined) return { issues: [] };
  const value = parseSimpleYaml(source);
  const issues = [
    ...validateTaskContractSchema(value, `${ref}:${relativePath}`),
    ...validateTaskContract(value, `${ref}:${relativePath}`)
  ];
  return { task: issues.length === 0 ? asTaskContract(value) : undefined, issues };
}

function authorityApprovalIsValid(root: string, currentTask: TaskContract, taskPath: string, changedFiles: string[]): boolean {
  const syntheticGateTask = { ...currentTask, humanGateRequiredPaths: [taskPath] };
  const gate = validateHumanGateApproval(
    syntheticGateTask,
    readEvidence(root, currentTask.id).evidence,
    readApproval(root, currentTask.id).approval,
    changedFiles,
    root
  );
  return gate.required && gate.approved;
}

function hasIndependentGovernanceProvenance(currentTask: TaskContract, targetTaskId: string, targetPath: string): boolean {
  if (currentTask.id === targetTaskId || currentTask.wbsNodeId !== "node-governance-maintenance") return false;
  if (!matchesAny(targetPath, currentTask.allowedPaths) && !matchesManagedContractPath(currentTask, targetPath)) return false;
  return !matchesAny(targetPath, currentTask.forbiddenPaths) && !matchesAny(targetPath, currentTask.humanGateRequiredPaths);
}

function authorityChangeIssue(currentTask: TaskContract, targetTaskId: string, targetPath: string, fields: string[]): Issue {
  return {
    severity: "error",
    code: "diff.taskAuthority.change",
    message: `${targetTaskId} authority fields changed from the trusted contract: ${fields.join(", ")}. Self-authorized scope changes are not accepted.`,
    fixCommand: `Revert ${targetPath}, use a separate node-governance-maintenance Task, or run npm run scwbs -- approval request --task ${currentTask.id}`
  };
}

function collectNewTaskTrustIssues(root: string, mergeBaseRef: string, taskPath: string, headTask: TaskContract): Issue[] {
  const introduction = fileIntroductionCommit(root, mergeBaseRef, "HEAD", taskPath);
  if (!introduction) {
    return [{
      severity: "error",
      code: "diff.taskAuthority.newTask.uncommitted",
      message: `${taskPath} has no committed creation point after ${mergeBaseRef}; a working-tree contract is not a trust root`,
      fixCommand: `Commit only the new Task Contract and its managed index/registry files before implementation changes`
    }];
  }

  const { task: introducedTask, issues: introducedIssues } = taskAtRef(root, introduction, taskPath);
  if (!introducedTask) {
    return introducedIssues.length > 0 ? introducedIssues.map((issue) => ({
      ...issue,
      code: "diff.taskAuthority.newTask.invalid",
      fixCommand: `Repair the initial Task Contract commit ${introduction} before continuing`
    })) : [{
      severity: "error",
      code: "diff.taskAuthority.newTask.missing",
      message: `${taskPath} is missing from its recorded introduction commit ${introduction}`,
      fixCommand: `Repair the Task Contract history before continuing`
    }];
  }

  const issues: Issue[] = [];
  const changedFields = changedTaskAuthorityFields(introducedTask, headTask);
  if (changedFields.length > 0) issues.push(authorityChangeIssue(headTask, headTask.id, taskPath, changedFields));

  const unexpectedCreationFiles = commitChangedFiles(root, introduction).filter((file) => !matchesManagedContractPath(introducedTask, file));
  if (unexpectedCreationFiles.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.mixedCommit",
      message: `${taskPath} creation commit ${introduction} mixes non-managed files: ${unexpectedCreationFiles.join(", ")}`,
      fixCommand: `Recreate the Task Contract in a contract-only commit before implementation changes`
    });
  }
  if (introducedTask.contractLock?.lockVersion !== "2" || !introducedTask.contractLock.createdAt) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.lock",
      message: `${taskPath} creation commit does not contain a version 2 contractLock`,
      fixCommand: `Run npm run scwbs -- task lock --task ${headTask.id} before the contract-only creation commit`
    });
  }
  if (!matchesManagedContractPath(introducedTask, taskPath)) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.managedPath",
      message: `${taskPath} creation contract does not explicitly manage its own Task Contract path`,
      fixCommand: `Add ${taskPath} to managedContractPaths before the contract-only creation commit`
    });
  }
  const missingGates = REQUIRED_NEW_TASK_HUMAN_GATES.filter((path) => !introducedTask.humanGateRequiredPaths.includes(path));
  if (missingGates.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.humanGate",
      message: `${taskPath} creation contract omits required Human Gate paths: ${missingGates.join(", ")}`,
      fixCommand: `Restore the standard Human Gate paths in the contract creation commit`
    });
  }
  if (!introducedTask.forbiddenPaths.includes("wjs/**")) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.forbiddenPaths",
      message: `${taskPath} creation contract must retain the repository wjs/** boundary`,
      fixCommand: `Add wjs/** to forbiddenPaths in the contract creation commit`
    });
  }
  const broadScopes = introducedTask.allowedPaths.filter((path) => UNSAFE_NEW_TASK_GLOBS.has(path));
  if (broadScopes.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.broadScope",
      message: `${taskPath} creation contract uses unsafe repository-wide defaults: ${broadScopes.join(", ")}`,
      fixCommand: `Replace broad defaults with explicit implementation and test paths before the contract-only creation commit`
    });
  }
  if ((introducedTask.checkCoverageWaivers ?? []).length > 0) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.waiver",
      message: `${taskPath} creation contract cannot establish trust with checkCoverageWaivers`,
      fixCommand: `Remove creation-time waivers or request Human Approval for the current Evidence scope`
    });
  }
  const missingChecks = ["test", "typecheck", "build"].filter((check) => !introducedTask.requiredChecks.includes(check));
  if (missingChecks.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.taskAuthority.newTask.requiredChecks",
      message: `${taskPath} creation contract omits baseline checks: ${missingChecks.join(", ")}`,
      fixCommand: `Restore test, typecheck, and build in the contract creation commit`
    });
  }
  return issues;
}

export function collectTaskAuthorityIssues(
  root: string,
  currentTask: TaskContract,
  baseRef: string,
  changedFiles: string[]
): Issue[] {
  const taskPaths = changedFiles.filter((file) => /^contracts\/tasks\/[^/]+\.ya?ml$/.test(file) && file !== "contracts/tasks/index.yaml");
  if (taskPaths.length === 0) return [];
  if (isShallowRepository(root)) {
    return [{
      severity: "error",
      code: "diff.taskAuthority.git.shallow",
      message: `Task Contract authority cannot be verified in a shallow repository`,
      fixCommand: `Fetch full history for ${baseRef} before running check-diff`
    }];
  }
  const trustedBase = mergeBase(root, baseRef, "HEAD");
  if (!trustedBase) {
    return [{
      severity: "error",
      code: "diff.taskAuthority.git.mergeBase",
      message: `Task Contract authority cannot be verified because ${baseRef} and HEAD have no resolvable merge base`,
      fixCommand: `Fetch ${baseRef} and its history before running check-diff`
    }];
  }

  const issues: Issue[] = [];
  for (const taskPath of taskPaths) {
    const targetTaskId = taskPath.replace(/^contracts\/tasks\//, "").replace(/\.ya?ml$/, "");
    const { task: baseTask, issues: baseIssues } = taskAtRef(root, trustedBase, taskPath);
    const { task: headTask, issues: headIssues } = readTask(root, targetTaskId);
    if (baseIssues.length > 0) {
      issues.push(...baseIssues.map((issue) => ({ ...issue, code: "diff.taskAuthority.base.invalid" })));
      continue;
    }
    if (!headTask) {
      if (hasIndependentGovernanceProvenance(currentTask, targetTaskId, taskPath)) continue;
      const nonMissingIssues = headIssues.filter((issue) => issue.code !== "task.missing");
      issues.push(...(nonMissingIssues.length > 0 ? nonMissingIssues : [authorityChangeIssue(currentTask, targetTaskId, taskPath, ["contract deletion"])]));
      continue;
    }

    let authorityIssues: Issue[] = [];
    if (!baseTask) {
      authorityIssues = collectNewTaskTrustIssues(root, trustedBase, taskPath, headTask);
    } else {
      const fields = changedTaskAuthorityFields(baseTask, headTask);
      if (fields.length > 0 && !hasIndependentGovernanceProvenance(currentTask, targetTaskId, taskPath)) {
        authorityIssues.push(authorityChangeIssue(currentTask, targetTaskId, taskPath, fields));
      }
    }
    if (authorityIssues.length > 0 && authorityApprovalIsValid(root, currentTask, taskPath, changedFiles)) continue;
    issues.push(...authorityIssues);
  }
  return issues;
}
