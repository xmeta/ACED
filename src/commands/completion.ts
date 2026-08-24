import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApproval, readApprovalForScope, readEvidence, readReview, readTask } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { validateDelegatedApproval, validateHumanApprovalProvenance, validateHumanGateApproval } from "../core/human-gate.js";
import { completionTaskIds, incompleteDependencies, isNodeCompletionTask, parseTaskIds } from "../core/node-utils.js";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import { readWbs } from "../core/wbs.js";
import type { ApprovalRecord, Evidence, ReviewRecord, TaskContract, WbsDocument, WbsNode } from "../core/types.js";
import { missingTaskWbsNodeMessage, taskWbsAssociation } from "../core/task-wbs-policy.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { runWbsApply } from "./wbs.js";

type CompletionTarget = {
  taskId: string;
  nodeCode: string;
  nodeName: string;
  pullRequest?: string;
  approvalStatus?: string;
  reviewStatus?: string;
};

type CompletionPlanItem = {
  taskId: string;
  node: WbsNode;
  pullRequest?: string;
  approval?: ApprovalRecord;
  reviewRequired: boolean;
  completionTargets?: CompletionTarget[];
};

type CompletionBlocker = { taskId: string; message: string };

type CompletionPlan = {
  wbs: WbsDocument;
  items: CompletionPlanItem[];
  reason: string;
  blockers: CompletionBlocker[];
};

type EvaluatedTask = {
  task: TaskContract;
  evidence?: Evidence;
  review?: ReviewRecord;
  approval?: ApprovalRecord;
  pullRequest?: string;
  blockers: CompletionBlocker[];
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

function blocker(taskId: string, message: string): CompletionBlocker {
  return { taskId, message };
}

function issueCode(issues: Array<{ code: string }>, fallback: string): string {
  return issues[0]?.code ?? fallback;
}

function evidenceSubject(evidence: Evidence | undefined): { pullRequest?: string; headCommit?: string; diffHash?: string } {
  return {
    pullRequest: evidence?.git?.pullRequest,
    headCommit: evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit,
    diffHash: evidence?.diffHash ?? evidence?.git?.diffHash
  };
}

/** Evaluate Evidence, Review, post-finish Approval, then canonical Human Gate. */
function evaluateTask(root: string, task: TaskContract, requireReview: boolean): EvaluatedTask {
  const blockers: CompletionBlocker[] = [];
  const evidenceResult = readEvidence(root, task.id);
  const evidence = evidenceResult.evidence;
  if (!evidence) blockers.push(blocker(task.id, `Evidence unavailable (${issueCode(evidenceResult.issues, "evidence.invalid")})`));

  const reviewResult = requireReview ? readReview(root, task.id) : { review: undefined, issues: [] };
  const review = reviewResult.review;
  const subject = evidenceSubject(evidence);
  if (requireReview && !review) {
    blockers.push(blocker(task.id, `Review unavailable (${issueCode(reviewResult.issues, "review.invalid")})`));
  } else if (requireReview && review) {
    if (review.status !== "approved") blockers.push(blocker(task.id, `Review status is ${review.status}; approved is required`));
    if (review.taskId !== task.id) blockers.push(blocker(task.id, "Review taskId does not match Task"));
    if (!subject.pullRequest || !review.pullRequest || review.pullRequest !== subject.pullRequest) blockers.push(blocker(task.id, "Review pullRequest does not match Evidence"));
    if (!subject.headCommit || !review.headCommit || review.headCommit !== subject.headCommit) blockers.push(blocker(task.id, "Review headCommit does not match Evidence"));
    if (!subject.diffHash || !review.diffHash || review.diffHash !== subject.diffHash) blockers.push(blocker(task.id, "Review diffHash does not match Evidence"));
  }

  const postFinishResult = readApprovalForScope(root, task.id, "post-finish");
  const approval = postFinishResult.approval;
  if (!approval) {
    blockers.push(blocker(task.id, `post-finish Approval unavailable (${issueCode(postFinishResult.issues, "approval.invalid")})`));
  } else {
    if (approval.status !== "approved") blockers.push(blocker(task.id, `post-finish Approval status is ${approval.status}; approved is required`));
    if (approval.approvalMode === "delegated") blockers.push(...validateDelegatedApproval(task, approval, "post-finish").map((issue) => blocker(task.id, `post-finish Approval invalid (${issue.code})`)));
    else if (approval.version === "scwbs.approval.v2") blockers.push(...validateHumanApprovalProvenance(approval, true, true).map((issue) => blocker(task.id, `post-finish Approval invalid (${issue.code})`)));
    if (!subject.pullRequest || !approval.pullRequest || approval.pullRequest !== subject.pullRequest) blockers.push(blocker(task.id, "post-finish Approval pullRequest does not match Evidence"));
    if (!subject.headCommit || !approval.headCommit || approval.headCommit !== subject.headCommit) blockers.push(blocker(task.id, "post-finish Approval headCommit does not match Evidence"));
    if (!subject.diffHash || !approval.diffHash || approval.diffHash !== subject.diffHash) blockers.push(blocker(task.id, "post-finish Approval diffHash does not match Evidence"));
  }

  const changedFiles = evidence?.changedFiles ?? [];
  if (changedFiles.some((file) => matchesAny(file, task.humanGateRequiredPaths))) {
    const humanGateResult = requireReview
      ? readApprovalForScope(root, task.id, "human-gate")
      : readApproval(root, task.id);
    const humanGateApproval = humanGateResult.approval;
    if (requireReview && humanGateApproval && humanGateApproval.version !== "scwbs.approval.v2" && !(humanGateApproval.approvalMode === "delegated" && humanGateApproval.delegationScope === "human-gate")) {
      blockers.push(blocker(task.id, "Human Gate Approval requires an independent scoped Approval record"));
    } else {
      const gate = validateHumanGateApproval(task, evidence, humanGateApproval, changedFiles, root);
      blockers.push(...gate.issues.map((issue) => blocker(task.id, `Human Gate Approval invalid (${issue.code})`)));
      if (gate.required && !gate.approved && gate.issues.length === 0) blockers.push(blocker(task.id, "Human Gate Approval is not approved"));
    }
  }

  return { task, evidence, review, approval, pullRequest: subject.pullRequest, blockers };
}

function validateNodeTargets(root: string, wbs: WbsDocument, task: TaskContract, cache: Map<string, EvaluatedTask>): { targets: CompletionTarget[]; blockers: CompletionBlocker[] } {
  const targets: CompletionTarget[] = [];
  const blockers: CompletionBlocker[] = [];
  const seen = new Set<string>();
  for (const targetId of completionTaskIds(task)) {
    if (targetId === task.id) {
      blockers.push(blocker(task.id, "completionTaskIds must not include itself"));
      continue;
    }
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    const targetResult = readTask(root, targetId);
    const targetTask = targetResult.task;
    if (!targetTask) {
      blockers.push(blocker(task.id, `completion target ${targetId} is unavailable (${issueCode(targetResult.issues, "task.invalid")})`));
      continue;
    }
    const association = taskWbsAssociation(wbs, targetTask);
    if (association.kind !== "node") {
      blockers.push(blocker(targetTask.id, `completion target references missing WBS node ${association.nodeId}`));
      continue;
    }
    if (association.node.id !== task.wbsNodeId) {
      blockers.push(blocker(targetTask.id, `completion target WBS node ${association.node.id} does not match ${task.wbsNodeId}`));
      continue;
    }
    const evaluated = cache.get(targetTask.id) ?? evaluateTask(root, targetTask, true);
    cache.set(targetTask.id, evaluated);
    blockers.push(...evaluated.blockers);
    targets.push({ taskId: targetTask.id, nodeCode: association.node.code, nodeName: association.node.name, pullRequest: evaluated.pullRequest, approvalStatus: evaluated.approval?.status, reviewStatus: evaluated.review?.status });
  }
  return { targets, blockers };
}

function buildCompletionChangeSet(wbs: WbsDocument, completionTaskId: string, reason: string, items: CompletionPlanItem[]): CompletionChangeSet {
  return {
    schemaVersion: "0.1.0", targetWbsId: wbs.id, changeSetId: `changeset-${completionTaskId}-complete-reviewed-work`, author: "human", reason, dryRun: false,
    operations: items.map((item, index) => ({ operationId: `op-${String(index + 1).padStart(3, "0")}`, operation: "changeNodeStatus", nodeId: item.node.id, status: "completed" }))
  };
}

export function buildCompletionPlan(root: string, taskIdsValue: string | undefined, options: { reason?: string; allowRoot: boolean }): CompletionPlan {
  const taskIds = parseTaskIds(taskIdsValue);
  if (taskIds.length === 0) throw new Error("Missing --tasks <task-id[,task-id...]>");
  const wbs = readWbs(root);
  const reason = options.reason ?? "Human approved completion through scwbs completion apply";
  const blockers: CompletionBlocker[] = [];
  const items: CompletionPlanItem[] = [];
  const cache = new Map<string, EvaluatedTask>();
  const seenNodes = new Set<string>();
  for (const taskId of taskIds) {
    const taskResult = readTask(root, taskId);
    const task = taskResult.task;
    if (!task) {
      blockers.push(blocker(taskId, `Task is unavailable (${issueCode(taskResult.issues, "task.invalid")})`));
      continue;
    }
    const association = taskWbsAssociation(wbs, task);
    if (association.kind === "wbs-less") {
      blockers.push(blocker(task.id, "Task is WBS-less and cannot complete a WBS node"));
      continue;
    }
    if (association.kind === "missing-node") {
      blockers.push(blocker(task.id, missingTaskWbsNodeMessage(task, association)));
      continue;
    }
    const node = association.node;
    if (!options.allowRoot && (node.id === wbs.rootId || node.parentId === null)) blockers.push(blocker(task.id, `Task targets root WBS node ${node.id}; --allow-root is required`));
    if (node.status !== "ready") blockers.push(blocker(task.id, `Task targets WBS node ${node.id} with status ${node.status ?? "planned"}`));
    if (seenNodes.has(node.id)) blockers.push(blocker(task.id, `multiple tasks target WBS node ${node.id}`));
    seenNodes.add(node.id);
    for (const dependency of incompleteDependencies(node.id, wbs)) blockers.push(blocker(task.id, `incomplete dependency ${dependency}`));
    const evaluated = cache.get(task.id) ?? evaluateTask(root, task, isNodeCompletionTask(task));
    cache.set(task.id, evaluated);
    blockers.push(...evaluated.blockers);
    let completionTargets: CompletionTarget[] = [];
    if (isNodeCompletionTask(task)) {
      const targetResult = validateNodeTargets(root, wbs, task, cache);
      completionTargets = targetResult.targets;
      blockers.push(...targetResult.blockers);
    }
    items.push({ taskId: task.id, node, pullRequest: evaluated.pullRequest, approval: evaluated.approval, reviewRequired: isNodeCompletionTask(task), completionTargets });
  }
  return { wbs, items, reason, blockers };
}

function renderCompletionPreview(plan: CompletionPlan, completionTaskId: string): string {
  if (plan.blockers.length > 0) return `${["Completion apply blocked:", ...plan.blockers.map((item) => `- ${item.taskId}: ${item.message}`)].join("\n")}\n`;
  const changeSet = buildCompletionChangeSet(plan.wbs, completionTaskId, plan.reason, plan.items);
  const lines = ["Completion apply dry-run:", ""];
  for (const item of plan.items) {
    lines.push(`- ${item.taskId}: ${item.node.code} ${item.node.name} -> completed`, `  pullRequest: ${item.pullRequest}`);
    if (item.reviewRequired) lines.push("  review: approved record validated");
    lines.push("  post-finish approval: approved record validated");
    if (item.completionTargets && item.completionTargets.length > 0) {
      lines.push("  completionTargets:");
      for (const target of item.completionTargets) {
        const details = [target.pullRequest ? `PR ${target.pullRequest}` : "no PR", target.reviewStatus ? `review ${target.reviewStatus}` : "no review", target.approvalStatus ? `approval ${target.approvalStatus}` : "no approval"].join(", ");
        lines.push(`    - ${target.taskId}: ${target.nodeCode} ${target.nodeName} (${details})`);
      }
    }
  }
  lines.push("", `changeset: contracts/changesets/${completionTaskId}-complete-reviewed-work.json`, `operations: ${changeSet.operations.length}`, "rerun with --apply to apply the WBS changeset and rebuild the registry");
  return `${lines.join("\n")}\n`;
}

export function buildCompletionPreview(root: string, taskIdsValue: string | undefined, completionTaskId: string, options: { reason?: string; allowRoot: boolean }): string {
  return renderCompletionPreview(buildCompletionPlan(root, taskIdsValue, options), completionTaskId);
}

export function runCompletionApply(root: string, taskIdsValue: string | undefined, completionTaskId: string | undefined, options: { reason?: string; apply: boolean; allowRoot: boolean }): number {
  try {
    if (!completionTaskId) {
      console.error("Missing --task <completion-task-id>");
      return 2;
    }
    const plan = buildCompletionPlan(root, taskIdsValue, options);
    if (plan.blockers.length > 0) {
      process.stderr.write(renderCompletionPreview(plan, completionTaskId));
      return 1;
    }
    if (!options.apply) {
      process.stdout.write(renderCompletionPreview(plan, completionTaskId));
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
