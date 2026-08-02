import { readApproval, readEvidence, readRegistry, readReview, readTask, resolveSpecForTask } from "../core/contracts.js";
import { readWbs } from "../core/wbs.js";
import { taskWbsAssociation } from "../core/task-wbs-policy.js";

export function buildTrace(root: string, taskId: string): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const wbs = readWbs(root);
  const association = taskWbsAssociation(wbs, task);
  const { registry } = readRegistry(root);
  const { spec } = resolveSpecForTask(root, registry, task);
  const { evidence } = readEvidence(root, task.id);
  const { review } = readReview(root, task.id);
  const { approval } = readApproval(root, task.id);
  return `Trace ${task.id}

Spec: ${spec ? `${spec.id} v${spec.version} ${spec.status}` : "missing"}
  -> WBS node: ${association.kind === "node" ? `${association.node.code} ${association.node.name} (${association.node.status ?? "planned"})` : association.kind === "wbs-less" ? "WBS-less" : `missing ${association.nodeId}`}
  -> Task: ${task.id}${task.mode ? ` (${task.mode})` : ""}
  -> Evidence: ${evidence ? `${evidence.id} (${evidence.checks.length} checks)` : "missing"}
  -> Review: ${review ? `${review.id} ${review.status}` : "missing"}
  -> Approval: ${approval ? `${approval.id} ${approval.status}` : "missing"}
`;
}

export function runTrace(root: string, taskId: string): number {
  try {
    process.stdout.write(buildTrace(root, taskId));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
