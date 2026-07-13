import type { ErrorObject } from "ajv";
import type { Issue, SpecChangeProposal, SpecContract, TaskContract } from "../types.js";
import { ajv, formatSchemaPath, isObject, isStringArray, issue, stringArraySchema } from "./shared.js";

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

const specChangeProposalSchema = {
  type: "object",
  required: ["id", "type", "status", "targetSpec", "currentVersion", "proposedVersion", "taskId", "level", "summary", "rationale", "affectedPaths"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "spec-change-proposal" },
    status: { type: "string", enum: ["proposed", "approved", "rejected", "superseded"] },
    targetSpec: { type: "string", minLength: 1 },
    currentVersion: { type: "string", minLength: 1 },
    proposedVersion: { type: "string", minLength: 1 },
    taskId: { type: "string", minLength: 1 },
    level: { type: "integer", enum: [0, 1, 2] },
    summary: { type: "string", minLength: 1 },
    rationale: stringArraySchema,
    affectedPaths: stringArraySchema,
    approval: {
      type: "object",
      additionalProperties: true,
      properties: {
        required: { type: "boolean" },
        status: { type: "string", enum: ["requested", "approved", "rejected"] }
      }
    },
    risks: stringArraySchema,
    approvedBy: { type: "string" },
    approvedAt: { type: "string" }
  }
};

const taskContractSchema = {
  type: "object",
  required: ["id", "type", "wbsNodeId", "featureId", "allowedPaths", "forbiddenPaths", "humanGateRequiredPaths", "requiredChecks", "doneCriteria", "evidenceRequired"],
  additionalProperties: true,
  allOf: [
    {
      if: { properties: { completionScope: { const: "node" } }, required: ["completionScope"] },
      then: { required: ["completionTaskIds"] }
    }
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    type: { const: "task-contract" },
    mode: { const: "lite" },
    wbsNodeId: { type: "string", minLength: 1 },
    featureId: { type: "string", minLength: 1 },
    branchName: { type: "string", minLength: 1 },
    completionScope: { type: "string", enum: ["node"] },
    completionTaskIds: stringArraySchema,
    managedContractPaths: stringArraySchema,
    allowedPaths: stringArraySchema,
    forbiddenPaths: stringArraySchema,
    humanGateRequiredPaths: stringArraySchema,
    stopIf: stringArraySchema,
    requiredChecks: stringArraySchema,
    checkCoverageWaivers: {
      type: "array",
      items: {
        type: "object",
        required: ["check", "reason"],
        additionalProperties: true,
        properties: {
          check: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 }
        }
      }
    },
    submoduleDependencies: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        additionalProperties: true,
        properties: {
          path: { type: "string", minLength: 1 },
          repository: { type: "string", minLength: 1 },
          pullRequest: { type: "string", minLength: 1 },
          upstreamRef: { type: "string", minLength: 1 },
          checks: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "status"],
              additionalProperties: true,
              properties: {
                name: { type: "string", minLength: 1 },
                status: { type: "string", minLength: 1 },
                url: { type: "string", minLength: 1 }
              }
            }
          }
        }
      }
    },
    doneCriteria: stringArraySchema,
    evidenceRequired: stringArraySchema,
    contractLock: {
      type: "object",
      additionalProperties: true,
      properties: {
        lockVersion: { const: "2" },
        wbsRevision: { type: "string" },
        wbsScopeRevision: { type: "string" },
        wbsGlobalRevision: { type: "string" },
        wbsNodeId: { type: "string" },
        specVersion: { type: "string" },
        specRevision: { type: "string" },
        createdAt: { type: "string" }
      }
    }
  }
};

const validateSpecAjv = ajv.compile(specContractSchema);
const validateSpecChangeAjv = ajv.compile(specChangeProposalSchema);
const validateTaskAjv = ajv.compile(taskContractSchema);

function schemaIssues(validate: ReturnType<typeof ajv.compile>, kind: string, value: unknown, filePath: string): Issue[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error: ErrorObject) =>
    issue(`${kind}.schema`, `${filePath}.${formatSchemaPath(error)} ${error.message ?? "does not match schema"}`)
  );
}

/* ── Spec Contract ── */

export function validateSpecContractSchema(value: unknown, filePath = "spec"): Issue[] {
  return schemaIssues(validateSpecAjv, "spec", value, filePath);
}

export function asSpecContract(value: unknown): SpecContract {
  return value as SpecContract;
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

/* ── Spec Change Proposal ── */

export function validateSpecChangeProposalSchema(value: unknown, filePath = "spec-change"): Issue[] {
  return schemaIssues(validateSpecChangeAjv, "specChange", value, filePath);
}

export function asSpecChangeProposal(value: unknown): SpecChangeProposal {
  return value as SpecChangeProposal;
}

export function validateSpecChangeProposal(value: unknown, filePath = "spec-change"): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(value)) return [issue("specChange.invalid", `${filePath} must be an object`)];

  for (const key of ["id", "type", "status", "targetSpec", "currentVersion", "proposedVersion", "taskId", "summary"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      issues.push(issue("specChange.field", `${filePath}.${key} must be a non-empty string`));
    }
  }
  if (value.type !== "spec-change-proposal") {
    issues.push(issue("specChange.type", `${filePath}.type must be spec-change-proposal`));
  }
  if (value.status !== undefined && !["proposed", "approved", "rejected", "superseded"].includes(String(value.status))) {
    issues.push(issue("specChange.status", `${filePath}.status must be proposed, approved, rejected, or superseded`));
  }
  if (value.level !== 0 && value.level !== 1 && value.level !== 2) {
    issues.push(issue("specChange.level", `${filePath}.level must be 0, 1, or 2`));
  }
  if (!isStringArray(value.rationale)) {
    issues.push(issue("specChange.rationale", `${filePath}.rationale must be a string array`));
  }
  if (!isStringArray(value.affectedPaths)) {
    issues.push(issue("specChange.affectedPaths", `${filePath}.affectedPaths must be a string array`));
  }
  if (value.risks !== undefined && !isStringArray(value.risks)) {
    issues.push(issue("specChange.risks", `${filePath}.risks must be a string array when present`));
  }
  if (value.approval !== undefined) {
    if (!isObject(value.approval)) {
      issues.push(issue("specChange.approval", `${filePath}.approval must be an object when present`));
    } else {
      if (value.approval.required !== undefined && typeof value.approval.required !== "boolean") {
        issues.push(issue("specChange.approval", `${filePath}.approval.required must be a boolean when present`));
      }
      if (value.approval.status !== undefined && !["requested", "approved", "rejected"].includes(String(value.approval.status))) {
        issues.push(issue("specChange.approval", `${filePath}.approval.status must be requested, approved, or rejected`));
      }
    }
  }
  for (const key of ["approvedBy", "approvedAt"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      issues.push(issue("specChange.field", `${filePath}.${key} must be a string when present`));
    }
  }
  if (value.status === "approved") {
    for (const key of ["approvedBy", "approvedAt"]) {
      if (typeof value[key] !== "string" || value[key].length === 0) {
        issues.push(issue("specChange.approval", `${filePath}.${key} must be present when status is approved`));
      }
    }
  }
  return issues;
}

/* ── Task Contract ── */

export function validateTaskContractSchema(value: unknown, filePath = "task"): Issue[] {
  return schemaIssues(validateTaskAjv, "task", value, filePath);
}

export function asTaskContract(value: unknown): TaskContract {
  return value as TaskContract;
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
  if (value.stopIf !== undefined && !isStringArray(value.stopIf)) {
    issues.push(issue("task.array", `${filePath}.stopIf must be a string array when present`));
  }
  if (value.checkCoverageWaivers !== undefined) {
    if (!Array.isArray(value.checkCoverageWaivers)) {
      issues.push(issue("task.checkCoverageWaivers", `${filePath}.checkCoverageWaivers must be an array when present`));
    } else {
      value.checkCoverageWaivers.forEach((waiver, index) => {
        if (!isObject(waiver) || typeof waiver.check !== "string" || waiver.check.trim().length === 0 || typeof waiver.reason !== "string" || waiver.reason.trim().length === 0) {
          issues.push(issue("task.checkCoverageWaiver", `${filePath}.checkCoverageWaivers[${index}] must include non-empty check and reason`));
        }
      });
    }
  }
  if (value.submoduleDependencies !== undefined && !Array.isArray(value.submoduleDependencies)) {
    issues.push(issue("task.submoduleDependencies", `${filePath}.submoduleDependencies must be an array when present`));
  }
  if (value.contractLock !== undefined) {
    if (!isObject(value.contractLock)) {
      issues.push(issue("task.contractLock", `${filePath}.contractLock must be an object when present`));
    } else {
      for (const key of ["lockVersion", "wbsRevision", "wbsScopeRevision", "wbsGlobalRevision", "wbsNodeId", "specVersion", "specRevision", "createdAt"]) {
        if (value.contractLock[key] !== undefined && typeof value.contractLock[key] !== "string") {
          issues.push(issue("task.contractLock", `${filePath}.contractLock.${key} must be a string when present`));
        }
      }
      if (value.contractLock.lockVersion === "2") {
        for (const key of ["wbsScopeRevision", "wbsGlobalRevision", "wbsNodeId"]) {
          if (typeof value.contractLock[key] !== "string" || value.contractLock[key].length === 0) {
            issues.push(issue("task.contractLock", `${filePath}.contractLock.${key} must be present for lockVersion 2`));
          }
        }
      } else if (value.contractLock.wbsScopeRevision !== undefined || value.contractLock.wbsGlobalRevision !== undefined) {
        issues.push(issue("task.contractLock", `${filePath}.contractLock.lockVersion must be 2 when scoped WBS revisions are present`));
      }
    }
  }
  if (value.completionScope !== undefined && value.completionScope !== "node") {
    issues.push(issue("task.completionScope", `${filePath}.completionScope must be "node" when present`));
  }
  if (value.completionTaskIds !== undefined) {
    if (!isStringArray(value.completionTaskIds)) {
      issues.push(issue("task.completionTaskIds", `${filePath}.completionTaskIds must be a string array when present`));
    } else {
      if (new Set(value.completionTaskIds).size !== value.completionTaskIds.length) {
        issues.push(issue("task.completionTaskIds.duplicate", `${filePath}.completionTaskIds must not contain duplicates`));
      }
      if (typeof value.id === "string" && value.completionTaskIds.includes(value.id)) {
        issues.push(issue("task.completionTaskIds.selfReference", `${filePath}.completionTaskIds must not include itself`));
      }
    }
  }
  if (value.managedContractPaths !== undefined && !isStringArray(value.managedContractPaths)) {
    issues.push(issue("task.managedContractPaths", `${filePath}.managedContractPaths must be a string array when present`));
  }
  if (value.completionScope === "node" && (!isStringArray(value.completionTaskIds) || value.completionTaskIds.length === 0)) {
    issues.push(issue("task.completionTaskIds.required", `${filePath}.completionTaskIds is required when completionScope is "node"`));
  }
  return issues;
}
