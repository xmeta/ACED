import path from "node:path";
import type { Profile } from "./types.js";

export const defaultWbsPath = "contracts/wbs/project.wbs.json";
export const defaultRegistryPath = "contracts/registry.yaml";
export const defaultSpecsDir = "contracts/specs";
export const defaultSpecChangesDir = "contracts/spec-changes";
export const defaultTasksDir = "contracts/tasks";
export const defaultEvidenceDir = "contracts/evidence";
export const defaultApprovalsDir = "contracts/approvals";
export const defaultReviewsDir = "contracts/reviews";
export const defaultBlocksDir = "contracts/blocks";
export const defaultChangesetsDir = "contracts/changesets";
export const defaultCheckCoveragePath = "contracts/check-coverage.yaml";

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

export function taskPath(taskId: string): string {
  return `${defaultTasksDir}/${taskId}.yaml`;
}

export function specPath(specId: string): string {
  return `${defaultSpecsDir}/${specId}.yaml`;
}

export function specChangePath(specChangeId: string): string {
  return `${defaultSpecChangesDir}/${specChangeId}.yaml`;
}

export function evidencePath(taskId: string): string {
  return `${defaultEvidenceDir}/${taskId}.yaml`;
}

export function approvalPath(taskId: string): string {
  return `${defaultApprovalsDir}/${taskId}.yaml`;
}

export function reviewPath(taskId: string): string {
  return `${defaultReviewsDir}/${taskId}.yaml`;
}

export function blockPath(taskId: string): string {
  return `${defaultBlocksDir}/${taskId}.yaml`;
}
