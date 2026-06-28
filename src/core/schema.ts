import type { ApprovalRecord, Evidence, Issue, Registry, ReviewRecord, SpecContract, TaskContract, WbsDocument } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function issue(code: string, message: string): Issue {
  return { severity: "error", code, message };
}

export function validateRegistry(value: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("registry.invalid", "registry must be an object")];
  if (typeof value.projectId !== "string" || value.projectId.length === 0) {
    issues.push(issue("registry.projectId", "registry.projectId must be a non-empty string"));
  }
  if (!Array.isArray(value.contracts)) {
    issues.push(issue("registry.contracts", "registry.contracts must be an array"));
    return issues;
  }
  value.contracts.forEach((contract, index) => {
    if (!isObject(contract)) {
      issues.push(issue("registry.contract", `contracts[${index}] must be an object`));
      return;
    }
    for (const key of ["id", "type", "path"]) {
      if (typeof contract[key] !== "string" || contract[key].length === 0) {
        issues.push(issue("registry.contract", `contracts[${index}].${key} must be a non-empty string`));
      }
    }
  });
  return issues;
}

export function asRegistry(value: unknown): Registry {
  return value as Registry;
}

export function validateSpecContract(value: unknown, filePath = "spec"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("spec.invalid", `${filePath} must be an object`)];

  for (const key of ["id", "type", "featureId", "title", "status", "version"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("spec.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "spec-contract") {
    issues.push(issue("spec.type", `${filePath}.type must be spec-contract`));
  }
  if (value.status !== undefined && !["draft", "approved", "superseded"].includes(String(value.status))) {
    issues.push(issue("spec.status", `${filePath}.status must be draft, approved, or superseded`));
  }
  if (!isStringArray(value.acceptanceCriteria)) {
    issues.push(issue("spec.array", `${filePath}.acceptanceCriteria must be a string array`));
  }
  if (value.sourcePaths !== undefined && !isStringArray(value.sourcePaths)) {
    issues.push(issue("spec.array", `${filePath}.sourcePaths must be a string array when present`));
  }
  for (const key of ["summary", "approvedBy", "approvedAt"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("spec.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (value.status === "approved") {
    for (const key of ["approvedBy", "approvedAt"]) {
      if (typeof value[key] !== "string" || value[key].length === 0) {
        issues.push(issue("spec.approval", `${filePath}.${key} must be present when status is approved`));
      }
    }
  }
  return issues;
}

export function asSpecContract(value: unknown): SpecContract {
  return value as SpecContract;
}

export function validateTaskContract(value: unknown, filePath = "task"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("task.invalid", `${filePath} must be an object`)];
  const strings = ["id", "type", "wbsNodeId", "featureId"];
  for (const key of strings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("task.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "task-contract") {
    issues.push(issue("task.type", `${filePath}.type must be task-contract`));
  }
  if (value.branchName !== undefined && (typeof value.branchName !== "string" || value.branchName.length === 0)) {
    issues.push(issue("task.field", `${filePath}.branchName must be a non-empty string when present`));
  }
  if (value.mode !== undefined && value.mode !== "lite") {
    issues.push(issue("task.mode", `${filePath}.mode must be lite when present`));
  }
  for (const key of ["allowedPaths", "forbiddenPaths", "humanGateRequiredPaths", "requiredChecks", "doneCriteria", "evidenceRequired"]) {
    if (!isStringArray(value[key])) {
      issues.push(issue("task.array", `${filePath}.${key} must be a string array`));
    }
  }
  if (value.contractLock !== undefined) {
    if (!isObject(value.contractLock)) {
      issues.push(issue("task.contractLock", `${filePath}.contractLock must be an object when present`));
    } else {
      for (const key of ["wbsRevision", "wbsNodeId", "specVersion", "specRevision", "createdAt"]) {
        if (value.contractLock[key] !== undefined && typeof value.contractLock[key] !== "string") {
          issues.push(issue("task.contractLock", `${filePath}.contractLock.${key} must be a string when present`));
        }
      }
    }
  }
  return issues;
}

export function asTaskContract(value: unknown): TaskContract {
  return value as TaskContract;
}

export function validateEvidence(value: unknown, filePath = "evidence"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("evidence.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("evidence.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "evidence") {
    issues.push(issue("evidence.type", `${filePath}.type must be evidence`));
  }
  if (!isStringArray(value.changedFiles)) {
    issues.push(issue("evidence.changedFiles", `${filePath}.changedFiles must be a string array`));
  }
  if (value.git !== undefined) {
    if (!isObject(value.git)) {
      issues.push(issue("evidence.git", `${filePath}.git must be an object when present`));
    } else {
      for (const key of ["branch", "base", "headCommit", "pullRequest"]) {
        if (value.git[key] !== undefined && typeof value.git[key] !== "string") {
          issues.push(issue("evidence.git", `${filePath}.git.${key} must be a string when present`));
        }
      }
    }
  }
  if (!Array.isArray(value.checks)) {
    issues.push(issue("evidence.checks", `${filePath}.checks must be an array`));
  } else {
    value.checks.forEach((check, index) => {
      if (!isObject(check) || typeof check.name !== "string" || typeof check.status !== "string") {
        issues.push(issue("evidence.check", `${filePath}.checks[${index}] must include name and status`));
        return;
      }
      for (const key of ["source", "runId", "url", "command", "executedAt", "verifiedBy"]) {
        if (check[key] !== undefined && typeof check[key] !== "string") {
          issues.push(issue("evidence.check", `${filePath}.checks[${index}].${key} must be a string when present`));
        }
      }
    });
  }
  if (value.testQuality !== undefined) {
    if (!isObject(value.testQuality)) {
      issues.push(issue("evidence.testQuality", `${filePath}.testQuality must be an object when present`));
    } else {
      for (const key of ["assertionsAdded", "testsDisabled", "coverageDecreased"]) {
        if (value.testQuality[key] !== undefined && typeof value.testQuality[key] !== "boolean") {
          issues.push(issue("evidence.testQuality", `${filePath}.testQuality.${key} must be a boolean when present`));
        }
      }
      if (value.testQuality.notes !== undefined && !isStringArray(value.testQuality.notes)) {
        issues.push(issue("evidence.testQuality", `${filePath}.testQuality.notes must be a string array when present`));
      }
    }
  }
  return issues;
}

export function asEvidence(value: unknown): Evidence {
  return value as Evidence;
}

export function validateApprovalRecord(value: unknown, filePath = "approval"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("approval.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId", "status"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("approval.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "approval") {
    issues.push(issue("approval.type", `${filePath}.type must be approval`));
  }
  if (value.status !== undefined && !["requested", "approved", "rejected"].includes(String(value.status))) {
    issues.push(issue("approval.status", `${filePath}.status must be requested, approved, or rejected`));
  }
  for (const key of ["approvedBy", "approvedAt", "pullRequest"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("approval.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (value.notes !== undefined && !isStringArray(value.notes)) {
    issues.push(issue("approval.notes", `${filePath}.notes must be a string array when present`));
  }
  if (value.status === "approved") {
    for (const key of ["approvedBy", "approvedAt"]) {
      if (typeof value[key] !== "string" || value[key].length === 0) {
        issues.push(issue("approval.status", `${filePath}.${key} must be present when status is approved`));
      }
    }
  }
  return issues;
}

export function asApprovalRecord(value: unknown): ApprovalRecord {
  return value as ApprovalRecord;
}

export function validateReviewRecord(value: unknown, filePath = "review"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("review.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId", "status", "reviewProfile"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("review.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "review") {
    issues.push(issue("review.type", `${filePath}.type must be review`));
  }
  if (value.status !== undefined && !["requested", "approved", "changes-requested"].includes(String(value.status))) {
    issues.push(issue("review.status", `${filePath}.status must be requested, approved, or changes-requested`));
  }
  if (value.pullRequest !== undefined && typeof value.pullRequest !== "string") {
    issues.push(issue("review.field", `${filePath}.pullRequest must be a string when present`));
  }
  if (!isStringArray(value.groundTruth)) {
    issues.push(issue("review.groundTruth", `${filePath}.groundTruth must be a string array`));
  }
  if (value.notes !== undefined && !isStringArray(value.notes)) {
    issues.push(issue("review.notes", `${filePath}.notes must be a string array when present`));
  }
  return issues;
}

export function asReviewRecord(value: unknown): ReviewRecord {
  return value as ReviewRecord;
}

export function validateWbsShape(value: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("wbs.invalid", "WBS document must be an object")];
  for (const key of ["schemaVersion", "id", "name", "rootId"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("wbs.field", `WBS ${key} must be a non-empty string`));
    }
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    issues.push(issue("wbs.nodes", "WBS nodes must be a non-empty array"));
    return issues;
  }
  value.nodes.forEach((node, index) => {
    if (!isObject(node)) {
      issues.push(issue("wbs.node", `nodes[${index}] must be an object`));
      return;
    }
    for (const key of ["id", "code", "name", "type"]) {
      if (typeof node[key] !== "string" || node[key].length === 0) {
        issues.push(issue("wbs.node", `nodes[${index}].${key} must be a non-empty string`));
      }
    }
    if (!(typeof node.parentId === "string" || node.parentId === null)) {
      issues.push(issue("wbs.node", `nodes[${index}].parentId must be string or null`));
    }
  });
  return issues;
}

export function asWbsDocument(value: unknown): WbsDocument {
  return value as WbsDocument;
}
