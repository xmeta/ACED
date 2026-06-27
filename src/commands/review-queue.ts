import { readApproval, listTasks, readEvidence } from "../core/contracts.js";
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

  for (const entry of listTasks(root)) {
    const task = entry.task;
    if (!task) continue;
    const node = findNode(wbs, task.wbsNodeId);
    if (!node) continue;

    const reasons: string[] = [];
    const warnings: string[] = [];
    const completionBlockedBy = incompleteDependencies(node.id, wbs);
    const { evidence, issues } = readEvidence(root, task.id);
    const { approval, issues: approvalIssues } = readApproval(root, task.id);
    const missingEvidenceOnly = issues.length === 1 && issues[0]?.code === "evidence.missing";
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    const hasEvidence = Boolean(evidence) && !missingEvidenceOnly;
    const hasApproval = Boolean(approval) && !missingApprovalOnly;

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
    }

    if (approval?.status === "requested") {
      warnings.push("human review approval has been requested but is not approved yet");
    } else if (approval?.status === "rejected") {
      warnings.push("human review approval was rejected");
    }

    if (reasons.length > 0) {
      entries.push({
        taskId: task.id,
        nodeCode: node.code,
        nodeName: node.name,
        reasons,
        warnings,
        completionBlockedBy,
        branchName: evidence?.git?.branch ?? task.branchName,
        pullRequest: evidence?.git?.pullRequest ?? approval?.pullRequest,
        approvalStatus: approval?.status
      });
    }
  }

  const lines = ["Review Queue:"];
  if (entries.length === 0) {
    lines.push("- None");
    return `${lines.join("\n")}\n`;
  }

  for (const item of entries.sort((a, b) => a.taskId.localeCompare(b.taskId))) {
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
    for (const reason of item.reasons) {
      lines.push(`  reason: ${reason}`);
    }
    for (const warning of item.warnings) {
      lines.push(`  warning: ${warning}`);
    }
    for (const blockedBy of item.completionBlockedBy) {
      lines.push(`  completionBlockedBy: ${blockedBy}`);
    }
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
