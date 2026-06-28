import { writeFileSync } from "node:fs";
import { readTask } from "../core/contracts.js";
import { taskPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { buildLockedTask } from "./task-lock.js";

export function buildTaskRefreshPreview(root: string, taskId: string): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const refreshed = buildLockedTask(root, taskId);
  const lines = ["Task Contract refresh preview:", "", "Safe updates:"];
  const oldLock = task.contractLock ?? {};
  const newLock = refreshed.contractLock ?? {};
  for (const key of ["wbsRevision", "wbsNodeId", "specVersion", "specRevision", "createdAt"] as const) {
    if (oldLock[key] !== newLock[key]) lines.push(`- contractLock.${key}: ${oldLock[key] ?? "<missing>"} -> ${newLock[key] ?? "<missing>"}`);
  }
  if (lines.length === 3) lines.push("- None");
  lines.push("");
  lines.push("Needs human decision:");
  lines.push("- allowedPaths, doneCriteria, requiredChecks, and humanGateRequiredPaths are not changed by refresh");
  return `${lines.join("\n")}\n`;
}

export function runTaskRefresh(root: string, taskId: string, options: { apply: boolean }): number {
  try {
    if (!options.apply) {
      process.stdout.write(buildTaskRefreshPreview(root, taskId));
      return 0;
    }
    const refreshed = buildLockedTask(root, taskId);
    writeFileSync(resolveFrom(root, taskPath(taskId)), stringifySimpleYaml(refreshed as unknown as Record<string, unknown>), "utf8");
    console.log(`refreshed ${taskPath(taskId)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
