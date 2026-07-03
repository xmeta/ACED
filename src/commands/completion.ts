import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApproval, readEvidence, readReview, readTask } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { approvalPath, defaultWbsPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";
import type { ApprovalRecord, TaskContract, WbsDocument, WbsNode } from "../core/types.js";
import { buildApprovalApprove } from "./approval-request.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { runWbsApply } from "./wbs.js";

type CompletionPlanItem = {
  taskId: string;
  node: WbsNode;
  pullRequest?: string;
  approval: ApprovalRecord;
  writesApproval: boolean;
  completionTargets?: Array<{
    taskId: string;
    nodeCode: string;
    nodeName: string;
    pullRequest?: string;
    approvalStatus?: string;
    reviewStatus?: string;
  }>;
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

function completionTaskIds(task: TaskContract): string[] {
  return [...new Set(task.completionTaskIds ?? [])];
}

function isNodeCompletionTask(task: TaskContract): boolean {
  return task.completionScope === "node" && completionTaskIds(task).length > 0;
}

function approvalFor(taskId: string, pullRequest: string | undefined, reason: string, existing: ApprovalRecord | undefined): CompletionPlanItem["approval"] {
  if (existing?.status === "approved") return existing;
  return buildApprovalApprove(taskId, { pullRequest, reason, approvedBy: "human" });
}

function validateNodeCompletionTargets(root: string, wbs: WbsDocument, task: TaskContract): { blockers: string[]; targets: NonNullable<CompletionPlanItem["completionTargets"]> } {
  const blockers: string[] = [];
  const targets: NonNullable<CompletionPlanItem["completionTargets"]> = [];
  const seen = new Set<string>();

  for (const targetId of completionTaskIds(task)) {
    if (targetId === task.id) {
      blockers.push(`${task.id} completionTaskIds must not include itself`);
      continue;
    }
    if (seen.has(targetId)) continue;
    seen.add(targetId);

    const { task: targetTask, issues: targetTaskIssues } = readTask(root, targetId);
    if (!targetTask) {
      blockers.push(targetTaskIssues.map((issue) => issue.message).join("\n"));
      continue;
    }

    const targetNode = findNode(wbs, targetTask.wbsNodeId);
    if (!targetNode) {
      blockers.push(`${targetTask.id} references missing WBS node: ${targetTask.wbsNodeId}`);
      continue;
    }
    if (targetNode.id !== task.wbsNodeId) {
      blockers.push(`${targetTask.id} targets WBS node ${targetNode.id}, not ${task.wbsNodeId}`);
      continue;
    }

    const { evidence, issues: evidenceIssues } = readEvidence(root, targetTask.id);
    const { approval, issues: approvalIssues } = readApproval(root, targetTask.id);
    const { review, issues: reviewIssues } = readReview(root, targetTask.id);
    const missingEvidenceOnly = evidenceIssues.length === 1 && evidenceIssues[0]?.code === "evidence.missing";
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    const missingReviewOnly = reviewIssues.length === 1 && reviewIssues[0]?.code === "review.missing";
    const hasEvidence = Boolean(evidence) && !missingEvidenceOnly;
    const hasApproval = Boolean(approval) && !missingApprovalOnly;
    const hasReview = Boolean(review) && !missingReviewOnly;
    const pullRequest = evidence?.git?.pullRequest ?? approval?.pullRequest;

    if (!hasEvidence) blockers.push(`${targetTask.id} is missing evidence`);
    if (!pullRequest) blockers.push(`${targetTask.id} is missing pull request metadata`);
    if (!hasReview) blockers.push(`${targetTask.id} is missing review metadata`);
    const touchesHumanGate = evidence?.changedFiles.some((file) => matchesAny(file, targetTask.humanGateRequiredPaths)) ?? false;
    if (touchesHumanGate && !hasApproval) {
      blockers.push(`${targetTask.id} changed human gate paths but no approved approval record exists`);
    }
    if (approval?.status === "requested") {
      blockers.push(`${targetTask.id} approval is still requested`);
    } else if (approval?.status === "rejected") {
      blockers.push(`${targetTask.id} approval was rejected`);
    }

    targets.push({
      taskId: targetTask.id,
      nodeCode: targetNode.code,
      nodeName: targetNode.name,
      pullRequest,
      approvalStatus: approval?.status,
      reviewStatus: review?.status
    });
  }

  return { blockers, targets };
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

    const { review, issues: reviewIssues } = readReview(root, task.id);
    const missingReviewOnly = reviewIssues.length === 1 && reviewIssues[0]?.code === "review.missing";
    if (isNodeCompletionTask(task) && !review && !missingReviewOnly) {
      throw new Error(reviewIssues.map((issue) => issue.message).join("\n"));
    }
    if (isNodeCompletionTask(task) && !review) {
      throw new Error(`${task.id} is a node-level completion task and requires review metadata before completion`);
    }

    const completionTargets = isNodeCompletionTask(task) ? validateNodeCompletionTargets(root, wbs, task) : { blockers: [], targets: [] };
    if (isNodeCompletionTask(task) && completionTargets.blockers.length > 0) {
      throw new Error(`${task.id} cannot complete shared WBS node ${node.id} until:\n- ${completionTargets.blockers.join("\n- ")}`);
    }

    items.push({
      taskId: task.id,
      node,
      pullRequest,
      approval: approvalFor(task.id, pullRequest, reason, approval),
      writesApproval: approval?.status !== "approved",
      completionTargets: completionTargets.targets
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
    if (item.completionTargets && item.completionTargets.length > 0) {
      lines.push("  completionTargets:");
      for (const target of item.completionTargets) {
        const details = [
          target.pullRequest ? `PR ${target.pullRequest}` : "no PR",
          target.reviewStatus ? `review ${target.reviewStatus}` : "no review",
          target.approvalStatus ? `approval ${target.approvalStatus}` : "no approval"
        ].join(", ");
        lines.push(`    - ${target.taskId}: ${target.nodeCode} ${target.nodeName} (${details})`);
      }
    }
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

    const applyResult = runWbsApply(root, changeSetPath, { force: true, output: defaultWbsPath });
    if (applyResult !== 0) return applyResult;
    return runRegistryRebuild(root, { check: false, force: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
