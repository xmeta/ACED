import { writeFileSync } from "node:fs";
import { currentHead } from "../core/git.js";
import { resolveFrom, taskPath } from "../core/paths.js";
import { readRegistry, readTask } from "../core/contracts.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Registry, TaskContract } from "../core/types.js";

function matchingSpecVersion(registry: Registry | undefined, task: TaskContract): string | undefined {
  return registry?.contracts.find((contract) => {
    if (contract.type !== "spec") return false;
    return contract.relatedTask === task.id || contract.featureId === task.featureId;
  })?.version;
}

export function buildLockedTask(root: string, taskId: string, createdAt = new Date()): TaskContract {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }

  const head = currentHead(root);
  if (!head) {
    throw new Error("Cannot create contractLock because git HEAD is not available");
  }

  const { registry } = readRegistry(root);
  const specVersion = matchingSpecVersion(registry, task);
  return {
    ...task,
    contractLock: {
      wbsRevision: head,
      wbsNodeId: task.wbsNodeId,
      ...(specVersion ? { specVersion, specRevision: head } : {}),
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
