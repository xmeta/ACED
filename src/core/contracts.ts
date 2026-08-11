import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readYamlFile } from "./yaml.js";
import { commitExists, isCommitAncestor, trackedTextFiles } from "./git.js";
import { matchesGlob } from "./glob.js";
import {
  approvalPath,
  blockPath,
  defaultApprovalsDir,
  defaultBlocksDir,
  defaultEvidenceDir,
  defaultRegistryPath,
  defaultReviewsDir,
  defaultRisksDir,
  defaultSpecChangesDir,
  defaultSpecsDir,
  defaultTasksDir,
  isValidTaskId,
  resolveFrom,
  reviewPath,
  taskPath,
  evidencePath
} from "./paths.js";
import {
  asApprovalRecord,
  asBlockRecord,
  asEvidence,
  asRegistry,
  asReviewRecord,
  asSpecChangeProposal,
  asSpecContract,
  asTaskContract,
  validateApprovalRecord,
  validateApprovalRecordSchema,
  validateBlockRecord,
  validateBlockRecordSchema,
  validateEvidence,
  validateEvidenceSchema,
  validateRegistry,
  validateRegistrySchema,
  validateReviewRecord,
  validateReviewRecordSchema,
  validateSpecChangeProposal,
  validateSpecChangeProposalSchema,
  validateSpecContract,
  validateSpecContractSchema,
  validateTaskContract,
  validateTaskContractSchema
} from "./schema.js";
import { activeTaskEntries, readTaskIndex } from "./task-index.js";
import type {
  ArtifactDefinition,
  ArtifactWorkflow,
  ApprovalRecord,
  BlockRecord,
  Evidence,
  Issue,
  Registry,
  RegistryContract,
  RequirementEvidence,
  RequirementVerificationMode,
  ReviewRecord,
  SpecChangeProposal,
  SpecContract,
  SpecRequirement,
  TaskContract,
  RiskRecord
} from "./types.js";
import { asRiskRecord, validateRiskRecord, validateRiskRecordSchema } from "./schema.js";

export function readRegistry(root: string): { registry?: Registry; issues: Issue[] } {
  const fullPath = resolveFrom(root, defaultRegistryPath);
  if (!existsSync(fullPath)) {
    return {
      issues: [{ severity: "error", code: "registry.missing", message: `${defaultRegistryPath} does not exist` }]
    };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateRegistrySchema(value, defaultRegistryPath), ...validateRegistry(value)];
  return { registry: issues.length === 0 ? asRegistry(value) : undefined, issues };
}

export function readTask(root: string, taskId: string): { task?: TaskContract; issues: Issue[] } {
  if (!isValidTaskId(taskId)) {
    return { issues: [{ severity: "error", code: "task.id.invalid", message: "Invalid task id" }] };
  }
  const relativePath = taskPath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "task.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateTaskContractSchema(value, relativePath), ...validateTaskContract(value, relativePath)];
  return { task: issues.length === 0 ? asTaskContract(value) : undefined, issues };
}

export function readSpec(root: string, relativePath: string): { spec?: SpecContract; issues: Issue[] } {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "spec.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateSpecContractSchema(value, relativePath), ...validateSpecContract(value, relativePath)];
  return { spec: issues.length === 0 ? asSpecContract(value) : undefined, issues };
}

export function readSpecChange(
  root: string,
  relativePath: string
): { specChange?: SpecChangeProposal; issues: Issue[] } {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "specChange.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [
    ...validateSpecChangeProposalSchema(value, relativePath),
    ...validateSpecChangeProposal(value, relativePath)
  ];
  return { specChange: issues.length === 0 ? asSpecChangeProposal(value) : undefined, issues };
}

export function readEvidence(root: string, taskId: string): { evidence?: Evidence; issues: Issue[] } {
  if (!isValidTaskId(taskId)) {
    return { issues: [{ severity: "error", code: "task.id.invalid", message: "Invalid task id" }] };
  }
  const relativePath = evidencePath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "evidence.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateEvidenceSchema(value, relativePath), ...validateEvidence(value, relativePath)];
  return { evidence: issues.length === 0 ? asEvidence(value) : undefined, issues };
}

export function readApproval(root: string, taskId: string): { approval?: ApprovalRecord; issues: Issue[] } {
  if (!isValidTaskId(taskId)) {
    return { issues: [{ severity: "error", code: "task.id.invalid", message: "Invalid task id" }] };
  }
  const relativePath = approvalPath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "approval.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateApprovalRecordSchema(value, relativePath), ...validateApprovalRecord(value, relativePath)];
  return { approval: issues.length === 0 ? asApprovalRecord(value) : undefined, issues };
}

export function readReview(root: string, taskId: string): { review?: ReviewRecord; issues: Issue[] } {
  if (!isValidTaskId(taskId)) {
    return { issues: [{ severity: "error", code: "task.id.invalid", message: "Invalid task id" }] };
  }
  const relativePath = reviewPath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "review.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateReviewRecordSchema(value, relativePath), ...validateReviewRecord(value, relativePath)];
  return { review: issues.length === 0 ? asReviewRecord(value) : undefined, issues };
}

export function readBlock(root: string, taskId: string): { block?: BlockRecord; issues: Issue[] } {
  if (!isValidTaskId(taskId)) {
    return { issues: [{ severity: "error", code: "task.id.invalid", message: "Invalid task id" }] };
  }
  const relativePath = blockPath(taskId);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "block.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateBlockRecordSchema(value, relativePath), ...validateBlockRecord(value, relativePath)];
  return { block: issues.length === 0 ? asBlockRecord(value) : undefined, issues };
}

export function listTasks(root: string): Array<{ task?: TaskContract; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultTasksDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => (file.endsWith(".yaml") || file.endsWith(".yml")) && file !== "index.yaml")
    .map((file) => {
      const path = `${defaultTasksDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateTaskContractSchema(value, path), ...validateTaskContract(value, path)];
      return { task: issues.length === 0 ? asTaskContract(value) : undefined, issues, path };
    });
}

export function listActiveTasks(root: string): Array<{ task?: TaskContract; issues: Issue[]; path: string }> {
  return activeTaskEntries(root, listTasks(root));
}

export function listSpecs(root: string): Array<{ spec?: SpecContract; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultSpecsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultSpecsDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateSpecContractSchema(value, path), ...validateSpecContract(value, path)];
      return { spec: issues.length === 0 ? asSpecContract(value) : undefined, issues, path };
    });
}

export function listSpecChanges(
  root: string
): Array<{ specChange?: SpecChangeProposal; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultSpecChangesDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultSpecChangesDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateSpecChangeProposalSchema(value, path), ...validateSpecChangeProposal(value, path)];
      return { specChange: issues.length === 0 ? asSpecChangeProposal(value) : undefined, issues, path };
    });
}

export function listApprovals(root: string): Array<{ approval?: ApprovalRecord; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultApprovalsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultApprovalsDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateApprovalRecordSchema(value, path), ...validateApprovalRecord(value, path)];
      return { approval: issues.length === 0 ? asApprovalRecord(value) : undefined, issues, path };
    });
}

export function listEvidence(root: string): Array<{ evidence?: Evidence; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultEvidenceDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultEvidenceDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateEvidenceSchema(value, path), ...validateEvidence(value, path)];
      return { evidence: issues.length === 0 ? asEvidence(value) : undefined, issues, path };
    });
}

export function listReviews(root: string): Array<{ review?: ReviewRecord; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultReviewsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultReviewsDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateReviewRecordSchema(value, path), ...validateReviewRecord(value, path)];
      return { review: issues.length === 0 ? asReviewRecord(value) : undefined, issues, path };
    });
}

export function listBlocks(root: string): Array<{ block?: BlockRecord; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultBlocksDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const path = `${defaultBlocksDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, path));
      const issues = [...validateBlockRecordSchema(value, path), ...validateBlockRecord(value, path)];
      return { block: issues.length === 0 ? asBlockRecord(value) : undefined, issues, path };
    });
}

export function listRisks(root: string): Array<{ risk?: RiskRecord; issues: Issue[]; path: string }> {
  const dir = resolveFrom(root, defaultRisksDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => {
      const relativePath = `${defaultRisksDir}/${file}`;
      const value = readYamlFile<unknown>(resolveFrom(root, relativePath));
      const issues = [...validateRiskRecordSchema(value, relativePath), ...validateRiskRecord(value, relativePath)];
      return { risk: issues.length === 0 ? asRiskRecord(value) : undefined, issues, path: relativePath };
    });
}

export function matchingSpecContract(registry: Registry | undefined, task: TaskContract): RegistryContract | undefined {
  return registry?.contracts.find((contract) => {
    if (contract.type !== "spec") return false;
    return contract.relatedTask === task.id || contract.featureId === task.featureId;
  });
}

export function matchingRegistrySpecByPath(
  registry: Registry | undefined,
  specPath: string
): RegistryContract | undefined {
  return registry?.contracts.find((contract) => contract.type === "spec" && contract.path === specPath);
}

export function matchingRegistrySpecChangeByPath(
  registry: Registry | undefined,
  specChangePath: string
): RegistryContract | undefined {
  return registry?.contracts.find((contract) => contract.type === "spec-change" && contract.path === specChangePath);
}

export function readSpecFromRegistryContract(
  root: string,
  contract: RegistryContract
): { spec?: SpecContract; path: string; issues: Issue[] } {
  const { spec, issues } = readSpec(root, contract.path);
  return { spec, path: contract.path, issues };
}

export function resolveSpecForTask(
  root: string,
  registry: Registry | undefined,
  task: TaskContract
): { contract?: RegistryContract; spec?: SpecContract; path?: string; issues: Issue[] } {
  const contract = matchingSpecContract(registry, task);
  if (!contract) return { issues: [] };
  const { spec, path, issues } = readSpecFromRegistryContract(root, contract);
  return { contract, spec, path, issues };
}

export function evidenceExists(root: string, taskId: string): boolean {
  return existsSync(resolveFrom(root, `${defaultEvidenceDir}/${taskId}.yaml`));
}

export function approvalExists(root: string, taskId: string): boolean {
  return existsSync(resolveFrom(root, approvalPath(taskId)));
}

export function reviewExists(root: string, taskId: string): boolean {
  return existsSync(resolveFrom(root, reviewPath(taskId)));
}

export type FeatureValidationStatus = "GO" | "NO-GO" | "MANUAL_VERIFY_REQUIRED";

export type FeatureValidationOptions = { baseRef?: string; json?: boolean };

type FeatureRequirementResult = {
  requirementId: string;
  statement: string;
  verificationMode: RequirementVerificationMode;
  taskIds: string[];
  evidenceStatus: "covered" | "not-covered" | "missing" | "stale" | "manual-required";
  issues: string[];
};

type FeatureValidationReport = {
  version: "scwbs.feature-validation.v1";
  status: FeatureValidationStatus;
  spec: { id: string; version: string; requirementsVersion?: string };
  requirements: FeatureRequirementResult[];
  unknownRequirementDeclarations: Array<{ taskId: string; requirementIds: string[] }>;
  warnings: string[];
  summary: { total: number; covered: number; notCovered: number; manualVerifyRequired: number };
};

function normalizedRequirements(spec: SpecContract): { requirements: SpecRequirement[]; warnings: string[] } {
  if (spec.requirements && spec.requirements.length > 0) return { requirements: spec.requirements, warnings: [] };
  return {
    requirements: spec.acceptanceCriteria.map((statement, index) => ({
      id: `LEGACY-${String(index + 1).padStart(3, "0")}`,
      statement,
      acceptanceScenarios: [statement],
      verificationMode: "manual",
      source: "legacy:acceptanceCriteria"
    })),
    warnings: [
      `${spec.id} uses legacy acceptanceCriteria; add requirementsVersion: 1.0.0 and stable requirement IDs before feature validation can produce GO`
    ]
  };
}

function featureTaskStatuses(root: string): Map<string, string> {
  const result = readTaskIndex(root);
  return new Map(result.index?.tasks.map((entry) => [entry.id, entry.status]) ?? []);
}

function featureEvidenceStatus(
  root: string,
  evidence: Evidence | undefined,
  coverage: RequirementEvidence | undefined,
  verificationMode: RequirementVerificationMode,
  baseRef: string
): { status: FeatureRequirementResult["evidenceStatus"]; issues: string[] } {
  if (!evidence || !coverage) return { status: "missing", issues: ["Requirement Evidence is missing"] };
  if (
    coverage.subjectHeadCommit !== evidence.subjectHeadCommit ||
    coverage.diffHash !== evidence.diffHash ||
    !coverage.subjectHeadCommit ||
    !coverage.diffHash
  ) {
    return {
      status: "stale",
      issues: ["Requirement Evidence provenance does not match Evidence subjectHeadCommit/diffHash"]
    };
  }
  if (!commitExists(root, coverage.subjectHeadCommit))
    return { status: "stale", issues: ["Requirement Evidence subject HEAD does not exist"] };
  if (!isCommitAncestor(root, coverage.subjectHeadCommit, baseRef)) {
    return { status: "stale", issues: [`Requirement Evidence subject HEAD is not merged into ${baseRef}`] };
  }
  if (coverage.status === "not-covered")
    return { status: "not-covered", issues: ["Evidence explicitly marks the requirement as not-covered"] };
  const humanReference = coverage.references.some((reference) => /^(human|manual):/i.test(reference));
  if (verificationMode === "manual" || verificationMode === "hybrid") {
    return coverage.status === "covered" && humanReference
      ? { status: "covered", issues: [] }
      : { status: "manual-required", issues: ["Manual or hybrid Requirement requires explicit human evidence"] };
  }
  const passedChecks = new Set(evidence.checks.filter((check) => check.status === "passed").map((check) => check.name));
  const checkNames = coverage.checkNames ?? [];
  return coverage.status === "covered" && checkNames.length > 0 && checkNames.every((check) => passedChecks.has(check))
    ? { status: "covered", issues: [] }
    : {
        status: "not-covered",
        issues: ["Automated Requirement needs covered status and current passed check references"]
      };
}

function printFeatureValidation(report: FeatureValidationReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Feature validation: ${report.status}\n`);
  report.requirements.forEach((requirement) =>
    process.stdout.write(
      `- ${requirement.requirementId}: ${requirement.evidenceStatus}${requirement.issues.length > 0 ? ` (${requirement.issues.join("; ")})` : ""}\n`
    )
  );
  report.warnings.forEach((warning) => process.stdout.write(`WARN ${warning}\n`));
}

export function runValidateFeature(root: string, specId: string, options: FeatureValidationOptions = {}): number {
  const specEntry = listSpecs(root).find((entry) => entry.spec?.id === specId);
  if (!specEntry?.spec) {
    const report: FeatureValidationReport = {
      version: "scwbs.feature-validation.v1",
      status: "NO-GO",
      spec: { id: specId, version: "unknown" },
      requirements: [],
      unknownRequirementDeclarations: [],
      warnings: [`Spec ${specId} was not found`],
      summary: { total: 0, covered: 0, notCovered: 0, manualVerifyRequired: 0 }
    };
    printFeatureValidation(report, options.json ?? false);
    return 1;
  }
  const spec = specEntry.spec;
  const normalized = normalizedRequirements(spec);
  const tasks = listTasks(root).flatMap((entry) => (entry.task ? [entry.task] : []));
  const statuses = featureTaskStatuses(root);
  const baseRef = options.baseRef ?? "origin/main";
  const knownIds = new Set(normalized.requirements.map((requirement) => requirement.id));
  const unknownRequirementDeclarations = tasks.flatMap((task) => {
    const requirementIds = (task.requirementIds ?? []).filter((id) => !knownIds.has(id));
    return requirementIds.length > 0 ? [{ taskId: task.id, requirementIds }] : [];
  });
  const requirements = normalized.requirements.map((requirement): FeatureRequirementResult => {
    const owners = tasks.filter((task) => task.requirementIds?.includes(requirement.id));
    const taskIds = owners.map((task) => task.id);
    const issues: string[] = [];
    if (owners.length === 0) issues.push("No Task declares ownership of this Requirement");
    if (owners.length > 1) issues.push(`Duplicate ownership by ${taskIds.join(", ")}`);
    if (owners.length !== 1)
      return {
        requirementId: requirement.id,
        statement: requirement.statement,
        verificationMode: requirement.verificationMode,
        taskIds,
        evidenceStatus: "not-covered",
        issues
      };
    const task = owners[0] as TaskContract;
    const taskStatus = statuses.get(task.id) ?? "planned";
    if (!["completed", "archived"].includes(taskStatus))
      issues.push(`Task ${task.id} is ${taskStatus}, not completed or archived`);
    const { evidence } = readEvidence(root, task.id);
    const coverage = evidence?.requirementEvidence?.find((entry) => entry.requirementId === requirement.id);
    const evidenceResult = featureEvidenceStatus(root, evidence, coverage, requirement.verificationMode, baseRef);
    issues.push(...evidenceResult.issues);
    return {
      requirementId: requirement.id,
      statement: requirement.statement,
      verificationMode: requirement.verificationMode,
      taskIds,
      evidenceStatus: issues.length > 0 ? evidenceResult.status : "covered",
      issues
    };
  });
  const manualVerifyRequired = requirements.filter(
    (requirement) => requirement.evidenceStatus === "manual-required"
  ).length;
  const notCovered = requirements.filter(
    (requirement) => !["covered", "manual-required"].includes(requirement.evidenceStatus)
  ).length;
  const report: FeatureValidationReport = {
    version: "scwbs.feature-validation.v1",
    status: notCovered > 0 ? "NO-GO" : manualVerifyRequired > 0 ? "MANUAL_VERIFY_REQUIRED" : "GO",
    spec: {
      id: spec.id,
      version: spec.version,
      ...(spec.requirementsVersion ? { requirementsVersion: spec.requirementsVersion } : {})
    },
    requirements,
    unknownRequirementDeclarations,
    warnings: [
      ...normalized.warnings,
      ...unknownRequirementDeclarations.map(
        (entry) => `Task ${entry.taskId} declares unknown Requirement IDs: ${entry.requirementIds.join(", ")}`
      )
    ],
    summary: {
      total: requirements.length,
      covered: requirements.length - notCovered - manualVerifyRequired,
      notCovered,
      manualVerifyRequired
    }
  };
  if (unknownRequirementDeclarations.length > 0 && report.status === "GO") report.status = "NO-GO";
  printFeatureValidation(report, options.json ?? false);
  return report.status === "GO" ? 0 : report.status === "MANUAL_VERIFY_REQUIRED" ? 2 : 1;
}

const artifactWorkflowRootKeys = new Set(["version", "id", "artifacts", "profiles"]);
const artifactDefinitionKeys = new Set([
  "id",
  "path",
  "description",
  "dependencies",
  "template",
  "instruction",
  "context",
  "rules",
  "validation",
  "completion"
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeArtifactPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..") && !normalized.includes("\0");
}

function artifactWorkflowValue(root: string, relativePath: string): unknown {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) throw new Error(`${relativePath} does not exist`);
  const source = readFileSync(fullPath, "utf8");
  return relativePath.endsWith(".json") ? (JSON.parse(source) as unknown) : readYamlFile<unknown>(fullPath);
}

export function readArtifactWorkflow(
  root: string,
  relativePath: string
): { workflow?: ArtifactWorkflow; issues: Issue[] } {
  let value: unknown;
  try {
    value = artifactWorkflowValue(root, relativePath);
  } catch (error) {
    return {
      issues: [
        { severity: "error", code: "workflow.read", message: error instanceof Error ? error.message : String(error) }
      ]
    };
  }
  const issues: Issue[] = [];
  if (!isObjectRecord(value))
    return {
      issues: [{ severity: "error", code: "workflow.object", message: `${relativePath} must contain an object` }]
    };
  for (const key of Object.keys(value))
    if (!artifactWorkflowRootKeys.has(key))
      issues.push({
        severity: "error",
        code: "workflow.unknownField",
        message: `${relativePath}.${key} is not supported`
      });
  if (value.version !== "1.0.0")
    issues.push({ severity: "error", code: "workflow.version", message: `${relativePath}.version must be 1.0.0` });
  if (typeof value.id !== "string" || value.id.length === 0)
    issues.push({ severity: "error", code: "workflow.id", message: `${relativePath}.id must be a non-empty string` });
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0)
    issues.push({
      severity: "error",
      code: "workflow.artifacts",
      message: `${relativePath}.artifacts must be a non-empty array`
    });
  const artifacts: ArtifactDefinition[] = [];
  const ids = new Set<string>();
  if (Array.isArray(value.artifacts))
    value.artifacts.forEach((raw, index) => {
      const label = `${relativePath}.artifacts[${index}]`;
      if (!isObjectRecord(raw)) {
        issues.push({ severity: "error", code: "workflow.artifact", message: `${label} must be an object` });
        return;
      }
      for (const key of Object.keys(raw))
        if (!artifactDefinitionKeys.has(key))
          issues.push({
            severity: "error",
            code: "workflow.unknownField",
            message: `${label}.${key} is not supported`
          });
      const id = typeof raw.id === "string" ? raw.id : "";
      const artifactPath = typeof raw.path === "string" ? raw.path : "";
      const description = typeof raw.description === "string" ? raw.description : "";
      const dependencies =
        Array.isArray(raw.dependencies) && raw.dependencies.every((item) => typeof item === "string")
          ? (raw.dependencies as string[])
          : [];
      if (!id)
        issues.push({
          severity: "error",
          code: "workflow.artifact.id",
          message: `${label}.id must be a non-empty string`
        });
      if (ids.has(id))
        issues.push({
          severity: "error",
          code: "workflow.duplicateId",
          message: `${relativePath} contains duplicate artifact id ${id}`
        });
      ids.add(id);
      if (!artifactPath || !safeArtifactPath(artifactPath))
        issues.push({
          severity: "error",
          code: "workflow.pathEscape",
          message: `${label}.path must remain inside the repository`
        });
      if (!description)
        issues.push({
          severity: "error",
          code: "workflow.artifact.description",
          message: `${label}.description must be a non-empty string`
        });
      if (!Array.isArray(raw.dependencies) || !raw.dependencies.every((item) => typeof item === "string"))
        issues.push({
          severity: "error",
          code: "workflow.dependencies",
          message: `${label}.dependencies must be a string array`
        });
      if (raw.template !== undefined && (typeof raw.template !== "string" || raw.template.length === 0))
        issues.push({
          severity: "error",
          code: "workflow.template",
          message: `${label}.template must be a non-empty string`
        });
      if (raw.instruction !== undefined && (typeof raw.instruction !== "string" || raw.instruction.length === 0))
        issues.push({
          severity: "error",
          code: "workflow.instruction",
          message: `${label}.instruction must be a non-empty string`
        });
      if (
        raw.context !== undefined &&
        (!Array.isArray(raw.context) || !raw.context.every((item) => typeof item === "string" && item.length > 0))
      )
        issues.push({
          severity: "error",
          code: "workflow.context",
          message: `${label}.context must be a non-empty string array`
        });
      if (
        raw.rules !== undefined &&
        (!Array.isArray(raw.rules) || !raw.rules.every((item) => typeof item === "string" && item.length > 0))
      )
        issues.push({
          severity: "error",
          code: "workflow.rules",
          message: `${label}.rules must be a non-empty string array`
        });
      if (raw.validation !== undefined && (typeof raw.validation !== "string" || raw.validation.length === 0))
        issues.push({
          severity: "error",
          code: "workflow.validation",
          message: `${label}.validation must be a non-empty string`
        });
      const completionValue = isObjectRecord(raw.completion) ? raw.completion : undefined;
      if (completionValue)
        for (const key of Object.keys(completionValue))
          if (!["mode", "path"].includes(key))
            issues.push({
              severity: "error",
              code: "workflow.unknownField",
              message: `${label}.completion.${key} is not supported`
            });
      if (
        completionValue?.path !== undefined &&
        (typeof completionValue.path !== "string" || completionValue.path.length === 0)
      )
        issues.push({
          severity: "error",
          code: "workflow.completion.path",
          message: `${label}.completion.path must be a non-empty string`
        });
      const completion =
        completionValue?.mode === "path-exists"
          ? {
              mode: "path-exists" as const,
              ...(typeof completionValue.path === "string" ? { path: completionValue.path } : {})
            }
          : undefined;
      if (!completion)
        issues.push({
          severity: "error",
          code: "workflow.completion",
          message: `${label}.completion.mode must be path-exists`
        });
      if (completion && completion.path !== undefined && !safeArtifactPath(completion.path))
        issues.push({
          severity: "error",
          code: "workflow.pathEscape",
          message: `${label}.completion.path must remain inside the repository`
        });
      if (id && artifactPath && description && completion)
        artifacts.push({
          id,
          path: artifactPath,
          description,
          dependencies,
          ...(typeof raw.template === "string" ? { template: raw.template } : {}),
          ...(typeof raw.instruction === "string" ? { instruction: raw.instruction } : {}),
          ...(Array.isArray(raw.context) && raw.context.every((item) => typeof item === "string")
            ? { context: raw.context as string[] }
            : {}),
          ...(Array.isArray(raw.rules) && raw.rules.every((item) => typeof item === "string")
            ? { rules: raw.rules as string[] }
            : {}),
          ...(typeof raw.validation === "string" ? { validation: raw.validation } : {}),
          completion
        });
    });
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  artifacts.forEach((artifact) =>
    artifact.dependencies.forEach((dependency) => {
      if (!artifactIds.has(dependency))
        issues.push({
          severity: "error",
          code: "workflow.missingDependency",
          message: `${relativePath}.${artifact.id} depends on unknown artifact ${dependency}`
        });
      if (dependency === artifact.id)
        issues.push({
          severity: "error",
          code: "workflow.cycle",
          message: `${relativePath}.${artifact.id} cannot depend on itself`
        });
    })
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push({
        severity: "error",
        code: "workflow.cycle",
        message: `${relativePath} contains a dependency cycle at ${id}`
      });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    byId
      .get(id)
      ?.dependencies.filter((dependency) => byId.has(dependency))
      .forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  artifacts.forEach((artifact) => visit(artifact.id));
  if (value.profiles !== undefined) {
    if (!isObjectRecord(value.profiles))
      issues.push({
        severity: "error",
        code: "workflow.profiles",
        message: `${relativePath}.profiles must be an object`
      });
    else
      Object.entries(value.profiles).forEach(([profile, members]) => {
        if (
          !Array.isArray(members) ||
          !members.every((member) => typeof member === "string" && artifactIds.has(member))
        )
          issues.push({
            severity: "error",
            code: "workflow.profiles",
            message: `${relativePath}.profiles.${profile} must reference known artifact IDs`
          });
      });
  }
  return issues.length > 0
    ? { issues }
    : {
        workflow: {
          version: "1.0.0",
          id: value.id as string,
          artifacts,
          ...(isObjectRecord(value.profiles) ? { profiles: value.profiles as Record<string, string[]> } : {})
        },
        issues: []
      };
}

export type ArtifactWorkflowStatus = {
  version: "scwbs.artifact-workflow-status.v1";
  workflowId: string;
  artifacts: Array<{
    id: string;
    state: "blocked" | "ready" | "done";
    path: string;
    missingDependencies: string[];
    unlocks: string[];
  }>;
};

export function buildArtifactWorkflowStatus(root: string, workflow: ArtifactWorkflow): ArtifactWorkflowStatus {
  const files = trackedTextFiles(root);
  const done = new Set(
    workflow.artifacts
      .filter((artifact) =>
        files.some(
          (file) =>
            matchesGlob(file, artifact.path) ||
            (artifact.completion.path !== undefined && matchesGlob(file, artifact.completion.path))
        )
      )
      .map((artifact) => artifact.id)
  );
  return {
    version: "scwbs.artifact-workflow-status.v1",
    workflowId: workflow.id,
    artifacts: workflow.artifacts.map((artifact) => {
      const missingDependencies = artifact.dependencies.filter((dependency) => !done.has(dependency));
      const unlocks = workflow.artifacts
        .filter((candidate) => candidate.dependencies.includes(artifact.id))
        .map((candidate) => candidate.id)
        .sort();
      return {
        id: artifact.id,
        state: done.has(artifact.id) ? "done" : missingDependencies.length > 0 ? "blocked" : "ready",
        path: artifact.path,
        missingDependencies,
        unlocks
      };
    })
  };
}

export function runArtifactWorkflowStatus(
  root: string,
  relativePath: string,
  options: { json?: boolean } = {}
): number {
  const result = readArtifactWorkflow(root, relativePath);
  if (!result.workflow) {
    result.issues.forEach((item) => console.error(`ERROR ${item.code}: ${item.message}`));
    return 1;
  }
  const report = buildArtifactWorkflowStatus(root, result.workflow);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else report.artifacts.forEach((artifact) => process.stdout.write(`${artifact.id}: ${artifact.state}\n`));
  return 0;
}

export function runArtifactWorkflowInstructions(
  root: string,
  relativePath: string,
  artifactId: string,
  options: { json?: boolean } = {}
): number {
  const result = readArtifactWorkflow(root, relativePath);
  const artifact = result.workflow?.artifacts.find((candidate) => candidate.id === artifactId);
  if (!result.workflow || !artifact) {
    [
      ...result.issues,
      ...(result.workflow
        ? [{ severity: "error" as const, code: "workflow.artifact.missing", message: `Unknown artifact ${artifactId}` }]
        : [])
    ].forEach((item) => console.error(`ERROR ${item.code}: ${item.message}`));
    return 1;
  }
  const status = buildArtifactWorkflowStatus(root, result.workflow);
  const snapshot = {
    version: "scwbs.artifact-workflow-instructions.v1",
    workflowId: result.workflow.id,
    artifact,
    dependencySnapshot: status.artifacts.filter((candidate) => artifact.dependencies.includes(candidate.id)),
    authority: "advisory-only; Task Contract, Approval, Human Gate, and Evidence provenance remain authoritative"
  };
  if (options.json) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  else process.stdout.write(`${artifact.id}\n${artifact.instruction ?? "No instruction declared."}\n`);
  return 0;
}

type PlanningStoreSharedSpec = {
  repositoryId: string;
  path: string;
  commit: string;
  contentHash: string;
  dependsOn: string[];
};

type PlanningStoreRepository = { id: string; root: string };
type PlanningStoreWorkset = { id: string; repositories: string[]; sharedSpecs: PlanningStoreSharedSpec[] };
type PlanningStore = {
  id: string;
  root: string;
  repositories: PlanningStoreRepository[];
  worksets: PlanningStoreWorkset[];
};
type PlanningStoreRegistry = { version: "1.0.0"; stores: PlanningStore[] };

const planningStoreRootKeys = new Set(["version", "stores"]);
const planningStoreKeys = new Set(["id", "root", "repositories", "worksets"]);
const planningStoreRepositoryKeys = new Set(["id", "root"]);
const planningStoreWorksetKeys = new Set(["id", "repositories", "sharedSpecs"]);
const planningStoreSharedSpecKeys = new Set(["repositoryId", "path", "commit", "contentHash", "dependsOn"]);

export type PlanningStoreListReport = {
  version: "scwbs.planning-store-list.v1";
  registryPath: string;
  stores: Array<{ id: string; root: string; repositoryIds: string[]; worksetIds: string[] }>;
  authority: "read-only-advisory";
};

export type PlanningStoreShowReport = {
  version: "scwbs.planning-store-show.v1";
  status: "ready" | "stale" | "blocked";
  store: { id: string; root: string; registryPath: string };
  repositories: Array<{
    id: string;
    root: string;
    trust: "trusted" | "dirty" | "missing" | "untrusted";
    headCommit: string | null;
    taskIndex: "available" | "missing";
    evidence: "available" | "missing";
    ci: "repository-local-only";
  }>;
  worksets: Array<{
    id: string;
    repositories: string[];
    status: "ready" | "blocked" | "stale";
    taskEvidenceCi: string;
  }>;
  sharedSpecs: Array<{
    repositoryId: string;
    path: string;
    pinnedCommit: string;
    expectedContentHash: string;
    currentHeadCommit: string | null;
    currentContentHash: string | null;
    status: "ready" | "stale" | "blocked";
  }>;
  review: { cycles: string[]; pathEscapes: string[]; authorityDowngrades: string[] };
  provenance: { storeId: string; storeRoot: string; referencedCommits: string[]; contentHashes: string[] };
  authority: "read-only-advisory; repository Task Contract, Evidence, Approval, Human Gate, and required checks remain authoritative";
  nextAction: string;
};

function planningStoreError(code: string, message: string): Issue {
  return { severity: "error", code, message };
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): Issue[] {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => planningStoreError("planningStore.unknownField", `${label}.${key} is not supported`));
}

function safeStoreRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").includes("..") &&
    !normalized.includes("\0")
  );
}

function planningStoreValue(root: string, relativePath: string): unknown {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) throw new Error(`${relativePath} does not exist`);
  return readYamlFile<unknown>(fullPath);
}

export function readPlanningStoreRegistry(
  root: string,
  relativePath: string
): { registry?: PlanningStoreRegistry; issues: Issue[] } {
  let value: unknown;
  try {
    value = planningStoreValue(root, relativePath);
  } catch (error) {
    return {
      issues: [planningStoreError("planningStore.read", error instanceof Error ? error.message : String(error))]
    };
  }
  const issues: Issue[] = [];
  if (!isObjectRecord(value))
    return { issues: [planningStoreError("planningStore.object", `${relativePath} must contain an object`)] };
  issues.push(...unknownKeys(value, planningStoreRootKeys, relativePath));
  if (value.version !== "1.0.0")
    issues.push(planningStoreError("planningStore.version", `${relativePath}.version must be 1.0.0`));
  if (!Array.isArray(value.stores) || value.stores.length === 0)
    issues.push(planningStoreError("planningStore.stores", `${relativePath}.stores must be a non-empty array`));
  const stores: PlanningStore[] = [];
  const storeIds = new Set<string>();
  if (Array.isArray(value.stores))
    value.stores.forEach((rawStore, storeIndex) => {
      const storeLabel = `${relativePath}.stores[${storeIndex}]`;
      if (!isObjectRecord(rawStore)) {
        issues.push(planningStoreError("planningStore.store", `${storeLabel} must be an object`));
        return;
      }
      issues.push(...unknownKeys(rawStore, planningStoreKeys, storeLabel));
      const id = typeof rawStore.id === "string" ? rawStore.id : "";
      const storeRoot = typeof rawStore.root === "string" ? rawStore.root : "";
      if (!id) issues.push(planningStoreError("planningStore.id", `${storeLabel}.id must be a non-empty string`));
      if (storeIds.has(id)) issues.push(planningStoreError("planningStore.duplicateId", `Duplicate store id ${id}`));
      storeIds.add(id);
      if (!storeRoot)
        issues.push(planningStoreError("planningStore.root", `${storeLabel}.root must be a non-empty string`));
      const repositories: PlanningStoreRepository[] = [];
      const repositoryIds = new Set<string>();
      if (!Array.isArray(rawStore.repositories) || rawStore.repositories.length === 0)
        issues.push(
          planningStoreError("planningStore.repositories", `${storeLabel}.repositories must be a non-empty array`)
        );
      if (Array.isArray(rawStore.repositories))
        rawStore.repositories.forEach((rawRepository, repositoryIndex) => {
          const label = `${storeLabel}.repositories[${repositoryIndex}]`;
          if (!isObjectRecord(rawRepository)) {
            issues.push(planningStoreError("planningStore.repository", `${label} must be an object`));
            return;
          }
          issues.push(...unknownKeys(rawRepository, planningStoreRepositoryKeys, label));
          const repositoryId = typeof rawRepository.id === "string" ? rawRepository.id : "";
          const repositoryRoot = typeof rawRepository.root === "string" ? rawRepository.root : "";
          if (!repositoryId || repositoryIds.has(repositoryId))
            issues.push(planningStoreError("planningStore.repositoryId", `${label}.id must be unique and non-empty`));
          if (!repositoryRoot)
            issues.push(planningStoreError("planningStore.repositoryRoot", `${label}.root must be non-empty`));
          repositoryIds.add(repositoryId);
          if (repositoryId && repositoryRoot) repositories.push({ id: repositoryId, root: repositoryRoot });
        });
      const worksets: PlanningStoreWorkset[] = [];
      const worksetIds = new Set<string>();
      if (!Array.isArray(rawStore.worksets))
        issues.push(planningStoreError("planningStore.worksets", `${storeLabel}.worksets must be an array`));
      if (Array.isArray(rawStore.worksets))
        rawStore.worksets.forEach((rawWorkset, worksetIndex) => {
          const label = `${storeLabel}.worksets[${worksetIndex}]`;
          if (!isObjectRecord(rawWorkset)) {
            issues.push(planningStoreError("planningStore.workset", `${label} must be an object`));
            return;
          }
          issues.push(...unknownKeys(rawWorkset, planningStoreWorksetKeys, label));
          const worksetId = typeof rawWorkset.id === "string" ? rawWorkset.id : "";
          const worksetRepositories =
            Array.isArray(rawWorkset.repositories) && rawWorkset.repositories.every((item) => typeof item === "string")
              ? (rawWorkset.repositories as string[])
              : [];
          if (!worksetId || worksetIds.has(worksetId))
            issues.push(planningStoreError("planningStore.worksetId", `${label}.id must be unique and non-empty`));
          if (
            !Array.isArray(rawWorkset.repositories) ||
            !rawWorkset.repositories.every((item) => typeof item === "string")
          )
            issues.push(
              planningStoreError("planningStore.worksetRepositories", `${label}.repositories must be a string array`)
            );
          worksetRepositories
            .filter((repositoryId) => !repositoryIds.has(repositoryId))
            .forEach((repositoryId) =>
              issues.push(
                planningStoreError(
                  "planningStore.missingRepository",
                  `${label} references missing repository ${repositoryId}`
                )
              )
            );
          const sharedSpecs: PlanningStoreSharedSpec[] = [];
          if (!Array.isArray(rawWorkset.sharedSpecs))
            issues.push(planningStoreError("planningStore.sharedSpecs", `${label}.sharedSpecs must be an array`));
          if (Array.isArray(rawWorkset.sharedSpecs))
            rawWorkset.sharedSpecs.forEach((rawSpec, specIndex) => {
              const specLabel = `${label}.sharedSpecs[${specIndex}]`;
              if (!isObjectRecord(rawSpec)) {
                issues.push(planningStoreError("planningStore.sharedSpec", `${specLabel} must be an object`));
                return;
              }
              issues.push(...unknownKeys(rawSpec, planningStoreSharedSpecKeys, specLabel));
              const repositoryId = typeof rawSpec.repositoryId === "string" ? rawSpec.repositoryId : "";
              const specPath = typeof rawSpec.path === "string" ? rawSpec.path : "";
              const commit = typeof rawSpec.commit === "string" ? rawSpec.commit : "";
              const contentHash = typeof rawSpec.contentHash === "string" ? rawSpec.contentHash : "";
              const dependsOn =
                Array.isArray(rawSpec.dependsOn) && rawSpec.dependsOn.every((item) => typeof item === "string")
                  ? (rawSpec.dependsOn as string[])
                  : [];
              if (!repositoryIds.has(repositoryId))
                issues.push(
                  planningStoreError(
                    "planningStore.sharedSpecRepository",
                    `${specLabel}.repositoryId is not registered`
                  )
                );
              if (!safeStoreRelativePath(specPath))
                issues.push(
                  planningStoreError(
                    "planningStore.pathEscape",
                    `${specLabel}.path must remain inside its repository root`
                  )
                );
              if (!commit || !contentHash.startsWith("sha256:"))
                issues.push(
                  planningStoreError("planningStore.pin", `${specLabel} must pin commit and sha256 contentHash`)
                );
              if (Array.isArray(rawSpec.dependsOn) && !rawSpec.dependsOn.every((item) => typeof item === "string"))
                issues.push(
                  planningStoreError("planningStore.dependsOn", `${specLabel}.dependsOn must be a string array`)
                );
              if (repositoryId && specPath && commit && contentHash)
                sharedSpecs.push({ repositoryId, path: specPath, commit, contentHash, dependsOn });
            });
          worksetIds.add(worksetId);
          if (worksetId) worksets.push({ id: worksetId, repositories: worksetRepositories, sharedSpecs });
        });
      if (id && storeRoot) stores.push({ id, root: storeRoot, repositories, worksets });
    });
  return issues.length > 0 ? { issues } : { registry: { version: "1.0.0", stores }, issues: [] };
}

function storeGit(root: string): { trust: "trusted" | "dirty" | "missing" | "untrusted"; headCommit: string | null } {
  if (!existsSync(root)) return { trust: "missing", headCommit: null };
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return { trust: "untrusted", headCommit: null };
  const dirty = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  return {
    trust: dirty.status !== 0 ? "untrusted" : dirty.stdout.trim().length > 0 ? "dirty" : "trusted",
    headCommit: head.stdout.trim() || null
  };
}

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function planningStoreCycleKeys(workset: PlanningStoreWorkset): string[] {
  const keys = workset.sharedSpecs.map((spec) => `${spec.repositoryId}:${spec.path}`);
  const graph = new Map(keys.map((key) => [key, [] as string[]]));
  workset.sharedSpecs.forEach((spec) => graph.set(`${spec.repositoryId}:${spec.path}`, spec.dependsOn));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      cycles.add(key);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    graph
      .get(key)
      ?.filter((dependency) => graph.has(dependency))
      .forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  graph.forEach((_dependencies, key) => visit(key));
  return Array.from(cycles).sort();
}

export function runPlanningStoreList(root: string, registryPath: string, options: { json?: boolean } = {}): number {
  const result = readPlanningStoreRegistry(root, registryPath);
  if (!result.registry) {
    result.issues.forEach((issue) => console.error(`ERROR ${issue.code}: ${issue.message}`));
    return 1;
  }
  const registryAbsolute = resolveFrom(root, registryPath);
  const report: PlanningStoreListReport = {
    version: "scwbs.planning-store-list.v1",
    registryPath: registryAbsolute,
    stores: result.registry.stores.map((store) => ({
      id: store.id,
      root: path.resolve(path.dirname(registryAbsolute), store.root),
      repositoryIds: store.repositories.map((repository) => repository.id).sort(),
      worksetIds: store.worksets.map((workset) => workset.id).sort()
    })),
    authority: "read-only-advisory"
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else report.stores.forEach((store) => console.log(`${store.id}: ${store.root}`));
  return 0;
}

export function runPlanningStoreShow(
  root: string,
  registryPath: string,
  storeId: string,
  options: { json?: boolean } = {}
): number {
  const result = readPlanningStoreRegistry(root, registryPath);
  const store = result.registry?.stores.find((candidate) => candidate.id === storeId);
  if (!result.registry || !store) {
    [
      ...result.issues,
      ...(result.registry ? [planningStoreError("planningStore.missing", `Store ${storeId} does not exist`)] : [])
    ].forEach((issue) => console.error(`ERROR ${issue.code}: ${issue.message}`));
    return 1;
  }
  const registryAbsolute = resolveFrom(root, registryPath);
  const storeRoot = path.resolve(path.dirname(registryAbsolute), store.root);
  const repositories = store.repositories.map((repository) => {
    const repositoryRoot = path.resolve(storeRoot, repository.root);
    const git = storeGit(repositoryRoot);
    return {
      id: repository.id,
      root: repositoryRoot,
      trust: git.trust,
      headCommit: git.headCommit,
      taskIndex: existsSync(path.join(repositoryRoot, "contracts/tasks/index.yaml"))
        ? ("available" as const)
        : ("missing" as const),
      evidence: existsSync(path.join(repositoryRoot, "contracts/evidence"))
        ? ("available" as const)
        : ("missing" as const),
      ci: "repository-local-only" as const
    };
  });
  const repositoryById = new Map(repositories.map((repository) => [repository.id, repository]));
  const sharedSpecs = store.worksets.flatMap((workset) =>
    workset.sharedSpecs.map((spec) => {
      const repository = repositoryById.get(spec.repositoryId);
      const repositoryRoot = repository?.root ?? path.resolve(storeRoot, "missing-repository");
      const pathEscapes =
        !safeStoreRelativePath(spec.path) ||
        path.relative(repositoryRoot, path.resolve(repositoryRoot, spec.path)).startsWith("..");
      if (pathEscapes || !repository)
        return {
          repositoryId: spec.repositoryId,
          path: spec.path,
          pinnedCommit: spec.commit,
          expectedContentHash: spec.contentHash,
          currentHeadCommit: repository?.headCommit ?? null,
          currentContentHash: null,
          status: "blocked" as const
        };
      const current = spawnSync("git", ["-C", repositoryRoot, "show", `${spec.commit}:${spec.path}`], {
        encoding: "buffer"
      });
      const currentHash = current.status === 0 ? sha256(current.stdout) : null;
      const stale = repository.headCommit !== spec.commit || currentHash !== spec.contentHash;
      return {
        repositoryId: spec.repositoryId,
        path: spec.path,
        pinnedCommit: spec.commit,
        expectedContentHash: spec.contentHash,
        currentHeadCommit: repository.headCommit,
        currentContentHash: currentHash,
        status: current.status !== 0 ? ("blocked" as const) : stale ? ("stale" as const) : ("ready" as const)
      };
    })
  );
  const cycles = Array.from(new Set(store.worksets.flatMap(planningStoreCycleKeys))).sort();
  const pathEscapes = sharedSpecs
    .filter((spec) => spec.status === "blocked")
    .filter((spec) => !safeStoreRelativePath(spec.path))
    .map((spec) => `${spec.repositoryId}:${spec.path}`);
  const authorityDowngrades: string[] = [];
  const blocked =
    repositories.some((repository) => repository.trust !== "trusted") ||
    sharedSpecs.some((spec) => spec.status === "blocked") ||
    cycles.length > 0;
  const stale = sharedSpecs.some((spec) => spec.status === "stale");
  const status: PlanningStoreShowReport["status"] = blocked ? "blocked" : stale ? "stale" : "ready";
  const worksets = store.worksets.map((workset) => ({
    id: workset.id,
    repositories: workset.repositories.slice().sort(),
    status:
      cycles.length > 0
        ? ("blocked" as const)
        : sharedSpecs
              .filter((spec) =>
                workset.sharedSpecs.some(
                  (candidate) => candidate.repositoryId === spec.repositoryId && candidate.path === spec.path
                )
              )
              .some((spec) => spec.status === "stale")
          ? ("stale" as const)
          : ("ready" as const),
    taskEvidenceCi: "Task/Evidence/CI remain repository-local; this workset is correlation-only"
  }));
  const report: PlanningStoreShowReport = {
    version: "scwbs.planning-store-show.v1",
    status,
    store: { id: store.id, root: storeRoot, registryPath: registryAbsolute },
    repositories,
    worksets,
    sharedSpecs,
    review: { cycles, pathEscapes, authorityDowngrades },
    provenance: {
      storeId: store.id,
      storeRoot,
      referencedCommits: Array.from(new Set(sharedSpecs.map((spec) => spec.pinnedCommit))).sort(),
      contentHashes: Array.from(new Set(sharedSpecs.map((spec) => spec.expectedContentHash))).sort()
    },
    authority:
      "read-only-advisory; repository Task Contract, Evidence, Approval, Human Gate, and required checks remain authoritative",
    nextAction:
      status === "ready"
        ? "Use the shared Spec as advisory input only; create repository-local Task Contracts after normal review"
        : "Stop and refresh the store reference or repository trust state before relying on this proposal"
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} store ${report.store.id}\nroot: ${report.store.root}\nnext: ${report.nextAction}`);
  return status === "ready" ? 0 : 1;
}
