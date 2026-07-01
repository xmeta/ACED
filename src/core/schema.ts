import { Ajv, type ErrorObject } from "ajv";
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

const ajv = new Ajv({ allErrors: true, strict: false });

const stringArraySchema = {
  type: "array",
  items: { type: "string" }
};

const registrySchema = {
  type: "object",
  required: ["projectId", "contracts"],
  additionalProperties: true,
  properties: {
    projectId: { type: "string", minLength: 1 },
    contracts: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type", "path"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["requirement", "spec", "task", "evidence", "approval", "review", "adr"] },
          path: { type: "string", minLength: 1 },
          status: { type: "string" },
          version: { type: "string" },
          featureId: { type: "string" },
          relatedTask: { type: "string" }
        }
      }
    }
  }
};

const specContractSchema = {
  type: "object",
  required: ["id", "type", "featureId", "title", "status", "version", "acceptanceCriteria"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "spec-contract" },
    featureId: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["draft", "approved", "superseded"] },
    version: { type: "string", minLength: 1 },
    summary: { type: "string" },
    sourcePaths: stringArraySchema,
    acceptanceCriteria: stringArraySchema,
    approvedBy: { type: "string" },
    approvedAt: { type: "string" }
  }
};

const taskContractSchema = {
  type: "object",
  required: ["id", "type", "wbsNodeId", "featureId", "allowedPaths", "forbiddenPaths", "humanGateRequiredPaths", "requiredChecks", "doneCriteria", "evidenceRequired"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "task-contract" },
    mode: { const: "lite" },
    wbsNodeId: { type: "string", minLength: 1 },
    featureId: { type: "string", minLength: 1 },
    branchName: { type: "string", minLength: 1 },
    allowedPaths: stringArraySchema,
    forbiddenPaths: stringArraySchema,
    humanGateRequiredPaths: stringArraySchema,
    requiredChecks: stringArraySchema,
    doneCriteria: stringArraySchema,
    evidenceRequired: stringArraySchema,
    contractLock: {
      type: "object",
      additionalProperties: true,
      properties: {
        wbsRevision: { type: "string" },
        wbsNodeId: { type: "string" },
        specVersion: { type: "string" },
        specRevision: { type: "string" },
        createdAt: { type: "string" }
      }
    }
  }
};

const evidenceSchema = {
  type: "object",
  required: ["id", "type", "taskId", "changedFiles", "checks"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "evidence" },
    taskId: { type: "string", minLength: 1 },
    commit: { type: "string" },
    changedFiles: stringArraySchema,
    git: {
      type: "object",
      additionalProperties: true,
      properties: {
        branch: { type: "string" },
        base: { type: "string" },
        headCommit: { type: "string" },
        pullRequest: { type: "string" }
      }
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "status"],
        additionalProperties: true,
        properties: {
          name: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["passed", "failed", "skipped"] },
          source: { type: "string" },
          runId: { type: "string" },
          url: { type: "string" },
          command: { type: "string" },
          exitStatus: { type: "number" },
          stdoutSummary: { type: "string" },
          stderrSummary: { type: "string" },
          executedAt: { type: "string" },
          verifiedBy: { type: "string" }
        }
      }
    },
    testQuality: {
      type: "object",
      additionalProperties: true,
      properties: {
        assertionsAdded: { type: "boolean" },
        testsDisabled: { type: "boolean" },
        coverageDecreased: { type: "boolean" },
        notes: stringArraySchema
      }
    },
    notes: stringArraySchema
  }
};

const approvalRecordSchema = {
  type: "object",
  required: ["id", "type", "taskId", "status"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "approval" },
    taskId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["requested", "approved", "rejected"] },
    approvedBy: { type: "string" },
    approvedAt: { type: "string" },
    pullRequest: { type: "string" },
    reason: { type: "string" },
    notes: stringArraySchema
  }
};

const reviewRecordSchema = {
  type: "object",
  required: ["id", "type", "taskId", "status", "reviewProfile", "groundTruth"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "review" },
    taskId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["requested", "approved", "changes-requested"] },
    reviewProfile: { type: "string", minLength: 1 },
    pullRequest: { type: "string" },
    groundTruth: stringArraySchema,
    requestedReviewers: {
      type: "array",
      items: {
        type: "object",
        required: ["role", "reason"],
        additionalProperties: true,
        properties: {
          role: { type: "string", minLength: 1 },
          user: { type: "string" },
          reason: { type: "string", minLength: 1 }
        }
      }
    },
    notes: stringArraySchema
  }
};

const schemaValidators = {
  registry: ajv.compile(registrySchema),
  spec: ajv.compile(specContractSchema),
  task: ajv.compile(taskContractSchema),
  evidence: ajv.compile(evidenceSchema),
  approval: ajv.compile(approvalRecordSchema),
  review: ajv.compile(reviewRecordSchema)
};

function formatSchemaPath(error: ErrorObject): string {
  return error.instancePath ? error.instancePath.replace(/\//g, ".").replace(/^\./, "") : "<root>";
}

function schemaIssues(kind: keyof typeof schemaValidators, value: unknown, filePath: string): Issue[] {
  const validate = schemaValidators[kind];
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) => issue(`${kind}.schema`, `${filePath}.${formatSchemaPath(error)} ${error.message ?? "does not match schema"}`));
}

export function validateRegistrySchema(value: unknown, filePath = "registry"): Issue[] {
  return schemaIssues("registry", value, filePath);
}

export function validateSpecContractSchema(value: unknown, filePath = "spec"): Issue[] {
  return schemaIssues("spec", value, filePath);
}

export function validateTaskContractSchema(value: unknown, filePath = "task"): Issue[] {
  return schemaIssues("task", value, filePath);
}

export function validateEvidenceSchema(value: unknown, filePath = "evidence"): Issue[] {
  return schemaIssues("evidence", value, filePath);
}

export function validateApprovalRecordSchema(value: unknown, filePath = "approval"): Issue[] {
  return schemaIssues("approval", value, filePath);
}

export function validateReviewRecordSchema(value: unknown, filePath = "review"): Issue[] {
  return schemaIssues("review", value, filePath);
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
      for (const key of ["branch", "base", "baseCommit", "changedFilesBasis", "headCommit", "pullRequest"]) {
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
      for (const key of ["source", "runId", "url", "command", "stdoutSummary", "stderrSummary", "executedAt", "verifiedBy"]) {
        if (check[key] !== undefined && typeof check[key] !== "string") {
          issues.push(issue("evidence.check", `${filePath}.checks[${index}].${key} must be a string when present`));
        }
      }
      if (check.exitStatus !== undefined && typeof check.exitStatus !== "number") {
        issues.push(issue("evidence.check", `${filePath}.checks[${index}].exitStatus must be a number when present`));
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
  for (const key of ["approvedBy", "approvedAt", "pullRequest", "reason"]) {
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
  if (value.requestedReviewers !== undefined) {
    if (!Array.isArray(value.requestedReviewers)) {
      issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers must be an array when present`));
    } else {
      value.requestedReviewers.forEach((reviewer, index) => {
        if (!isObject(reviewer)) {
          issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers[${index}] must be an object`));
          return;
        }
        for (const key of ["role", "reason"]) {
          if (typeof reviewer[key] !== "string" || reviewer[key].length === 0) {
            issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers[${index}].${key} must be a non-empty string`));
          }
        }
        if (reviewer.user !== undefined && typeof reviewer.user !== "string") {
          issues.push(issue("review.requestedReviewers", `${filePath}.requestedReviewers[${index}].user must be a string when present`));
        }
      });
    }
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
