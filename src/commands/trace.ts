import { listRisks, readApproval, readEvidence, readRegistry, readReview, readTask, resolveSpecForTask } from "../core/contracts.js";
import { readWbs } from "../core/wbs.js";
import { summarizeRisk } from "../core/risk.js";
import { taskWbsAssociation } from "../core/task-wbs-policy.js";

export type TraceJsonNode = {
  id: string;
  kind: "spec" | "wbs" | "task" | "evidence" | "review" | "approval" | "risk" | "requirement";
  status: string;
  label?: string;
  code?: string;
};

export type TraceJsonOutput = {
  version: "scwbs.trace.v1";
  taskId: string;
  nodes: TraceJsonNode[];
  edges: Array<{ from: string; to: string; kind: string }>;
};

export function buildTraceJson(root: string, taskId: string): TraceJsonOutput {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const wbs = readWbs(root);
  const association = taskWbsAssociation(wbs, task);
  const { registry } = readRegistry(root);
  const { spec } = resolveSpecForTask(root, registry, task);
  const { evidence } = readEvidence(root, task.id);
  const { review } = readReview(root, task.id);
  const { approval } = readApproval(root, task.id);
  const nodes: TraceJsonNode[] = [];
  const edges: TraceJsonOutput["edges"] = [];
  const taskNodeId = `task:${task.id}`;
  nodes.push({ id: taskNodeId, kind: "task", status: "active", label: task.id });

  if (spec) {
    const id = `spec:${spec.id}`;
    nodes.push({ id, kind: "spec", status: spec.status, label: spec.id });
    edges.push({ from: id, to: taskNodeId, kind: "specifies" });
  }

  if (association.kind === "node") {
    const id = `wbs:${association.node.id}`;
    nodes.push({ id, kind: "wbs", status: association.node.status ?? "planned", code: association.node.code, label: association.node.name });
    edges.push({ from: id, to: taskNodeId, kind: "assigns" });
  } else {
    const id = `wbs:${task.wbsNodeId}`;
    nodes.push({ id, kind: "wbs", status: association.kind === "wbs-less" ? "wbs-less" : "missing", label: task.wbsNodeId });
    edges.push({ from: id, to: taskNodeId, kind: "assigns" });
  }

  const related = [
    { value: evidence, kind: "evidence" as const, relation: "supports", status: evidence ? `${evidence.checks.length}-checks` : "missing" },
    { value: review, kind: "review" as const, relation: "reviews", status: review?.status ?? "missing" },
    { value: approval, kind: "approval" as const, relation: "approves", status: approval?.status ?? "missing" }
  ];
  for (const item of related) {
    if (!item.value) continue;
    const id = `${item.kind}:${item.value.id}`;
    nodes.push({ id, kind: item.kind, status: item.status, label: item.value.id });
    edges.push({ from: taskNodeId, to: id, kind: item.relation });
  }
  const riskEntries = listRisks(root).filter((entry) => entry.risk && (
    entry.risk.scope.tasks.includes(task.id)
    || (spec !== undefined && entry.risk.scope.specs.includes(spec.id))
  ));
  for (const entry of riskEntries) {
    if (!entry.risk) continue;
    const risk = entry.risk;
    const riskNodeId = `risk:${risk.id}`;
    const summary = summarizeRisk(root, risk);
    nodes.push({ id: riskNodeId, kind: "risk", status: risk.status, label: risk.title, code: `${summary.level}:${summary.acceptanceStatus}` });
    edges.push({ from: taskNodeId, to: riskNodeId, kind: "risk" });
    if (spec && risk.scope.specs.includes(spec.id)) edges.push({ from: `spec:${spec.id}`, to: riskNodeId, kind: "risk" });
    for (const requirementId of risk.scope.requirements.slice(0, 50)) {
      const requirementNodeId = `requirement:${requirementId}`;
      if (!nodes.some((node) => node.id === requirementNodeId)) nodes.push({ id: requirementNodeId, kind: "requirement", status: "linked", label: requirementId });
      edges.push({ from: requirementNodeId, to: riskNodeId, kind: "risk" });
    }
    if (evidence) edges.push({ from: riskNodeId, to: `evidence:${evidence.id}`, kind: "evidences" });
    if (approval) edges.push({ from: riskNodeId, to: `approval:${approval.id}`, kind: "accepts" });
  }
  return { version: "scwbs.trace.v1", taskId: task.id, nodes, edges };
}

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

export function runTrace(root: string, taskId: string, options: { json?: boolean } = {}): number {
  try {
    if (options.json) process.stdout.write(`${JSON.stringify(buildTraceJson(root, taskId))}\n`);
    else process.stdout.write(buildTrace(root, taskId));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
