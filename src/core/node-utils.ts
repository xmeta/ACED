import type { TaskContract, WbsDocument } from "./types.js";
import { findNode, isDoneNode } from "./wbs.js";

export const WBS_LESS_TASK_NODE_ID = "wbs-less";

export function isWbsLessTask(task: TaskContract): boolean {
  return task.wbsNodeId === WBS_LESS_TASK_NODE_ID;
}

export function completionTaskIds(task: TaskContract): string[] {
  return [...new Set(task.completionTaskIds ?? [])];
}

export function isNodeCompletionTask(task: TaskContract): boolean {
  return task.completionScope === "node" && completionTaskIds(task).length > 0;
}

export function incompleteDependencies(nodeId: string, wbs: WbsDocument): string[] {
  const nodesById = new Map(wbs.nodes.map((node) => [node.id, node]));
  return (wbs.relations ?? [])
    .filter((relation) => relation.type === "dependsOn" && relation.source === nodeId)
    .flatMap((relation) => {
      const node = nodesById.get(relation.target);
      if (!node || isDoneNode(node)) return [];
      return [`${node.code} ${node.name}`];
    });
}

export function parseTaskIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
