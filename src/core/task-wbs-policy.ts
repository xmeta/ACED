import type { TaskContract, WbsDocument, WbsNode } from "./types.js";
import { WBS_LESS_TASK_NODE_ID } from "./node-utils.js";
import { findNode } from "./wbs.js";

export type TaskWbsAssociation =
  | { kind: "wbs-less"; nodeId: typeof WBS_LESS_TASK_NODE_ID }
  | { kind: "missing-node"; nodeId: string }
  | { kind: "node"; nodeId: string; node: WbsNode };

/**
 * Canonical read-only policy for deciding whether a Task participates in the
 * WBS and, when it does, resolving its node without silently treating a
 * missing node as WBS-less.
 */
export function taskWbsAssociation(wbs: WbsDocument, task: TaskContract): TaskWbsAssociation {
  if (task.wbsNodeId === WBS_LESS_TASK_NODE_ID) {
    return { kind: "wbs-less", nodeId: WBS_LESS_TASK_NODE_ID };
  }
  const node = findNode(wbs, task.wbsNodeId);
  return node ? { kind: "node", nodeId: task.wbsNodeId, node } : { kind: "missing-node", nodeId: task.wbsNodeId };
}

export function missingTaskWbsNodeMessage(
  task: TaskContract,
  association: Extract<TaskWbsAssociation, { kind: "missing-node" }>
): string {
  return `${task.id} references missing WBS node: ${association.nodeId}`;
}
