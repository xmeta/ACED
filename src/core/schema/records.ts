import type { ErrorObject } from "ajv";
import type { ApprovalRecord, BlockRecord, Evidence, Issue, ReviewRecord } from "../types.js";
import { ajv, formatSchemaPath, isObject, isStringArray, issue, stringArraySchema } from "./shared.js";

const evidenceSchema = {
  type: "object",
  required: ["id", "type", "taskId", "changedFiles", "checks"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "evidence" },
    taskId: { type: "string", minLength: 1 },
    commit: { type: "string" },
    subjectHeadCommit: { type: "string" },
    evidenceCommit: { type: "string" },
    diffHash: { type: "string" },
    changedFiles: stringArraySchema,
    git: {
      type: "object",
      additionalProperties: true,
      properties: {
        branch: { type: "string" },
        base: { type: "string" },
        baseCommit: { type: "string" },
        changedFilesBasis: { type: "string" },
        subjectHeadCommit: { type: "string" },
        diffHash: { type: "string" },
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
          cacheKey: { type: "string" },
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
    headCommit: { type: "string" },
    diffHash: { type: "string" },
    pullRequest: { type: "string" },
    reason: { type: "string" },
    notes: stringArraySchema
  }
};

const blockRecordSchema = {
  type: "object",
  required: ["id", "type", "taskId", "status", "level", "category", "reason", "requiredHumanDecision", "createdAt"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "block" },
    taskId: { type: "string", minLength: 1 },
    status: { const: "blocked" },
    level: { type: "integer", enum: [1, 2] },
    category: { type: "string", enum: ["db", "auth", "permission", "security", "breaking-api", "business-rule", "human-gate", "external-service", "unknown"] },
    reason: { type: "string", minLength: 1 },
    requiredHumanDecision: { type: "string", minLength: 1 },
    createdAt: { type: "string" }
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
    headCommit: { type: "string" },
    diffHash: { type: "string" },
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

const validateEvidenceAjv = ajv.compile(evidenceSchema);
const validateApprovalAjv = ajv.compile(approvalRecordSchema);
const validateBlockAjv = ajv.compile(blockRecordSchema);
const validateReviewAjv = ajv.compile(reviewRecordSchema);

function schemaIssues(validate: ReturnType<typeof ajv.compile>, kind: string, value: unknown, filePath: string): Issue[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) =>
    issue(`${kind}.schema`, `${filePath}.${formatSchemaPath(error)} ${error.message ?? "does not match schema"}`)
  );
}

/* ── Evidence ── */

export function validateEvidenceSchema(value: unknown, filePath = "evidence"): Issue[] {
  return schemaIssues(validateEvidenceAjv, "evidence", value, filePath);
}

export function asEvidence(value: unknown): Evidence {
  return value as Evidence;
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
  for (const key of ["commit", "subjectHeadCommit", "evidenceCommit", "diffHash"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("evidence.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (!isStringArray(value.changedFiles)) {
    issues.push(issue("evidence.changedFiles", `${filePath}.changedFiles must be a string array`));
  }
  if (value.git !== undefined) {
    if (!isObject(value.git)) {
      issues.push(issue("evidence.git", `${filePath}.git must be an object when present`));
    } else {
      for (const key of ["branch", "base", "baseCommit", "changedFilesBasis", "subjectHeadCommit", "diffHash", "headCommit", "pullRequest"]) {
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
      for (const key of ["source", "runId", "url", "command", "cacheKey", "stdoutSummary", "stderrSummary", "executedAt", "verifiedBy"]) {
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

/* ── Approval Record ── */

export function validateApprovalRecordSchema(value: unknown, filePath = "approval"): Issue[] {
  return schemaIssues(validateApprovalAjv, "approval", value, filePath);
}

export function asApprovalRecord(value: unknown): ApprovalRecord {
  return value as ApprovalRecord;
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
  for (const key of ["approvedBy", "approvedAt", "headCommit", "diffHash", "pullRequest", "reason"]) {
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

/* ── Block Record ── */

export function validateBlockRecordSchema(value: unknown, filePath = "block"): Issue[] {
  return schemaIssues(validateBlockAjv, "block", value, filePath);
}

export function asBlockRecord(value: unknown): BlockRecord {
  return value as BlockRecord;
}

export function validateBlockRecord(value: unknown, filePath = "block"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("block.invalid", `${filePath} must be an object`)];
  for (const key of ["id", "type", "taskId", "status", "category", "reason", "requiredHumanDecision", "createdAt"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("block.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "block") {
    issues.push(issue("block.type", `${filePath}.type must be block`));
  }
  if (value.status !== "blocked") {
    issues.push(issue("block.status", `${filePath}.status must be blocked`));
  }
  if (value.level !== 1 && value.level !== 2) {
    issues.push(issue("block.level", `${filePath}.level must be 1 or 2`));
  }
  if (value.category !== undefined && !["db", "auth", "permission", "security", "breaking-api", "business-rule", "human-gate", "external-service", "unknown"].includes(String(value.category))) {
    issues.push(issue("block.category", `${filePath}.category is not a known stop category`));
  }
  return issues;
}

/* ── Review Record ── */

export function validateReviewRecordSchema(value: unknown, filePath = "review"): Issue[] {
  return schemaIssues(validateReviewAjv, "review", value, filePath);
}

export function asReviewRecord(value: unknown): ReviewRecord {
  return value as ReviewRecord;
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
  for (const key of ["headCommit", "diffHash", "pullRequest"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("review.field", `${filePath}.${key} must be a string when present`));
    }
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
