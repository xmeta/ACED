import { createHash } from "node:crypto";
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
  "checkCoverageWaivers",
  "submoduleDependencies",
  "approvalPolicy"
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

export type TaskBootstrapAuthority = {
  verified: boolean;
  introductionCommit?: string;
  bootstrapFiles: string[];
  reasons: Issue[];
};

export type TaskAuthorityRepairPreflight = {
  schemaVersion: "1.0.0";
  mode: "read-only";
  mutationAllowed: false;
  targetTaskId: string;
  taskPath: string;
  trustedBaseCommit: string;
  changedFields: AuthorityField[];
  managedPathChanges: { added: string[]; removed: string[] };
  authorityFingerprint: { trusted: string; current: string };
  impact: {
    evidencePresent: boolean;
    approvalStatus: "missing" | "requested" | "approved" | "rejected";
    evidenceRegenerationRequired: true;
    approvalReRequestRequired: true;
    previousApprovalReusable: false;
  };
  requiredHumanDecision: string;
  recoverySteps: Array<{ step: number; actor: "ai" | "human"; action: string; command?: string }>;
};

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
      .sort((left, right) => `${left.check}\0${left.reason}`.localeCompare(`${right.check}\0${right.reason}`)),
    submoduleDependencies: [...(task.submoduleDependencies ?? [])]
      .map((dependency) => ({
        path: dependency.path,
        authorityMode: dependency.authorityMode,
        repository: dependency.repository,
        pullRequest: dependency.pullRequest,
        upstreamRef: dependency.upstreamRef,
        checks: [...(dependency.checks ?? [])]
          .map((check) => ({ name: check.name, status: check.status, url: check.url }))
          .sort((left, right) => `${left.name}\0${left.status}\0${left.url ?? ""}`.localeCompare(`${right.name}\0${right.status}\0${right.url ?? ""}`))
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    approvalPolicy: task.approvalPolicy?.mode === "delegated"
      ? { ...task.approvalPolicy, scopes: normalizedStrings(task.approvalPolicy.scopes) }
      : { mode: "human-only" }
  };
}

export function taskAuthorityFingerprint(task: TaskContract): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(taskAuthoritySnapshot(task))).digest("hex")}`;
}

export function changedTaskAuthorityFields(base: TaskContract, head: TaskContract): AuthorityField[] {
  const baseSnapshot = taskAuthoritySnapshot(base);
  const headSnapshot = taskAuthoritySnapshot(head);
  return TASK_AUTHORITY_FIELDS.filter((field) => JSON.stringify(baseSnapshot[field]) !== JSON.stringify(headSnapshot[field]));
}

export function buildTaskAuthorityRepairPreflights(
  root: string,
  baseRef: string,
  taskPaths: string[]
): TaskAuthorityRepairPreflight[] {
  if (isShallowRepository(root)) return [];
  const trustedBase = mergeBase(root, baseRef, "HEAD");
  if (!trustedBase) return [];

  const reports: TaskAuthorityRepairPreflight[] = [];
  for (const taskPath of [...new Set(taskPaths)].sort()) {
    const targetTaskId = taskPath.replace(/^contracts\/tasks\//, "").replace(/\.ya?ml$/, "");
    const { task: trustedTask } = taskAtRef(root, trustedBase, taskPath);
    const { task: currentTask } = readTask(root, targetTaskId);
    if (!trustedTask || !currentTask) continue;
    const changedFields = changedTaskAuthorityFields(trustedTask, currentTask);
    if (changedFields.length === 0) continue;

    const trustedManagedPaths = new Set(trustedTask.managedContractPaths ?? []);
    const currentManagedPaths = new Set(currentTask.managedContractPaths ?? []);
    const { evidence } = readEvidence(root, targetTaskId);
    const { approval } = readApproval(root, targetTaskId);
    const approvalStatus = approval?.status ?? "missing";
    reports.push({
      schemaVersion: "1.0.0",
      mode: "read-only",
      mutationAllowed: false,
      targetTaskId,
      taskPath,
      trustedBaseCommit: trustedBase,
      changedFields,
      managedPathChanges: {
        added: [...currentManagedPaths].filter((item) => !trustedManagedPaths.has(item)).sort(),
        removed: [...trustedManagedPaths].filter((item) => !currentManagedPaths.has(item)).sort()
      },
      authorityFingerprint: {
        trusted: taskAuthorityFingerprint(trustedTask),
        current: taskAuthorityFingerprint(currentTask)
      },
      impact: {
        evidencePresent: Boolean(evidence),
        approvalStatus,
        evidenceRegenerationRequired: true,
        approvalReRequestRequired: true,
        previousApprovalReusable: false
      },
      requiredHumanDecision: `A human must explicitly authorize the authority correction for ${targetTaskId} before the Task Contract is edited.`,
      recoverySteps: [
        { step: 1, actor: "ai", action: "Record a fail-closed block and stop implementation.", command: `npm run scwbs -- block "Task authority repair requires explicit human authorization" --task ${targetTaskId}` },
        { step: 2, actor: "human", action: "Review the changed fields and fingerprints, then explicitly authorize or reject the correction." },
        { step: 3, actor: "human", action: "After authorization, apply only the approved Task Contract correction." },
        { step: 4, actor: "ai", action: "Refresh the contract lock.", command: `npm run scwbs -- task lock --task ${targetTaskId}` },
        { step: 5, actor: "ai", action: "Regenerate Evidence for the corrected authority.", command: `npm run scwbs -- evidence collect --task ${targetTaskId} --force` },
        { step: 6, actor: "ai", action: "Request a fresh Approval for the current Evidence scope.", command: `npm run scwbs -- approval request --task ${targetTaskId} --force` },
        { step: 7, actor: "human", action: "Review the current Evidence and complete Human Approval. AI must stop and must not execute approval." },
        { step: 8, actor: "ai", action: "Rebuild the Registry after the Approval record changes.", command: "npm run scwbs -- registry rebuild --force" },
        { step: 9, actor: "ai", action: "Re-run the governed completion flow.", command: `npm run scwbs -- finish --task ${targetTaskId}` }
      ]
    });
  }
  return reports;
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

/**
 * Verifies the only new-task exception that a risk classifier may make: the
 * task's own, contract-only creation commit. This deliberately reuses the
 * authority trust-root checks instead of creating a second provenance path.
 */
export function verifyTaskBootstrapAuthority(root: string, baseRef: string, task: TaskContract): TaskBootstrapAuthority {
  const taskPath = `contracts/tasks/${task.id}.yaml`;
  if (isShallowRepository(root)) {
    return { verified: false, bootstrapFiles: [], reasons: [{ severity: "error", code: "classification.bootstrap.git.shallow", message: "Task bootstrap authority cannot be verified in a shallow repository" }] };
  }
  const trustedBase = mergeBase(root, baseRef, "HEAD");
  if (!trustedBase) {
    return { verified: false, bootstrapFiles: [], reasons: [{ severity: "error", code: "classification.bootstrap.git.mergeBase", message: `Task bootstrap authority cannot be verified because ${baseRef} and HEAD have no resolvable merge base` }] };
  }
  const introductionCommit = fileIntroductionCommit(root, trustedBase, "HEAD", taskPath);
  if (!introductionCommit) {
    return { verified: false, bootstrapFiles: [], reasons: [{ severity: "error", code: "classification.bootstrap.introduction.missing", message: `${taskPath} has no committed introduction after ${trustedBase}` }] };
  }
  const reasons = collectNewTaskTrustIssues(root, trustedBase, taskPath, task);
  return { verified: reasons.length === 0, introductionCommit, bootstrapFiles: commitChangedFiles(root, introductionCommit), reasons };
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
