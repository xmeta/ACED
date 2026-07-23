import { readApproval, listActiveTasks, listTasks, readBlock, readEvidence, readReview } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { completionTaskIds, incompleteDependencies, isNodeCompletionTask } from "../core/node-utils.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";
import type { TaskContract } from "../core/types.js";

type ReviewQueueEntry = {
  taskId: string;
  nodeCode: string;
  nodeName: string;
  reasons: string[];
  warnings: string[];
  completionBlockedBy: string[];
  completionTargets?: NodeCompletionTarget[];
  branchName?: string;
  pullRequest?: string;
  approvalStatus?: string;
  reviewStatus?: string;
  suggestedAction: string;
};

export type ReviewQueueOptions = {
  verbose?: boolean;
  json?: boolean;
  limit?: number;
};

export type ReviewQueueSummary = {
  schemaVersion: "1.0.0";
  health: {
    candidates: number;
    missingPullRequest: number;
    blocked: number;
    ready: number;
  };
  blockerCounts: Array<{ code: string; count: number }>;
  candidates: ReviewQueueEntry[];
  omitted: number;
  limit: number | null;
};

type NodeCompletionTarget = {
  taskId: string;
  nodeCode: string;
  nodeName: string;
  pullRequest?: string;
  approvalStatus?: string;
  reviewStatus?: string;
};

function collectNodeCompletionTargets(root: string, wbs: ReturnType<typeof readWbs>, task: TaskContract): { blockers: string[]; targets: NodeCompletionTarget[] } {
  const blockers: string[] = [];
  const targets: NodeCompletionTarget[] = [];
  const seen = new Set<string>();

  for (const targetId of completionTaskIds(task)) {
    if (targetId === task.id) {
      blockers.push(`${task.id} completionTaskIds must not include itself`);
      continue;
    }
    if (seen.has(targetId)) continue;
    seen.add(targetId);

    const taskEntry = listTasks(root).find((entry) => entry.task?.id === targetId);
    const targetTask = taskEntry?.task;
    if (!targetTask) {
      blockers.push(`missing completion target task ${targetId}`);
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

    const { evidence, issues } = readEvidence(root, targetTask.id);
    const { approval, issues: approvalIssues } = readApproval(root, targetTask.id);
    const { review, issues: reviewIssues } = readReview(root, targetTask.id);
    const missingEvidenceOnly = issues.length === 1 && issues[0]?.code === "evidence.missing";
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

function nodeReadinessBlocker(node: NonNullable<ReturnType<typeof findNode>>): string | undefined {
  return node.status === "ready" ? undefined : `WBS node status is ${node.status ?? "planned"}; completion requires ready`;
}

function collectReviewQueueEntries(root: string): ReviewQueueEntry[] {
  const wbs = readWbs(root);
  const entries: ReviewQueueEntry[] = [];
  const tasks = listActiveTasks(root);
  const taskCountByNode = new Map<string, number>();
  for (const entry of tasks) {
    if (!entry.task) continue;
    taskCountByNode.set(entry.task.wbsNodeId, (taskCountByNode.get(entry.task.wbsNodeId) ?? 0) + 1);
  }

  for (const entry of tasks) {
    const task = entry.task;
    if (!task) continue;
    const node = findNode(wbs, task.wbsNodeId);
    if (!node) continue;

    const reasons: string[] = [];
    const warnings: string[] = [];
    const completionBlockedBy = incompleteDependencies(node.id, wbs);
    const { block } = readBlock(root, task.id);
    if (block?.status === "blocked") {
      completionBlockedBy.push(`active Block: ${block.reason}`);
    }
    const readinessBlocker = nodeReadinessBlocker(node);
    const nodeCompletionTargets = isNodeCompletionTask(task) ? collectNodeCompletionTargets(root, wbs, task) : { blockers: [], targets: [] as NodeCompletionTarget[] };
    const { evidence, issues } = readEvidence(root, task.id);
    const { approval, issues: approvalIssues } = readApproval(root, task.id);
    const { review, issues: reviewIssues } = readReview(root, task.id);
    const missingEvidenceOnly = issues.length === 1 && issues[0]?.code === "evidence.missing";
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    const missingReviewOnly = reviewIssues.length === 1 && reviewIssues[0]?.code === "review.missing";
    const hasEvidence = Boolean(evidence) && !missingEvidenceOnly;
    const hasApproval = Boolean(approval) && !missingApprovalOnly;
    const hasReview = Boolean(review) && !missingReviewOnly;
    const isTerminalReview = Boolean(review) && hasReview && (review!.status === "approved" || review!.status === "changes-requested" || review!.status === "closed");

    for (const submodule of evidence?.submodules ?? []) {
      warnings.push(`submodule ${submodule.path}: ${submodule.baseCommit} -> ${submodule.headCommit}; merge dependent PR ${submodule.pullRequest ?? "not recorded"} before parent PR; upstream target ${submodule.upstreamRef}`);
      if (!submodule.upstreamReachable) completionBlockedBy.push(`submodule ${submodule.path} head is not upstream-reachable`);
      for (const check of submodule.checks ?? []) {
        if (check.status !== "passed") completionBlockedBy.push(`submodule ${submodule.path} check ${check.name} is ${check.status}`);
      }
    }

    if (hasEvidence && !isDoneNode(node) && !isTerminalReview) {
      reasons.push(
        !readinessBlocker && completionBlockedBy.length === 0
          ? "evidence exists and the WBS node is ready for human review"
          : "evidence exists and the WBS node is not completed"
      );
    }

    if (completionBlockedBy.length > 0) {
      for (const blockedBy of completionBlockedBy) {
        warnings.push(`dependsOn node ${blockedBy} is not completed`);
      }
    }
    if (readinessBlocker) {
      completionBlockedBy.push(readinessBlocker);
      warnings.push(readinessBlocker);
    }
    if (!isNodeCompletionTask(task) && (taskCountByNode.get(node.id) ?? 0) > 1) {
      completionBlockedBy.push("node has multiple Task Contracts; completion requires a dedicated node-level completion task");
    }
    if (isNodeCompletionTask(task) && nodeCompletionTargets.blockers.length > 0) {
      for (const blockedBy of nodeCompletionTargets.blockers) {
        completionBlockedBy.push(blockedBy);
      }
    }

    if (evidence) {
      const touchesHumanGate = evidence.changedFiles.some((file) => matchesAny(file, task.humanGateRequiredPaths));
      if (touchesHumanGate && !hasApproval) {
        reasons.push("human gate paths were changed but no approval record exists");
      }
      if (hasEvidence && !evidence.git?.branch && !task.branchName) {
        warnings.push("no branch metadata is recorded for this review candidate");
      }
      if (hasEvidence && !evidence.git?.pullRequest && !approval?.pullRequest) {
        warnings.push("no pull request is recorded for this review candidate");
      }
      if (hasEvidence && (evidence.git?.pullRequest || approval?.pullRequest) && !hasReview) {
        warnings.push("no review request is recorded for this review candidate");
      }
    }

    if (approval?.status === "requested") {
      warnings.push("human review approval has been requested but is not approved yet");
    } else if (approval?.status === "rejected") {
      warnings.push("human review approval was rejected");
    }

    if (reasons.length > 0) {
      const hasPullRequest = Boolean(evidence?.git?.pullRequest ?? approval?.pullRequest);
      const sharedNodeCompletionBlocked = completionBlockedBy.some((item) => item.includes("multiple Task Contracts"));
      const nodeCompletionTaskBlocked = isNodeCompletionTask(task) && completionBlockedBy.length > 0;
      const suggestedAction = completionBlockedBy.length > 0
        ? nodeCompletionTaskBlocked
          ? "review evidence now, but defer node completion until the completion targets are ready"
          : sharedNodeCompletionBlocked
          ? "review evidence now, but defer WBS completion to a dedicated node-level completion task"
          : "review evidence now, but defer completion until dependencies are completed"
        : !hasPullRequest
          ? "create or record PR, then human review for completion"
          : !hasReview
            ? "request review for this task"
            : "human review for completion";
      entries.push({
        taskId: task.id,
        nodeCode: node.code,
        nodeName: node.name,
        reasons,
        warnings,
        completionBlockedBy,
        completionTargets: nodeCompletionTargets.targets,
        branchName: evidence?.git?.branch ?? task.branchName,
        pullRequest: evidence?.git?.pullRequest ?? approval?.pullRequest,
        approvalStatus: approval?.status,
        reviewStatus: review?.status,
        suggestedAction
      });
    }
  }

  return entries.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function blockerCode(blocker: string): string {
  if (blocker.startsWith("active Block:")) return "active-block";
  if (blocker.startsWith("WBS node status is")) return "node-not-ready";
  if (blocker.includes("multiple Task Contracts")) return "shared-node-completion-task-required";
  if (blocker.includes("missing completion target task")) return "completion-target-missing";
  if (blocker.includes("references missing WBS node")) return "wbs-node-missing";
  if (blocker.includes("targets WBS node")) return "completion-target-node-mismatch";
  if (blocker.includes("is missing evidence")) return "evidence-missing";
  if (blocker.includes("is missing pull request metadata")) return "pull-request-missing";
  if (blocker.includes("is missing review metadata")) return "review-missing";
  if (blocker.includes("changed human gate paths")) return "human-approval-missing";
  if (blocker.includes("approval is still requested")) return "human-approval-requested";
  if (blocker.includes("approval was rejected")) return "human-approval-rejected";
  if (blocker.startsWith("submodule ")) return "submodule-not-ready";
  return "dependency-not-completed";
}

function blockerCounts(entries: ReviewQueueEntry[]): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const blocker of entry.completionBlockedBy) {
      const code = blockerCode(blocker);
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  const missingPullRequestCount = entries.filter((entry) => !entry.pullRequest).length;
  if (missingPullRequestCount > 0) counts.set("pull-request-missing", (counts.get("pull-request-missing") ?? 0) + missingPullRequestCount);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function prioritizeEntries(entries: ReviewQueueEntry[]): ReviewQueueEntry[] {
  return [...entries].sort((a, b) => {
    const readyDifference = Number(a.completionBlockedBy.length > 0) - Number(b.completionBlockedBy.length > 0);
    if (readyDifference !== 0) return readyDifference;
    const pullRequestDifference = Number(!a.pullRequest) - Number(!b.pullRequest);
    return pullRequestDifference || a.taskId.localeCompare(b.taskId);
  });
}

function candidateNextCommand(entry: ReviewQueueEntry): string {
  if (!entry.pullRequest) return `scwbs evidence collect --task ${entry.taskId} --pull-request <number>`;
  if (!entry.reviewStatus) return `scwbs review request --task ${entry.taskId}`;
  if (entry.reviewStatus === "requested" && entry.completionBlockedBy.length === 0) {
    return `scwbs review approve --task ${entry.taskId} --actor human`;
  }
  return "scwbs review-queue --verbose";
}

export function buildReviewQueueSummary(root: string, limit?: number): ReviewQueueSummary {
  const entries = collectReviewQueueEntries(root);
  const prioritized = prioritizeEntries(entries);
  const selected = limit === undefined ? prioritized : prioritized.slice(0, limit);
  const blocked = entries.filter((entry) => entry.completionBlockedBy.length > 0).length;
  return {
    schemaVersion: "1.0.0",
    health: {
      candidates: entries.length,
      missingPullRequest: entries.filter((entry) => !entry.pullRequest).length,
      blocked,
      ready: entries.length - blocked
    },
    blockerCounts: blockerCounts(entries),
    candidates: selected,
    omitted: entries.length - selected.length,
    limit: limit ?? null
  };
}

function formatReviewQueueSummary(summary: ReviewQueueSummary): string {
  const lines = ["Review Queue:", "", "Review Health:"];
  lines.push(`- ${summary.health.candidates} review candidates`);
  lines.push(`- ${summary.health.missingPullRequest} candidates missing pull request metadata`);
  lines.push(`- ${summary.health.blocked} candidates blocked by completion prerequisites`);
  lines.push(`- ${summary.health.ready} candidates ready for completion review`);
  lines.push("", "Major blockers:");
  if (summary.blockerCounts.length === 0) lines.push("- None");
  else for (const blocker of summary.blockerCounts.slice(0, 5)) lines.push(`- ${blocker.code}: ${blocker.count}`);
  lines.push("", `Top candidates (limit ${summary.limit ?? summary.candidates.length}):`);
  if (summary.candidates.length === 0) lines.push("- None");
  else {
    for (const entry of summary.candidates) {
      const state = entry.completionBlockedBy.length === 0 ? "ready" : "blocked";
      lines.push(`- ${entry.taskId} | ${state} | ${entry.suggestedAction}`);
      lines.push(`  next: ${candidateNextCommand(entry)}`);
    }
  }
  lines.push(`- ${summary.omitted} additional candidates omitted`);
  lines.push("", "Next command:", "  scwbs review-queue --verbose");
  return `${lines.join("\n")}\n`;
}

export function buildReviewQueue(root: string): string {
  const sortedEntries = collectReviewQueueEntries(root);
  const lines = ["Review Queue:"];
  if (sortedEntries.length === 0) {
    lines.push("- None");
    return `${lines.join("\n")}\n`;
  }

  const missingPullRequestCount = sortedEntries.filter((item) => !item.pullRequest).length;
  const blockedCount = sortedEntries.filter((item) => item.completionBlockedBy.length > 0).length;
  const readyCount = sortedEntries.length - blockedCount;

  lines.push("");
  lines.push("Review Health:");
  lines.push(`- ${sortedEntries.length} review candidates`);
  lines.push(`- ${missingPullRequestCount} candidates missing pull request metadata`);
  lines.push(`- ${blockedCount} candidates blocked by completion prerequisites`);
  lines.push(`- ${readyCount} candidates ready for completion review`);
  lines.push("");

  for (const item of sortedEntries) {
    lines.push(`- ${item.taskId} | ${item.nodeCode} | ${item.nodeName}`);
    if (item.branchName) {
      lines.push(`  branch: ${item.branchName}`);
    }
    if (item.pullRequest) {
      lines.push(`  pullRequest: ${item.pullRequest}`);
    }
    if (item.approvalStatus) {
      lines.push(`  approvalStatus: ${item.approvalStatus}`);
    }
    if (item.reviewStatus) {
      lines.push(`  reviewStatus: ${item.reviewStatus}`);
    }
    for (const reason of item.reasons) {
      lines.push(`  reason: ${reason}`);
    }
    for (const warning of item.warnings) {
      lines.push(`  warning: ${warning}`);
    }
    for (const blockedBy of item.completionBlockedBy) {
      lines.push(`  completionBlockedBy: ${blockedBy}`);
    }
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
    lines.push(`  suggestedAction: ${item.suggestedAction}`);
  }

  const readyEntries = sortedEntries.filter((item) => item.completionBlockedBy.length === 0);
  const blockedEntries = sortedEntries.filter((item) => item.completionBlockedBy.length > 0);
  const missingPullRequestEntries = sortedEntries.filter((item) => !item.pullRequest);

  lines.push("");
  lines.push("Ready for completion review:");
  if (readyEntries.length === 0) {
    lines.push("- None");
  } else {
    for (const item of readyEntries) lines.push(`- ${item.taskId}`);
  }

  lines.push("");
  lines.push("Blocked review candidates:");
  if (blockedEntries.length === 0) {
    lines.push("- None");
  } else {
    for (const item of blockedEntries) {
      const blockers = item.completionBlockedBy.join(", ");
      lines.push(`- ${item.taskId} blocked by ${blockers}`);
    }
  }

  lines.push("");
  lines.push("Missing PR metadata:");
  if (missingPullRequestEntries.length === 0) {
    lines.push("- None");
  } else {
    for (const item of missingPullRequestEntries) lines.push(`- ${item.taskId}`);
  }

  return `${lines.join("\n")}\n`;
}

export function runReviewQueue(root: string, options: ReviewQueueOptions = {}): number {
  try {
    if (options.json && options.verbose) {
      console.error("Choose one of --json or --verbose");
      return 2;
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      console.error("--limit must be a positive integer");
      return 2;
    }
    if (options.verbose) {
      process.stdout.write(buildReviewQueue(root));
      return 0;
    }
    const summary = buildReviewQueueSummary(root, options.limit ?? (options.json ? undefined : 5));
    if (options.json) console.log(JSON.stringify(summary));
    else process.stdout.write(formatReviewQueueSummary(summary));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
