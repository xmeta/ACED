import path from "node:path";
import type { Profile } from "./types.js";

export const defaultWbsPath = "contracts/wbs/project.wbs.json";
export const defaultRegistryPath = "contracts/registry.yaml";
export const defaultSpecsDir = "contracts/specs";
export const defaultSpecChangesDir = "contracts/spec-changes";
export const defaultTasksDir = "contracts/tasks";
export const defaultEvidenceDir = "contracts/evidence";
export const defaultEvidencePayloadsDir = "contracts/evidence-payloads";
export const defaultApprovalsDir = "contracts/approvals";
export const defaultReviewsDir = "contracts/reviews";
export const defaultBlocksDir = "contracts/blocks";
export const defaultRisksDir = "contracts/risks";
export const defaultChangesetsDir = "contracts/changesets";
export const defaultCheckCoveragePath = "contracts/check-coverage.yaml";
export const taskIdPatternSource = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const taskIdPattern = new RegExp(taskIdPatternSource);

export function profileRequiredDirs(profile: Profile): string[] {
  const dirs: string[] = [
    defaultTasksDir,
    defaultEvidenceDir,
    defaultApprovalsDir,
    defaultChangesetsDir,
    "contracts/wbs",
  ];
  if (profile === "Standard" || profile === "Strict") {
    dirs.push(defaultReviewsDir);
  }
  if (profile === "Strict") {
    dirs.push(defaultSpecsDir, defaultSpecChangesDir);
  }
  return dirs;
}

export function resolveFrom(root: string, relativePath: string): string {
  return path.resolve(root, relativePath);
}

export function isValidTaskId(taskId: string): boolean {
  return taskIdPattern.test(taskId);
}

export function assertValidTaskId(taskId: string): void {
  if (!isValidTaskId(taskId)) {
    throw new Error("Invalid task id");
  }
}

function taskContractPath(directory: string, taskId: string): string {
  assertValidTaskId(taskId);
  const base = path.resolve("/", directory);
  const candidate = path.resolve(base, `${taskId}.yaml`);
  const relative = path.relative(base, candidate);
  const windowsBase = path.win32.resolve("C:\\", directory);
  const windowsCandidate = path.win32.resolve(windowsBase, `${taskId}.yaml`);
  const windowsRelative = path.win32.relative(windowsBase, windowsCandidate);
  if (
    relative.startsWith("..")
    || path.isAbsolute(relative)
    || windowsRelative.startsWith("..")
    || path.win32.isAbsolute(windowsRelative)
  ) {
    throw new Error("Invalid task id");
  }
  return `${directory}/${taskId}.yaml`;
}

export function taskPath(taskId: string): string {
  return taskContractPath(defaultTasksDir, taskId);
}

export function specPath(specId: string): string {
  return taskContractPath(defaultSpecsDir, specId);
}

export function specChangePath(specChangeId: string): string {
  return taskContractPath(defaultSpecChangesDir, specChangeId);
}

export function evidencePath(taskId: string): string {
  return taskContractPath(defaultEvidenceDir, taskId);
}

export function evidencePayloadPath(taskId: string): string {
  assertValidTaskId(taskId);
  return `${defaultEvidencePayloadsDir}/${taskId}.patch`;
}

export function approvalPath(taskId: string): string {
  return taskContractPath(defaultApprovalsDir, taskId);
}

export function reviewPath(taskId: string): string {
  return taskContractPath(defaultReviewsDir, taskId);
}

export function blockPath(taskId: string): string {
  return taskContractPath(defaultBlocksDir, taskId);
}
