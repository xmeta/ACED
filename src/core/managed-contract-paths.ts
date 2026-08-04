import { matchesGlob } from "./glob.js";
import { evidencePayloadPath } from "./paths.js";
import type { TaskContract } from "./types.js";

const TASK_SCOPED_DIRECTORIES = new Set(["tasks", "evidence", "approvals", "reviews", "blocks"]);
const GLOB_OR_TRAVERSAL = /[*?]|[{}]|\[|\]|(^|\/)\.\.(\/|$)/;

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isKnownManagedContractPath(input: string): boolean {
  const path = normalizePath(input);
  if (path !== input || GLOB_OR_TRAVERSAL.test(path)) return false;
  if (path === "contracts/registry.yaml" || path === "contracts/tasks/index.yaml") return true;
  if (/^contracts\/changesets\/[^/]+\.json$/.test(path)) return true;
  if (/^contracts\/specs\/[^/]+\.yaml$/.test(path)) return true;
  if (/^contracts\/(?:tasks|evidence|approvals|reviews|blocks)\/[^/]+\.yaml$/.test(path)) return true;
  if (/^contracts\/evidence-payloads\/[^/]+\.patch$/.test(path)) return true;

  // Kept as a harmless legacy value: without a glob this matches only the
  // directory name itself and cannot exempt any generated Evidence file.
  return path === "contracts/evidence/";
}

export function isManagedContractPathForTask(input: string, taskId: string): boolean {
  if (!isKnownManagedContractPath(input)) return false;
  const path = normalizePath(input);
  if (path.startsWith("contracts/evidence-payloads/")) return path === evidencePayloadPath(taskId);
  const match = /^contracts\/([^/]+)\/([^/]+)\.yaml$/.exec(path);
  if (!match || !TASK_SCOPED_DIRECTORIES.has(match[1])) return true;
  return match[1] === "tasks" ? match[2] === taskId || match[2] === "index" : match[2] === taskId;
}

export function matchesManagedContractPath(task: TaskContract, file: string): boolean {
  return (task.managedContractPaths ?? []).some(
    (managedPath) => isManagedContractPathForTask(managedPath, task.id) && matchesGlob(file, managedPath)
  );
}

/**
 * Task-scoped metadata written after implementation is committed. These
 * exact paths may remain dirty while Evidence, Approval, Review, and Registry
 * converge; implementation and authority files are intentionally excluded.
 */
export function taskLifecycleMetadataPaths(taskId: string): string[] {
  return [
    `contracts/evidence/${taskId}.yaml`,
    evidencePayloadPath(taskId),
    `contracts/approvals/${taskId}.yaml`,
    `contracts/reviews/${taskId}.yaml`,
    "contracts/registry.yaml"
  ];
}

/**
 * Concrete trust-root and lifecycle paths that a newly created Task Contract
 * may need to write. Keep this separate from taskLifecycleMetadataPaths:
 * bootstrap authority includes the Task, optional SPEC, index, and Block,
 * while post-implementation diff calculations intentionally do not exclude
 * those files.
 */
export function taskBootstrapManagedContractPaths(taskId: string, options: { specId?: string } = {}): string[] {
  return [
    `contracts/tasks/${taskId}.yaml`,
    ...(options.specId ? [`contracts/specs/${options.specId}.yaml`] : []),
    "contracts/tasks/index.yaml",
    `contracts/blocks/${taskId}.yaml`,
    ...taskLifecycleMetadataPaths(taskId)
  ];
}
