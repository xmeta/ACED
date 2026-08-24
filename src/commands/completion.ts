import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApprovalForScope, readEvidence, readReview, readTask } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { validateDelegatedApproval, validateHumanApprovalProvenance } from "../core/human-gate.js";
import { completionTaskIds, incompleteDependencies, isNodeCompletionTask, parseTaskIds } from "../core/node-utils.js";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import { readWbs } from "../core/wbs.js";
import type { ApprovalRecord, TaskContract, WbsDocument, WbsNode } from "../core/types.js";
import { missingTaskWbsNodeMessage, taskWbsAssociation } from "../core/task-wbs-policy.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { runWbsApply } from "./wbs.js";

type CompletionPlanItem = {
  taskId: string;
  node: WbsNode;
  pullRequest?: string;
  approval: ApprovalRecord;
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

    const targetAssociation = taskWbsAssociation(wbs, targetTask);
    if (targetAssociation.kind !== "node") {
      blockers.push(`${targetTask.id} references missing WBS node: ${targetAssociation.nodeId}`);
      continue;
    }
    const targetNode = targetAssociation.node;
    if (targetNode.id !== task.wbsNodeId) {
      blockers.push(`${targetTask.id} targets WBS node ${targetNode.id}, not ${task.wbsNodeId}`);
      continue;
    }

    const { evidence, issues: evidenceIssues } = readEvidence(root, targetTask.id);
    const { approval, issues: approvalIssues } = readApprovalForScope(root, targetTask.id, "post-finish");
    const { review, issues: reviewIssues } = readReview(root, targetTask.id);
    const missingEvidenceOnly = evidenceIssues.length === 1 && evidenceIssues[0]?.code === "evidence.missing";
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    const missingReviewOnly = reviewIssues.length === 1 && reviewIssues[0]?.code === "review.missing";
    const hasEvidence = Boolean(evidence) && !missingEvidenceOnly;
    const hasApproval = Boolean(approval) && !missingApprovalOnly;
    const hasReview = Boolean(review) && !missingReviewOnly;
    const pullRequest = evidence?.git?.pullRequest ?? approval?.pullRequest;
    const touchesHumanGate = evidence?.changedFiles.some((file) => matchesAny(file, targetTask.humanGateRequiredPaths)) ?? false;

    if (!hasEvidence) blockers.push(`${targetTask.id} is missing evidence`);
    if (!pullRequest) blockers.push(`${targetTask.id} is missing pull request metadata`);
    if (!hasReview) blockers.push(`${targetTask.id} is missing review metadata`);
    if (!hasApproval && touchesHumanGate) {
      const scopeMessage = approvalIssues.map((issue) => issue.message).join("; ") || `${targetTask.id} has no post-finish Approval record`;
      blockers.push(`${targetTask.id} post-finish Approval unavailable: ${scopeMessage}`);
    }
    if (approval?.status === "requested") {
      blockers.push(`${targetTask.id} post-finish Approval is still requested`);
    } else if (approval?.status === "rejected") {
      blockers.push(`${targetTask.id} post-finish Approval was rejected`);
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
    const association = taskWbsAssociation(wbs, task);
    if (association.kind === "wbs-less") throw new Error(`${task.id} is WBS-less and cannot complete a WBS node; assign an explicit --wbs-node in a new trusted contract before completion`);
    if (association.kind === "missing-node") throw new Error(missingTaskWbsNodeMessage(task, association));
    const node = association.node;
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

    const { approval, issues: approvalIssues } = readApprovalForScope(root, task.id, "post-finish");
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    if (missingApprovalOnly || !approval) {
      const scopeMessage = approvalIssues.map((issue) => issue.message).join("; ");
      throw new Error(scopeMessage || `${task.id} has no post-finish Approval record; run \`scwbs approval approve --task ${task.id} --scope post-finish\` first`);
    }
    if (approval.status === "requested") throw new Error(`${task.id} post-finish Approval is still requested; approve it first`);
    if (approval.status === "rejected") throw new Error(`${task.id} post-finish Approval is rejected`);
    if (approval.status !== "approved") throw new Error(`${task.id} post-finish Approval status is ${approval.status}; only approved records can complete`);

    if (approval.approvalMode === "delegated") {
      const delegationIssues = validateDelegatedApproval(task, approval, "post-finish");
      if (delegationIssues.length > 0) throw new Error(delegationIssues.map((issue) => issue.message).join("\n"));
    } else if (approval.version === "scwbs.approval.v2") {
      const humanProvenanceIssues = validateHumanApprovalProvenance(approval, true, true);
      if (humanProvenanceIssues.length > 0) throw new Error(humanProvenanceIssues.map((issue) => issue.message).join("\n"));
    }

    const evidenceHeadCommit = evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit ?? evidence.subjectHeadCommit;
    const evidenceDiffHash = evidence.git?.diffHash ?? evidence.diffHash;
    if (approval.approvalMode === "delegated" && (!approval.headCommit || !approval.diffHash || !evidenceHeadCommit || !evidenceDiffHash)) {
      throw new Error(`${task.id} delegated approval and Evidence require headCommit and diffHash`);
    }
    if (approval.headCommit !== undefined && evidenceHeadCommit !== undefined && approval.headCommit !== evidenceHeadCommit) {
      throw new Error(`${task.id} approval headCommit does not match Evidence`);
    }
    if (approval.diffHash !== undefined && evidenceDiffHash !== undefined && approval.diffHash !== evidenceDiffHash) {
      throw new Error(`${task.id} approval diffHash does not match Evidence`);
    }

    const pullRequest = evidence.git?.pullRequest ?? approval.pullRequest;
    if (!pullRequest) throw new Error(`${task.id} has no pull request metadata in Evidence or Approval`);
    if (approval.version === "scwbs.approval.v2") {
      if (!evidence.git?.pullRequest) throw new Error(`${task.id} post-finish Approval requires Evidence pull request metadata`);
      if (approval.pullRequest !== evidence.git.pullRequest) throw new Error(`${task.id} post-finish Approval pull request does not match Evidence`);
    }

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
      approval,
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
    lines.push("  approval: approved record validated");
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
  lines.push("rerun with --apply to apply the WBS changeset and rebuild the registry");
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
