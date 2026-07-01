import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { approvalPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";
import type { ApprovalRecord, WbsDocument, WbsNode } from "../core/types.js";
import { buildApprovalApprove } from "./approval-request.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { runWbsApply } from "./wbs.js";

type CompletionPlanItem = {
  taskId: string;
  node: WbsNode;
  pullRequest?: string;
  approval: ApprovalRecord;
  writesApproval: boolean;
};

type CompletionChangeSet = {
  schemaVersion: "0.1.0";
  targetWbsId: string;
  changeSetId: string;
  author: string;
  reason: string;
  dryRun: false;
  operations: Array<{
    operationId: string;
    operation: "changeNodeStatus";
    nodeId: string;
    status: "completed";
  }>;
};

function incompleteDependencies(nodeId: string, wbs: WbsDocument): string[] {
  const nodesById = new Map(wbs.nodes.map((node) => [node.id, node]));
  return (wbs.relations ?? [])
    .filter((relation) => relation.type === "dependsOn" && relation.source === nodeId)
    .flatMap((relation) => {
      const node = nodesById.get(relation.target);
      if (!node || isDoneNode(node)) return [];
      return [`${node.code} ${node.name}`];
    });
}

function parseTaskIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function approvalFor(taskId: string, pullRequest: string | undefined, reason: string, existing: ApprovalRecord | undefined): CompletionPlanItem["approval"] {
  if (existing?.status === "approved") return existing;
  return buildApprovalApprove(taskId, { pullRequest, reason, approvedBy: "human" });
}

function buildCompletionChangeSet(wbs: WbsDocument, completionTaskId: string, reason: string, items: CompletionPlanItem[]): CompletionChangeSet {
  return {
    schemaVersion: "0.1.0",
    targetWbsId: wbs.id,
    changeSetId: `changeset-${completionTaskId}-complete-reviewed-work`,
    author: "human",
    reason,
    dryRun: false,
    operations: items.map((item, index) => ({
      operationId: `op-${String(index + 1).padStart(3, "0")}`,
      operation: "changeNodeStatus",
      nodeId: item.node.id,
      status: "completed"
    }))
  };
}

export function buildCompletionPlan(root: string, taskIdsValue: string | undefined, options: { reason?: string; allowRoot: boolean }): { wbs: WbsDocument; items: CompletionPlanItem[]; reason: string } {
  const taskIds = parseTaskIds(taskIdsValue);
  if (taskIds.length === 0) throw new Error("Missing --tasks <task-id[,task-id...]>");

  const wbs = readWbs(root);
  const reason = options.reason ?? "Human approved completion through scwbs completion apply";
  const seenNodes = new Set<string>();
  const items: CompletionPlanItem[] = [];

  for (const taskId of taskIds) {
    const { task, issues: taskIssues } = readTask(root, taskId);
    if (!task) throw new Error(taskIssues.map((issue) => issue.message).join("\n"));

    const node = findNode(wbs, task.wbsNodeId);
    if (!node) throw new Error(`${task.id} references missing WBS node: ${task.wbsNodeId}`);
    if (!options.allowRoot && (node.id === wbs.rootId || node.parentId === null)) {
      throw new Error(`${task.id} targets root WBS node ${node.id}; rerun with --allow-root only after explicit human decision`);
    }
    if (node.status !== "ready") {
      throw new Error(`${task.id} targets WBS node ${node.id} with status ${node.status ?? "planned"}; completion apply only handles ready nodes`);
    }
    if (seenNodes.has(node.id)) {
      throw new Error(`multiple tasks target WBS node ${node.id}; complete it through one reviewed task`);
    }
    seenNodes.add(node.id);

    const blockers = incompleteDependencies(node.id, wbs);
    if (blockers.length > 0) {
      throw new Error(`${task.id} has incomplete dependencies: ${blockers.join(", ")}`);
    }

    const { evidence, issues: evidenceIssues } = readEvidence(root, task.id);
    if (!evidence) throw new Error(evidenceIssues.map((issue) => issue.message).join("\n"));

    const { approval, issues: approvalIssues } = readApproval(root, task.id);
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    if (!missingApprovalOnly && !approval) throw new Error(approvalIssues.map((issue) => issue.message).join("\n"));
    if (approval?.status === "rejected") throw new Error(`${approvalPath(task.id)} is rejected`);

    const pullRequest = evidence.git?.pullRequest ?? approval?.pullRequest;
    if (!pullRequest) throw new Error(`${task.id} has no pull request metadata in Evidence or Approval`);
    items.push({
      taskId: task.id,
      node,
      pullRequest,
      approval: approvalFor(task.id, pullRequest, reason, approval),
      writesApproval: approval?.status !== "approved"
    });
  }

  return { wbs, items, reason };
}

export function buildCompletionPreview(root: string, taskIdsValue: string | undefined, completionTaskId: string, options: { reason?: string; allowRoot: boolean }): string {
  const { wbs, items, reason } = buildCompletionPlan(root, taskIdsValue, options);
  const changeSet = buildCompletionChangeSet(wbs, completionTaskId, reason, items);
  const lines = ["Completion apply dry-run:", ""];
  for (const item of items) {
    lines.push(`- ${item.taskId}: ${item.node.code} ${item.node.name} -> completed`);
    lines.push(`  pullRequest: ${item.pullRequest}`);
    lines.push(`  approval: ${item.writesApproval ? "will write approved record" : "already approved"}`);
  }
  lines.push("");
  lines.push(`changeset: contracts/changesets/${completionTaskId}-complete-reviewed-work.json`);
  lines.push(`operations: ${changeSet.operations.length}`);
  lines.push("rerun with --apply to write approvals, apply the WBS changeset, and rebuild the registry");
  return `${lines.join("\n")}\n`;
}

export function runCompletionApply(root: string, taskIdsValue: string | undefined, completionTaskId: string | undefined, options: { reason?: string; apply: boolean; allowRoot: boolean }): number {
  try {
    if (!completionTaskId) {
      console.error("Missing --task <completion-task-id>");
      return 2;
    }
    const plan = buildCompletionPlan(root, taskIdsValue, options);
    if (!options.apply) {
      process.stdout.write(buildCompletionPreview(root, taskIdsValue, completionTaskId, options));
      return 0;
    }

    for (const item of plan.items) {
      if (!item.writesApproval) continue;
      const relativePath = approvalPath(item.taskId);
      const fullPath = resolveFrom(root, relativePath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, stringifySimpleYaml(item.approval as unknown as Record<string, unknown>), "utf8");
      console.log(`wrote ${relativePath}`);
    }

    const changeSetPath = `contracts/changesets/${completionTaskId}-complete-reviewed-work.json`;
    const changeSet = buildCompletionChangeSet(plan.wbs, completionTaskId, plan.reason, plan.items);
    mkdirSync(path.dirname(resolveFrom(root, changeSetPath)), { recursive: true });
    writeFileSync(resolveFrom(root, changeSetPath), `${JSON.stringify(changeSet, null, 2)}\n`, "utf8");
    console.log(`wrote ${changeSetPath}`);

    const applyResult = runWbsApply(root, changeSetPath, { force: true });
    if (applyResult !== 0) return applyResult;
    return runRegistryRebuild(root, { check: false, force: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
