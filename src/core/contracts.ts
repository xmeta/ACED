import { existsSync, readdirSync } from "node:fs";
import { readYamlFile } from "./yaml.js";
import { commitExists, isCommitAncestor } from "./git.js";
import { approvalPath, blockPath, defaultApprovalsDir, defaultBlocksDir, defaultEvidenceDir, defaultRegistryPath, defaultReviewsDir, defaultSpecChangesDir, defaultSpecsDir, defaultTasksDir, isValidTaskId, resolveFrom, reviewPath, taskPath, evidencePath } from "./paths.js";
import { asApprovalRecord, asBlockRecord, asEvidence, asRegistry, asReviewRecord, asSpecChangeProposal, asSpecContract, asTaskContract, validateApprovalRecord, validateApprovalRecordSchema, validateBlockRecord, validateBlockRecordSchema, validateEvidence, validateEvidenceSchema, validateRegistry, validateRegistrySchema, validateReviewRecord, validateReviewRecordSchema, validateSpecChangeProposal, validateSpecChangeProposalSchema, validateSpecContract, validateSpecContractSchema, validateTaskContract, validateTaskContractSchema } from "./schema.js";
import { activeTaskEntries, readTaskIndex } from "./task-index.js";
import type { ApprovalRecord, BlockRecord, Evidence, Issue, Registry, RegistryContract, RequirementEvidence, RequirementVerificationMode, ReviewRecord, SpecChangeProposal, SpecContract, SpecRequirement, TaskContract } from "./types.js";

export function readRegistry(root: string): { registry?: Registry; issues: Issue[] } {
  const fullPath = resolveFrom(root, defaultRegistryPath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "registry.missing", message: `${defaultRegistryPath} does not exist` }] };
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

export function readSpecChange(root: string, relativePath: string): { specChange?: SpecChangeProposal; issues: Issue[] } {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "specChange.missing", message: `${relativePath} does not exist` }] };
  }
  const value = readYamlFile<unknown>(fullPath);
  const issues = [...validateSpecChangeProposalSchema(value, relativePath), ...validateSpecChangeProposal(value, relativePath)];
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

export function listSpecChanges(root: string): Array<{ specChange?: SpecChangeProposal; issues: Issue[]; path: string }> {
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

export function matchingSpecContract(registry: Registry | undefined, task: TaskContract): RegistryContract | undefined {
  return registry?.contracts.find((contract) => {
    if (contract.type !== "spec") return false;
    return contract.relatedTask === task.id || contract.featureId === task.featureId;
  });
}

export function matchingRegistrySpecByPath(registry: Registry | undefined, specPath: string): RegistryContract | undefined {
  return registry?.contracts.find((contract) => contract.type === "spec" && contract.path === specPath);
}

export function matchingRegistrySpecChangeByPath(registry: Registry | undefined, specChangePath: string): RegistryContract | undefined {
  return registry?.contracts.find((contract) => contract.type === "spec-change" && contract.path === specChangePath);
}

export function readSpecFromRegistryContract(root: string, contract: RegistryContract): { spec?: SpecContract; path: string; issues: Issue[] } {
  const { spec, issues } = readSpec(root, contract.path);
  return { spec, path: contract.path, issues };
}

export function resolveSpecForTask(root: string, registry: Registry | undefined, task: TaskContract): { contract?: RegistryContract; spec?: SpecContract; path?: string; issues: Issue[] } {
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
    warnings: [`${spec.id} uses legacy acceptanceCriteria; add requirementsVersion: 1.0.0 and stable requirement IDs before feature validation can produce GO`]
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
  if (coverage.subjectHeadCommit !== evidence.subjectHeadCommit || coverage.diffHash !== evidence.diffHash || !coverage.subjectHeadCommit || !coverage.diffHash) {
    return { status: "stale", issues: ["Requirement Evidence provenance does not match Evidence subjectHeadCommit/diffHash"] };
  }
  if (!commitExists(root, coverage.subjectHeadCommit)) return { status: "stale", issues: ["Requirement Evidence subject HEAD does not exist"] };
  if (!isCommitAncestor(root, coverage.subjectHeadCommit, baseRef)) {
    return { status: "stale", issues: [`Requirement Evidence subject HEAD is not merged into ${baseRef}`] };
  }
  if (coverage.status === "not-covered") return { status: "not-covered", issues: ["Evidence explicitly marks the requirement as not-covered"] };
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
    : { status: "not-covered", issues: ["Automated Requirement needs covered status and current passed check references"] };
}

function printFeatureValidation(report: FeatureValidationReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Feature validation: ${report.status}\n`);
  report.requirements.forEach((requirement) => process.stdout.write(`- ${requirement.requirementId}: ${requirement.evidenceStatus}${requirement.issues.length > 0 ? ` (${requirement.issues.join("; ")})` : ""}\n`));
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
  const tasks = listTasks(root).flatMap((entry) => entry.task ? [entry.task] : []);
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
    if (owners.length !== 1) return { requirementId: requirement.id, statement: requirement.statement, verificationMode: requirement.verificationMode, taskIds, evidenceStatus: "not-covered", issues };
    const task = owners[0] as TaskContract;
    const taskStatus = statuses.get(task.id) ?? "planned";
    if (!["completed", "archived"].includes(taskStatus)) issues.push(`Task ${task.id} is ${taskStatus}, not completed or archived`);
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
  const manualVerifyRequired = requirements.filter((requirement) => requirement.evidenceStatus === "manual-required").length;
  const notCovered = requirements.filter((requirement) => !["covered", "manual-required"].includes(requirement.evidenceStatus)).length;
  const report: FeatureValidationReport = {
    version: "scwbs.feature-validation.v1",
    status: notCovered > 0 ? "NO-GO" : manualVerifyRequired > 0 ? "MANUAL_VERIFY_REQUIRED" : "GO",
    spec: { id: spec.id, version: spec.version, ...(spec.requirementsVersion ? { requirementsVersion: spec.requirementsVersion } : {}) },
    requirements,
    unknownRequirementDeclarations,
    warnings: [...normalized.warnings, ...unknownRequirementDeclarations.map((entry) => `Task ${entry.taskId} declares unknown Requirement IDs: ${entry.requirementIds.join(", ")}`)],
    summary: { total: requirements.length, covered: requirements.length - notCovered - manualVerifyRequired, notCovered, manualVerifyRequired }
  };
  if (unknownRequirementDeclarations.length > 0 && report.status === "GO") report.status = "NO-GO";
  printFeatureValidation(report, options.json ?? false);
  return report.status === "GO" ? 0 : report.status === "MANUAL_VERIFY_REQUIRED" ? 2 : 1;
}
