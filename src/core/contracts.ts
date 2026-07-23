import { existsSync, readdirSync } from "node:fs";
import { readYamlFile } from "./yaml.js";
import { approvalPath, blockPath, defaultApprovalsDir, defaultBlocksDir, defaultEvidenceDir, defaultRegistryPath, defaultReviewsDir, defaultSpecChangesDir, defaultSpecsDir, defaultTasksDir, isValidTaskId, resolveFrom, reviewPath, taskPath, evidencePath } from "./paths.js";
import { asApprovalRecord, asBlockRecord, asEvidence, asRegistry, asReviewRecord, asSpecChangeProposal, asSpecContract, asTaskContract, validateApprovalRecord, validateApprovalRecordSchema, validateBlockRecord, validateBlockRecordSchema, validateEvidence, validateEvidenceSchema, validateRegistry, validateRegistrySchema, validateReviewRecord, validateReviewRecordSchema, validateSpecChangeProposal, validateSpecChangeProposalSchema, validateSpecContract, validateSpecContractSchema, validateTaskContract, validateTaskContractSchema } from "./schema.js";
import { activeTaskEntries } from "./task-index.js";
import type { ApprovalRecord, BlockRecord, Evidence, Issue, Registry, RegistryContract, ReviewRecord, SpecChangeProposal, SpecContract, TaskContract } from "./types.js";

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
