import path from "node:path";

export const defaultWbsPath = "contracts/wbs/project.wbs.json";
export const defaultRegistryPath = "contracts/registry.yaml";
export const defaultSpecsDir = "contracts/specs";
export const defaultTasksDir = "contracts/tasks";
export const defaultEvidenceDir = "contracts/evidence";
export const defaultApprovalsDir = "contracts/approvals";

export function resolveFrom(root: string, relativePath: string): string {
  return path.resolve(root, relativePath);
}

export function taskPath(taskId: string): string {
  return `${defaultTasksDir}/${taskId}.yaml`;
}

export function specPath(specId: string): string {
  return `${defaultSpecsDir}/${specId}.yaml`;
}

export function evidencePath(taskId: string): string {
  return `${defaultEvidenceDir}/${taskId}.yaml`;
}

export function approvalPath(taskId: string): string {
  return `${defaultApprovalsDir}/${taskId}.yaml`;
}
