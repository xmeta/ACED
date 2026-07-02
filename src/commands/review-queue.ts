import { readApproval, listTasks, readEvidence, readReview } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";

type ReviewQueueEntry = {
  taskId: string;
  nodeCode: string;
  nodeName: string;
  reasons: string[];
  warnings: string[];
  completionBlockedBy: string[];
  branchName?: string;
  pullRequest?: string;
  approvalStatus?: string;
  reviewStatus?: string;
  suggestedAction: string;
};

function incompleteDependencies(rootNodeId: string, wbs: ReturnType<typeof readWbs>): string[] {
  const nodesById = new Map(wbs.nodes.map((node) => [node.id, node]));
  return (wbs.relations ?? [])
    .filter((relation) => relation.type === "dependsOn" && relation.source === rootNodeId)
    .flatMap((relation) => {
      const node = nodesById.get(relation.target);
      if (!node || isDoneNode(node)) return [];
      return [`${node.code} ${node.name}`];
    });
}

export function buildReviewQueue(root: string): string {
  const wbs = readWbs(root);
  const entries: ReviewQueueEntry[] = [];
  const tasks = listTasks(root);
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
    const { evidence, issues } = readEvidence(root, task.id);
    const { approval, issues: approvalIssues } = readApproval(root, task.id);
    const { review, issues: reviewIssues } = readReview(root, task.id);
    const missingEvidenceOnly = issues.length === 1 && issues[0]?.code === "evidence.missing";
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    const missingReviewOnly = reviewIssues.length === 1 && reviewIssues[0]?.code === "review.missing";
    const hasEvidence = Boolean(evidence) && !missingEvidenceOnly;
    const hasApproval = Boolean(approval) && !missingApprovalOnly;
    const hasReview = Boolean(review) && !missingReviewOnly;

    if (hasEvidence && !isDoneNode(node)) {
      reasons.push(
        completionBlockedBy.length === 0
          ? "evidence exists and the WBS node is ready for human review"
          : "evidence exists and the WBS node is not completed"
      );
    }

    if (completionBlockedBy.length > 0) {
      for (const blockedBy of completionBlockedBy) {
        warnings.push(`dependsOn node ${blockedBy} is not completed`);
      }
    }
    if ((taskCountByNode.get(node.id) ?? 0) > 1) {
      completionBlockedBy.push("node has multiple Task Contracts; completion requires a dedicated node-level completion task");
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
      const suggestedAction = completionBlockedBy.length > 0
        ? sharedNodeCompletionBlocked
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
        branchName: evidence?.git?.branch ?? task.branchName,
        pullRequest: evidence?.git?.pullRequest ?? approval?.pullRequest,
        approvalStatus: approval?.status,
        reviewStatus: review?.status,
        suggestedAction
      });
    }
  }

  const lines = ["Review Queue:"];
  if (entries.length === 0) {
    lines.push("- None");
    return `${lines.join("\n")}\n`;
  }

  const sortedEntries = entries.sort((a, b) => a.taskId.localeCompare(b.taskId));
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

export function runReviewQueue(root: string): number {
  try {
    process.stdout.write(buildReviewQueue(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
