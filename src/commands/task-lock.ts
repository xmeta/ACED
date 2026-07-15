import { writeFileSync } from "node:fs";
import { fileSha256 } from "../core/hash.js";
import { resolveFrom, taskPath } from "../core/paths.js";
import { readRegistry, readTask, resolveSpecForTask } from "../core/contracts.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { isWbsLessTask } from "../core/node-utils.js";
import type { TaskContract } from "../core/types.js";
import { readWbs } from "../core/wbs.js";
import { wbsGlobalRevision, wbsScopeRevision } from "../core/wbs-lock.js";

export function buildLockedTask(root: string, taskId: string, createdAt = new Date()): TaskContract {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }

  const { registry } = readRegistry(root);
  const { spec, path: specPath } = resolveSpecForTask(root, registry, task);
  const wbs = readWbs(root);
  return {
    ...task,
    contractLock: {
      lockVersion: "2",
      ...(!isWbsLessTask(task) ? { wbsScopeRevision: wbsScopeRevision(wbs, task.wbsNodeId) } : {}),
      wbsGlobalRevision: wbsGlobalRevision(wbs),
      wbsNodeId: task.wbsNodeId,
      ...(spec?.version && specPath ? { specVersion: spec.version, specRevision: fileSha256(root, specPath) } : {}),
      createdAt: createdAt.toISOString()
    }
  };
}

export function buildLockedTaskYaml(root: string, taskId: string, createdAt?: Date): string {
  return stringifySimpleYaml(buildLockedTask(root, taskId, createdAt) as unknown as Record<string, unknown>);
}

export function runTaskLock(root: string, taskId: string): number {
  try {
    const yaml = buildLockedTaskYaml(root, taskId);
    writeFileSync(resolveFrom(root, taskPath(taskId)), yaml, "utf8");
    console.log(`locked ${taskPath(taskId)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
