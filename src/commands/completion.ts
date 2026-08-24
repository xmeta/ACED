import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listActiveTasks, readApproval, readApprovalForScope, readBlock, readEvidence, readReview, readTask } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { validateDelegatedApproval, validateHumanApprovalProvenance, validateHumanGateApproval } from "../core/human-gate.js";
import { completionTaskIds, incompleteDependencies, isNodeCompletionTask, parseTaskIds } from "../core/node-utils.js";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import { readWbs } from "../core/wbs.js";
import type { ApprovalRecord, Evidence, ReviewRecord, TaskContract, WbsDocument, WbsNode } from "../core/types.js";
import { missingTaskWbsNodeMessage, taskWbsAssociation } from "../core/task-wbs-policy.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { runWbsApply } from "./wbs.js";

export type CompletionTarget = {
  taskId: string;
  nodeCode: string;
  nodeName: string;
  pullRequest?: string;
  approvalStatus?: string;
  reviewStatus?: string;
  graphPath?: string[];
  /** All deterministic parent paths which reach this de-duplicated target. */
  graphPaths?: string[][];
};

type CompletionPlanItem = {
  taskId: string;
  node: WbsNode;
  pullRequest?: string;
  approval?: ApprovalRecord;
  reviewRequired: boolean;
  completionTargets?: CompletionTarget[];
};

export type CompletionBlocker = {
  code: string;
  rootTaskId: string;
  taskId: string;
  phase: "graph" | "wbs" | "evidence" | "review" | "approval" | "human-gate" | "dependency";
  message: string;
  scope?: "human-gate" | "post-finish";
  graphPath?: string[];
};

type CompletionPlan = {
  wbs: WbsDocument;
  items: CompletionPlanItem[];
  reason: string;
  blockers: CompletionBlocker[];
  omittedBlockerCount: number;
};

type EvaluatedTask = {
  task: TaskContract;
  evidence?: Evidence;
  review?: ReviewRecord;
  approval?: ApprovalRecord;
  pullRequest?: string;
  blockers: CompletionBlocker[];
};

export type CompletionReadiness = {
  rootTaskId: string;
  evaluatedTaskIds: string[];
  targets: CompletionTarget[];
  blockers: CompletionBlocker[];
  omittedBlockerCount: number;
  canApply: boolean;
};

const MAX_GRAPH_DEPTH = 64;
const MAX_GRAPH_TASKS = 256;
const MAX_BLOCKERS = 128;

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

function blocker(rootTaskId: string, taskId: string, phase: CompletionBlocker["phase"], code: string, message: string, extra: Partial<Pick<CompletionBlocker, "scope" | "graphPath">> = {}): CompletionBlocker {
  return { code, rootTaskId, taskId, phase, message, ...extra };
}

function issueCode(issues: Array<{ code: string }>, fallback: string): string {
  return issues[0]?.code ?? fallback;
}

export function evidenceSubject(evidence: Evidence | undefined): { pullRequest?: string; headCommit?: string; diffHash?: string } {
  return {
    pullRequest: evidence?.git?.pullRequest,
    headCommit: evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit,
    diffHash: evidence?.diffHash ?? evidence?.git?.diffHash
  };
}

export function reviewSubjectMismatch(taskId: string, evidence: Evidence | undefined, review: ReviewRecord | undefined): string[] {
  const subject = evidenceSubject(evidence);
  const mismatches: string[] = [];
  if (!review) return ["Review unavailable; request or refresh the Review record"];
  if (review.taskId !== taskId) mismatches.push("Review taskId does not match Evidence Task");
  if (!subject.pullRequest || !review.pullRequest || review.pullRequest !== subject.pullRequest) mismatches.push("Review pullRequest does not match Evidence");
  if (!subject.headCommit || !review.headCommit || review.headCommit !== subject.headCommit) mismatches.push("Review headCommit does not match Evidence");
  if (!subject.diffHash || !review.diffHash || review.diffHash !== subject.diffHash) mismatches.push("Review diffHash does not match Evidence");
  return mismatches;
}

/** Evaluate Evidence, Review, post-finish Approval, then canonical Human Gate. */
function evaluateTask(root: string, rootTaskId: string, task: TaskContract, requireReview: boolean, graphPath: string[]): EvaluatedTask {
  const blockers: CompletionBlocker[] = [];
  const evidenceResult = readEvidence(root, task.id);
  const evidence = evidenceResult.evidence;
  if (!evidence) blockers.push(blocker(rootTaskId, task.id, "evidence", "evidence.invalid", `Evidence unavailable (${issueCode(evidenceResult.issues, "evidence.invalid")})`, { graphPath }));

  const reviewResult = requireReview ? readReview(root, task.id) : { review: undefined, issues: [] };
  const review = reviewResult.review;
  const subject = evidenceSubject(evidence);
  if (requireReview && !review) {
    blockers.push(blocker(rootTaskId, task.id, "review", "review.missing", `Review unavailable (${issueCode(reviewResult.issues, "review.invalid")})`, { graphPath }));
  } else if (requireReview && review) {
    if (review.status !== "approved") blockers.push(blocker(rootTaskId, task.id, "review", "review.status", `Review status is ${review.status}; approved is required`, { graphPath }));
    for (const mismatch of reviewSubjectMismatch(task.id, evidence, review)) {
      const code = mismatch.includes("taskId") ? "review.task-mismatch" : mismatch.includes("pullRequest") ? "review.pull-request-mismatch" : mismatch.includes("headCommit") ? "review.head-mismatch" : "review.diff-mismatch";
      blockers.push(blocker(rootTaskId, task.id, "review", code, mismatch, { graphPath }));
    }
  }

  const postFinishResult = readApprovalForScope(root, task.id, "post-finish");
  const approval = postFinishResult.approval;
  if (!approval) {
    blockers.push(blocker(rootTaskId, task.id, "approval", "approval.post-finish-missing", `post-finish Approval unavailable (${issueCode(postFinishResult.issues, "approval.invalid")})`, { scope: "post-finish", graphPath }));
  } else {
    if (approval.status !== "approved") blockers.push(blocker(rootTaskId, task.id, "approval", "approval.post-finish-status", `post-finish Approval status is ${approval.status}; approved is required`, { scope: "post-finish", graphPath }));
    if (requireReview && approval.version !== "scwbs.approval.v2" && !(approval.approvalMode === "delegated" && approval.delegationScope === "post-finish")) {
      blockers.push(blocker(rootTaskId, task.id, "approval", "approval.legacy-version", "node-level completion requires a current scoped post-finish Approval; legacy unscoped Approval cannot substitute", { scope: "post-finish", graphPath }));
    }
    if (approval.approvalMode === "delegated") blockers.push(...validateDelegatedApproval(task, approval, "post-finish").map((issue) => blocker(rootTaskId, task.id, "approval", issue.code, `post-finish Approval invalid (${issue.code})`, { scope: "post-finish", graphPath })));
    else if (approval.version === "scwbs.approval.v2") blockers.push(...validateHumanApprovalProvenance(approval, true, true).map((issue) => blocker(rootTaskId, task.id, "approval", issue.code, `post-finish Approval invalid (${issue.code})`, { scope: "post-finish", graphPath })));
    if (!subject.pullRequest || !approval.pullRequest || approval.pullRequest !== subject.pullRequest) blockers.push(blocker(rootTaskId, task.id, "approval", "approval.pull-request-mismatch", "post-finish Approval pullRequest does not match Evidence", { scope: "post-finish", graphPath }));
    if (!subject.headCommit || !approval.headCommit || approval.headCommit !== subject.headCommit) blockers.push(blocker(rootTaskId, task.id, "approval", "approval.head-mismatch", "post-finish Approval headCommit does not match Evidence", { scope: "post-finish", graphPath }));
    if (!subject.diffHash || !approval.diffHash || approval.diffHash !== subject.diffHash) blockers.push(blocker(rootTaskId, task.id, "approval", "approval.diff-mismatch", "post-finish Approval diffHash does not match Evidence", { scope: "post-finish", graphPath }));
  }

  const changedFiles = evidence?.changedFiles ?? [];
  if (requireReview && evidence) {
    if (!subject.pullRequest) blockers.push(blocker(rootTaskId, task.id, "evidence", "evidence.pull-request-missing", "Evidence does not record a pullRequest subject", { graphPath }));
    if (!subject.headCommit) blockers.push(blocker(rootTaskId, task.id, "evidence", "evidence.subject-head-missing", "Evidence does not record a subjectHeadCommit", { graphPath }));
    if (!subject.diffHash) blockers.push(blocker(rootTaskId, task.id, "evidence", "evidence.diff-hash-missing", "Evidence does not record a diffHash", { graphPath }));
  }
  if (changedFiles.some((file) => matchesAny(file, task.humanGateRequiredPaths))) {
    const humanGateResult = requireReview
      ? readApprovalForScope(root, task.id, "human-gate")
      : readApproval(root, task.id);
    const humanGateApproval = humanGateResult.approval;
    const humanGateApprovalBundle = readApproval(root, task.id).approval;
    if (requireReview && humanGateApproval && humanGateApproval.version !== "scwbs.approval.v2" && !(humanGateApproval.approvalMode === "delegated" && humanGateApproval.delegationScope === "human-gate")) {
      blockers.push(blocker(rootTaskId, task.id, "human-gate", "approval.human-gate-scope", "Human Gate Approval requires an independent scoped Approval record", { scope: "human-gate", graphPath }));
    } else {
      const gate = validateHumanGateApproval(task, evidence, humanGateApprovalBundle, changedFiles, root);
      blockers.push(...gate.issues.map((issue) => blocker(rootTaskId, task.id, "human-gate", issue.code, `Human Gate Approval invalid (${issue.code})`, { scope: "human-gate", graphPath })));
      if (gate.required && !gate.approved && gate.issues.length === 0) blockers.push(blocker(rootTaskId, task.id, "human-gate", "approval.human-gate-status", "Human Gate Approval is not approved", { scope: "human-gate", graphPath }));
    }
  }

  return { task, evidence, review, approval, pullRequest: subject.pullRequest, blockers };
}

function boundBlockers(blockers: CompletionBlocker[]): { blockers: CompletionBlocker[]; omittedBlockerCount: number } {
  const unique: CompletionBlocker[] = [];
  const seen = new Set<string>();
  for (const item of blockers) {
    const key = `${item.code}|${item.rootTaskId}|${item.taskId}|${item.phase}|${item.message}|${item.graphPath?.join(">") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return { blockers: unique.slice(0, MAX_BLOCKERS), omittedBlockerCount: Math.max(0, unique.length - MAX_BLOCKERS) };
}

function evaluateGraph(root: string, wbs: WbsDocument, rootTask: TaskContract, options: { allowRoot?: boolean } = {}): CompletionReadiness {
  const blockers: CompletionBlocker[] = [];
  const targets: CompletionTarget[] = [];
  const evaluatedTaskIds: string[] = [];
  const cache = new Map<string, EvaluatedTask>();
  const visited = new Set<string>();
  const active = new Set<string>();
  const pathsByTask = new Map<string, string[][]>();
  const targetsByTask = new Map<string, CompletionTarget>();
  let graphCount = 0;

  const recordPath = (taskId: string, graphPath: string[]): string[][] => {
    const paths = pathsByTask.get(taskId) ?? [];
    if (!paths.some((path) => path.length === graphPath.length && path.every((part, index) => part === graphPath[index]))) paths.push([...graphPath]);
    pathsByTask.set(taskId, paths);
    return paths;
  };

  const recordTarget = (target: CompletionTarget): void => {
    const paths = recordPath(target.taskId, target.graphPath ?? [target.taskId]);
    const previous = targetsByTask.get(target.taskId);
    if (previous) {
      previous.graphPaths = paths.map((path) => [...path]);
      previous.graphPath = paths[0];
      return;
    }
    target.graphPaths = paths.map((path) => [...path]);
    target.graphPath = paths[0];
    targetsByTask.set(target.taskId, target);
    targets.push(target);
  };

  const taskCountsByNode = new Map<string, number>();
  // The shared-node policy is part of the evaluator so queue and completion
  // cannot disagree about ordinary Tasks sharing a WBS node.
  for (const entry of listActiveTasks(root)) {
    if (entry.task) taskCountsByNode.set(entry.task.wbsNodeId, (taskCountsByNode.get(entry.task.wbsNodeId) ?? 0) + 1);
  }

  const addCommonBlockers = (task: TaskContract, association: Extract<ReturnType<typeof taskWbsAssociation>, { kind: "node" }>, evaluation: EvaluatedTask, graphPath: string[]) => {
    const node = association.node;
    if (node.status !== "ready") blockers.push(blocker(rootTask.id, task.id, "wbs", "wbs.node-not-ready", `WBS node status is ${node.status ?? "planned"}; completion requires ready`, { graphPath }));
    for (const dependency of incompleteDependencies(node.id, wbs)) blockers.push(blocker(rootTask.id, task.id, "dependency", "wbs.dependency-not-completed", dependency, { graphPath }));
    const { block } = readBlock(root, task.id);
    if (block?.status === "blocked") blockers.push(blocker(rootTask.id, task.id, "wbs", "wbs.active-block", `active Block: ${block.reason}`, { graphPath }));
    for (const submodule of evaluation.evidence?.submodules ?? []) {
      if (!submodule.upstreamReachable) blockers.push(blocker(rootTask.id, task.id, "dependency", "submodule.not-upstream-reachable", `submodule ${submodule.path} head is not upstream-reachable`, { graphPath }));
      for (const check of submodule.checks ?? []) if (check.status !== "passed") blockers.push(blocker(rootTask.id, task.id, "dependency", "submodule.check-failed", `submodule ${submodule.path} check ${check.name} is ${check.status}`, { graphPath }));
    }
  };

  const visit = (taskId: string, graphPath: string[], depth: number): void => {
    if (depth > MAX_GRAPH_DEPTH) {
      blockers.push(blocker(rootTask.id, taskId, "graph", "completion.graph-depth-exceeded", `completion graph depth exceeds ${MAX_GRAPH_DEPTH}`, { graphPath }));
      return;
    }
    recordPath(taskId, graphPath);
    if (active.has(taskId)) {
      blockers.push(blocker(rootTask.id, taskId, "graph", "completion.graph-cycle", `completionTaskIds cycle detected: ${graphPath.join(" -> ")}`, { graphPath }));
      return;
    }
    if (visited.has(taskId)) {
      const existing = targetsByTask.get(taskId);
      if (existing) {
        const paths = pathsByTask.get(taskId) ?? [graphPath];
        existing.graphPaths = paths.map((path) => [...path]);
        existing.graphPath = paths[0];
      }
      return;
    }
    if (graphCount >= MAX_GRAPH_TASKS) {
      blockers.push(blocker(rootTask.id, taskId, "graph", "completion.graph-task-limit", `completion graph exceeds ${MAX_GRAPH_TASKS} evaluated Tasks`, { graphPath }));
      return;
    }
    graphCount += 1;
    active.add(taskId);
    const result = readTask(root, taskId);
    const task = result.task;
    if (!task) {
      blockers.push(blocker(rootTask.id, taskId, "graph", "completion.target-missing", `completion target ${taskId} is unavailable (${issueCode(result.issues, "task.invalid")})`, { graphPath }));
      active.delete(taskId);
      visited.add(taskId);
      return;
    }
    const association = taskWbsAssociation(wbs, task);
    if (association.kind !== "node") {
      blockers.push(blocker(rootTask.id, task.id, "graph", association.kind === "wbs-less" ? "completion.target-wbs-less" : "completion.target-node-missing", `completion target references ${association.kind === "wbs-less" ? "WBS-less" : `missing WBS node ${association.nodeId}`}`, { graphPath }));
      active.delete(taskId);
      visited.add(taskId);
      return;
    }
    if (association.node.id !== rootTask.wbsNodeId) blockers.push(blocker(rootTask.id, task.id, "graph", "completion.target-node-mismatch", `completion target WBS node ${association.node.id} does not match ${rootTask.wbsNodeId}`, { graphPath }));
    if (!options.allowRoot && (association.node.id === wbs.rootId || association.node.parentId === null)) {
      blockers.push(blocker(rootTask.id, task.id, "wbs", "wbs.root-not-allowed", `Task targets root WBS node ${association.node.id}; --allow-root is required`, { graphPath }));
    }
    if (task.id === rootTask.id && !isNodeCompletionTask(task) && (taskCountsByNode.get(task.wbsNodeId) ?? 0) > 1) {
      blockers.push(blocker(rootTask.id, task.id, "wbs", "wbs.shared-node-task", "node has multiple Task Contracts; completion requires a dedicated node-level completion task", { graphPath }));
    }
    // A target on another node is structurally invalid. Keep the target visible
    // for diagnostics, but continue traversing its reachable completion graph:
    // this reports every cross-node edge and still detects descendants/cycles.
    if (association.node.id !== rootTask.wbsNodeId) {
      if (task.id !== rootTask.id) recordTarget({ taskId: task.id, nodeCode: association.node.code, nodeName: association.node.name, graphPath });
      if (isNodeCompletionTask(task)) {
        for (const childId of completionTaskIds(task)) {
          if (childId === task.id) {
            blockers.push(blocker(rootTask.id, task.id, "graph", "completion.self-reference", "completionTaskIds must not include itself", { graphPath: [...graphPath, childId] }));
            continue;
          }
          visit(childId, [...graphPath, childId], depth + 1);
        }
      }
      active.delete(taskId);
      visited.add(taskId);
      return;
    }
    const requireReview = task.id === rootTask.id ? isNodeCompletionTask(task) : true;
    const evaluation = cache.get(task.id) ?? evaluateTask(root, rootTask.id, task, requireReview, graphPath);
    cache.set(task.id, evaluation);
    evaluatedTaskIds.push(task.id);
    blockers.push(...evaluation.blockers);
    addCommonBlockers(task, association, evaluation, graphPath);
    if (task.id !== rootTask.id) recordTarget({ taskId: task.id, nodeCode: association.node.code, nodeName: association.node.name, pullRequest: evaluation.pullRequest, approvalStatus: evaluation.approval?.status, reviewStatus: evaluation.review?.status, graphPath });
    if (isNodeCompletionTask(task)) {
      for (const childId of completionTaskIds(task)) {
        if (childId === task.id) {
          blockers.push(blocker(rootTask.id, task.id, "graph", "completion.self-reference", "completionTaskIds must not include itself", { graphPath: [...graphPath, childId] }));
          continue;
        }
        visit(childId, [...graphPath, childId], depth + 1);
      }
    }
    active.delete(taskId);
    visited.add(taskId);
  };

  visit(rootTask.id, [rootTask.id], 0);
  const bounded = boundBlockers(blockers);
  return { rootTaskId: rootTask.id, evaluatedTaskIds, targets, ...bounded, canApply: bounded.blockers.length === 0 && bounded.omittedBlockerCount === 0 };
}

export function evaluateCompletionReadiness(root: string, taskId: string, options: { allowRoot?: boolean } = {}): CompletionReadiness {
  const taskResult = readTask(root, taskId);
  if (!taskResult.task) {
    const item = blocker(taskId, taskId, "graph", "task.invalid", `Task is unavailable (${issueCode(taskResult.issues, "task.invalid")})`, { graphPath: [taskId] });
    return { rootTaskId: taskId, evaluatedTaskIds: [], targets: [], blockers: [item], omittedBlockerCount: 0, canApply: false };
  }
  return evaluateGraph(root, readWbs(root), taskResult.task, options);
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
  const seenNodes = new Set<string>();
  let readinessOmitted = 0;
  for (const taskId of taskIds) {
    const taskResult = readTask(root, taskId);
    const task = taskResult.task;
    if (!task) {
      blockers.push(blocker(taskId, taskId, "graph", "task.invalid", `Task is unavailable (${issueCode(taskResult.issues, "task.invalid")})`, { graphPath: [taskId] }));
      continue;
    }
    const association = taskWbsAssociation(wbs, task);
    if (association.kind === "wbs-less") {
      blockers.push(blocker(task.id, task.id, "wbs", "task.wbs-less", "Task is WBS-less and cannot complete a WBS node", { graphPath: [task.id] }));
      continue;
    }
    if (association.kind === "missing-node") {
      blockers.push(blocker(task.id, task.id, "wbs", "task.node-missing", missingTaskWbsNodeMessage(task, association), { graphPath: [task.id] }));
      continue;
    }
    const node = association.node;
    if (!options.allowRoot && (node.id === wbs.rootId || node.parentId === null)) blockers.push(blocker(task.id, task.id, "wbs", "wbs.root-not-allowed", `Task targets root WBS node ${node.id}; --allow-root is required`, { graphPath: [task.id] }));
    if (seenNodes.has(node.id)) blockers.push(blocker(task.id, task.id, "wbs", "wbs.multiple-tasks", `multiple tasks target WBS node ${node.id}`, { graphPath: [task.id] }));
    seenNodes.add(node.id);
    const readiness = evaluateCompletionReadiness(root, task.id, { allowRoot: options.allowRoot });
    blockers.push(...readiness.blockers);
    readinessOmitted += readiness.omittedBlockerCount;
    const evaluatedEvidence = readEvidence(root, task.id).evidence;
    const evaluatedApproval = readApprovalForScope(root, task.id, "post-finish").approval;
    items.push({ taskId: task.id, node, pullRequest: evidenceSubject(evaluatedEvidence).pullRequest, approval: evaluatedApproval, reviewRequired: isNodeCompletionTask(task), completionTargets: readiness.targets });
  }
  const bounded = boundBlockers(blockers);
  return { wbs, items, reason, blockers: bounded.blockers, omittedBlockerCount: readinessOmitted + bounded.omittedBlockerCount };
}

function renderCompletionPreview(plan: CompletionPlan, completionTaskId: string): string {
  if (plan.blockers.length > 0 || plan.omittedBlockerCount > 0) {
    const lines = ["Completion apply blocked:", ...plan.blockers.map((item) => `- [${item.code}] ${item.rootTaskId}/${item.taskId} (${item.phase}): ${item.message}${item.graphPath ? ` [path: ${item.graphPath.join(" -> ")}]` : ""}`)];
    if (plan.omittedBlockerCount > 0) lines.push(`- ${plan.omittedBlockerCount} additional blockers omitted`);
    return `${lines.join("\n")}\n`;
  }
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
    if (plan.blockers.length > 0 || plan.omittedBlockerCount > 0) {
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
