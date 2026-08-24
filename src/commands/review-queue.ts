import { readApproval, listActiveTasks, readEvidence, readReview } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { isNodeCompletionTask } from "../core/node-utils.js";
import { isDoneNode, readWbs } from "../core/wbs.js";
import { taskWbsAssociation } from "../core/task-wbs-policy.js";
import { evaluateCompletionReadiness, evidenceSubject, reviewSubjectMismatch, type CompletionBlocker, type CompletionTarget } from "./completion.js";

export type ReviewQueueEntry = {
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
  actionStage: "evidence-remediation" | "review-request" | "review-refresh" | "human-review" | "scoped-approval" | "completion-blocked" | "completion-ready" | "terminal";
  completionReady: boolean;
  blockers: CompletionBlocker[];
  omittedBlockerCount: number;
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

type NodeCompletionTarget = CompletionTarget;

type CausalAction = {
  stage: ReviewQueueEntry["actionStage"];
  blocker?: CompletionBlocker;
};

function reviewStatus(blocker: CompletionBlocker): string | undefined {
  return /^Review status is ([^;]+)/.exec(blocker.message)?.[1];
}

/** Select one causal blocker for both stage display and the next command. */
function selectCausalAction(blockers: CompletionBlocker[]): CausalAction {
  const evidence = blockers.find((item) => item.phase === "evidence");
  if (evidence) return { stage: "evidence-remediation", blocker: evidence };

  const reviewBlockers = blockers.filter((item) => item.phase === "review");
  const refresh = reviewBlockers.find((item) => item.code.includes("mismatch")
    || (item.code === "review.status" && reviewStatus(item) !== "requested"));
  if (refresh) return { stage: "review-refresh", blocker: refresh };
  const request = reviewBlockers.find((item) => item.code === "review.missing");
  if (request) return { stage: "review-request", blocker: request };
  const human = reviewBlockers.find((item) => item.code === "review.status" && reviewStatus(item) === "requested");
  if (human) return { stage: "human-review", blocker: human };

  const scopedApproval = blockers.find((item) => item.phase === "approval" || item.phase === "human-gate");
  if (scopedApproval) return { stage: "scoped-approval", blocker: scopedApproval };
  const structural = blockers.find((item) => item.phase === "graph" || item.phase === "wbs" || item.phase === "dependency");
  if (structural) return { stage: "completion-blocked", blocker: structural };
  return { stage: "completion-ready" };
}

function deriveActionStage(input: {
  evidence: ReturnType<typeof readEvidence>["evidence"];
  review: ReturnType<typeof readReview>["review"];
  blockers: CompletionBlocker[];
  hasEvidence: boolean;
  hasPullRequest: boolean;
  nodeCompletionTask: boolean;
  evidenceSubjectIncomplete: boolean;
  reviewSubjectStale: boolean;
}): ReviewQueueEntry["actionStage"] {
  // An active Block is a hard stop for this Task. Keep the entry visible for
  // queue diagnostics, but never expose its Evidence/Review lifecycle as an
  // executable next action.
  if (input.blockers.some((item) => item.code === "wbs.active-block")) return "completion-blocked";
  const evidence = input.blockers.find((item) => item.phase === "evidence");
  if (evidence) return "evidence-remediation";
  if (!input.hasEvidence || !input.hasPullRequest || input.evidenceSubjectIncomplete) return "evidence-remediation";
  if (!input.nodeCompletionTask) {
    if (!input.review) return "review-request";
    if (input.reviewSubjectStale) return "review-refresh";
    if (input.review.status === "requested") return "human-review";
    if (input.review.status === "changes-requested" || input.review.status === "closed") return "review-refresh";
  }
  const causal = selectCausalAction(input.blockers);
  if (causal.blocker) return causal.stage;
  return "completion-ready";
}

export function isHardCompletionBlock(entry: Pick<ReviewQueueEntry, "actionStage" | "blockers" | "completionBlockedBy">): boolean {
  if (entry.completionBlockedBy.some((item) => item.includes("multiple Task Contracts"))) return true;
  if (entry.actionStage === "review-request" || entry.actionStage === "human-review" || entry.actionStage === "review-refresh") return false;
  return entry.actionStage === "evidence-remediation" || entry.actionStage === "scoped-approval" || entry.actionStage === "completion-blocked" || entry.blockers.some((item) => item.phase === "graph" || item.phase === "wbs" || item.phase === "dependency");
}

export function collectReviewQueueEntries(root: string): ReviewQueueEntry[] {
  const wbs = readWbs(root);
  const entries: ReviewQueueEntry[] = [];
  const tasks = listActiveTasks(root);
  for (const entry of tasks) {
    const task = entry.task;
    if (!task) continue;
    const association = taskWbsAssociation(wbs, task);
    if (association.kind !== "node") continue;
    const node = association.node;

    const reasons: string[] = [];
    const warnings: string[] = [];
    const readiness = evaluateCompletionReadiness(root, task.id);
    // WBS/dependency blockers come only from the shared evaluator. This keeps
    // queue output and completion output in parity and avoids double-counting
    // the same dependency, active Block, or submodule failure.
    const completionBlockedBy = [...new Set(readiness.blockers
      .filter((item) => item.phase === "graph" || item.phase === "wbs" || item.phase === "dependency")
      .map((item) => item.message))];
    const nodeCompletionTargets = isNodeCompletionTask(task)
      ? { blockers: readiness.blockers, targets: readiness.targets as NodeCompletionTarget[] }
      : { blockers: [] as CompletionBlocker[], targets: [] as NodeCompletionTarget[] };
    const { evidence, issues } = readEvidence(root, task.id);
    const { approval, issues: approvalIssues } = readApproval(root, task.id);
    const { review, issues: reviewIssues } = readReview(root, task.id);
    const missingEvidenceOnly = issues.length === 1 && issues[0]?.code === "evidence.missing";
    const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
    const missingReviewOnly = reviewIssues.length === 1 && reviewIssues[0]?.code === "review.missing";
    const hasEvidence = Boolean(evidence) && !missingEvidenceOnly;
    const hasApproval = Boolean(approval) && !missingApprovalOnly;
    const hasReview = Boolean(review) && !missingReviewOnly;
    const subject = evidenceSubject(evidence);
    const evidenceSubjectIncomplete = hasEvidence && (!subject.pullRequest || !subject.headCommit || !subject.diffHash);
    const queueBlockers = [...readiness.blockers];
    if (evidenceSubjectIncomplete) {
      const missingSubject = [
        !subject.pullRequest ? "pullRequest" : undefined,
        !subject.headCommit ? "headCommit" : undefined,
        !subject.diffHash ? "diffHash" : undefined
      ].filter((item): item is string => Boolean(item));
      queueBlockers.push({
        code: "evidence.subject-incomplete",
        rootTaskId: task.id,
        taskId: task.id,
        phase: "evidence",
        message: `Evidence subject is incomplete: missing ${missingSubject.join(", ")}`
      });
    }
    const reviewSubjectStale = Boolean(review && hasReview && reviewSubjectMismatch(task.id, evidence, review).length > 0);
    // An approved Review is terminal for ordinary Tasks. Node-level completion
    // remains active until its scoped completion prerequisites are satisfied.
    const isTerminalReview = Boolean(review) && hasReview && review!.status === "approved" && !isNodeCompletionTask(task) && !reviewSubjectStale && !evidenceSubjectIncomplete;

    for (const submodule of evidence?.submodules ?? []) {
      warnings.push(`submodule ${submodule.path}: ${submodule.baseCommit} -> ${submodule.headCommit}; merge dependent PR ${submodule.pullRequest ?? "not recorded"} before parent PR; upstream target ${submodule.upstreamRef}`);
    }

    if (hasEvidence && !isDoneNode(node) && !isTerminalReview) {
      reasons.push(
        completionBlockedBy.length === 0
          ? "evidence exists and the WBS node is ready for human review"
          : "evidence exists and the WBS node is not completed"
      );
    }

    for (const item of readiness.blockers.filter((blocker) => blocker.phase === "wbs" || blocker.phase === "dependency")) {
      const warning = item.code === "wbs.dependency-not-completed" ? `dependsOn node ${item.message} is not completed` : item.message;
      if (!warnings.includes(warning)) warnings.push(warning);
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

    if (isTerminalReview) continue;

    const actionStage = deriveActionStage({ evidence, review, blockers: queueBlockers, hasEvidence, hasPullRequest: Boolean(evidence?.git?.pullRequest ?? approval?.pullRequest), nodeCompletionTask: isNodeCompletionTask(task), evidenceSubjectIncomplete, reviewSubjectStale });
    const evidenceRemediationCandidate = actionStage === "evidence-remediation" && queueBlockers.some((item) => item.phase === "evidence");
    const reviewRemediationCandidate = ["review-request", "review-refresh", "human-review"].includes(actionStage) && (isNodeCompletionTask(task) || hasReview || reviewSubjectStale);
    if (reasons.length > 0 || evidenceRemediationCandidate || reviewRemediationCandidate || actionStage === "scoped-approval" || (isNodeCompletionTask(task) && actionStage === "completion-blocked")) {
      const hasPullRequest = Boolean(evidence?.git?.pullRequest ?? approval?.pullRequest);
      const sharedNodeCompletionBlocked = completionBlockedBy.some((item) => item.includes("multiple Task Contracts"));
      const nodeCompletionTaskBlocked = isNodeCompletionTask(task) && completionBlockedBy.length > 0;
      const lifecycleBlocker = queueBlockers.some((item) => item.phase === "evidence" || item.phase === "review" || item.phase === "approval" || item.phase === "human-gate");
      const structuralBlocker = readiness.blockers.some((item) => item.phase === "graph" || item.phase === "wbs" || item.phase === "dependency") || completionBlockedBy.some((item) => item.includes("multiple Task Contracts"));
      const structuralSuggestedAction = nodeCompletionTaskBlocked
        ? "review evidence now, but defer node completion until the completion targets are ready"
        : sharedNodeCompletionBlocked
          ? "review evidence now, but defer WBS completion to a dedicated node-level completion task"
          : "review evidence now, but defer completion until dependencies are completed";
      const suggestedAction = actionStage === "evidence-remediation"
        ? structuralBlocker
          ? structuralSuggestedAction
          : !hasPullRequest
            ? "create or record PR, then human review for completion"
            : "remediate Evidence before requesting or approving Review"
        : actionStage === "human-review"
          ? structuralBlocker ? "human review for completion; defer completion until prerequisites are ready" : "human review for completion"
        : actionStage === "review-request"
          ? "request review for this task"
        : actionStage === "review-refresh"
          ? "refresh the Review request against current Evidence"
        : actionStage === "scoped-approval"
          ? "request the missing scoped Approval action"
        : structuralBlocker
          ? structuralSuggestedAction
        : (!lifecycleBlocker && completionBlockedBy.length > 0)
          ? "review evidence now, but defer completion until dependencies are completed"
          : !hasPullRequest
            ? "create or record PR, then human review for completion"
            : "completion-ready";
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
        suggestedAction,
        actionStage,
        completionReady: readiness.canApply,
        blockers: queueBlockers,
        omittedBlockerCount: readiness.omittedBlockerCount
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
    const structuredMessages = new Set(entry.blockers.map((item) => item.message));
    for (const blocker of entry.blockers) {
      counts.set(blocker.code, (counts.get(blocker.code) ?? 0) + 1);
    }
    for (const blocker of entry.completionBlockedBy) {
      if (structuredMessages.has(blocker)) continue;
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
    const readyDifference = Number(isHardCompletionBlock(a)) - Number(isHardCompletionBlock(b));
    if (readyDifference !== 0) return readyDifference;
    const pullRequestDifference = Number(!a.pullRequest) - Number(!b.pullRequest);
    return pullRequestDifference || a.taskId.localeCompare(b.taskId);
  });
}

export type ReviewQueueAction = {
  kind: "collect-evidence" | "request-review" | "refresh-review" | "human-review" | "request-approval" | "inspect-review-queue";
  owner: "ai" | "human";
  taskId?: string;
  command: string;
  aiStop?: boolean;
  reasonCode: string;
  reasonMessage: string;
};

export function reviewQueueNextAction(entry: ReviewQueueEntry): ReviewQueueAction {
  const causal = selectCausalAction(entry.blockers).blocker;
  const reviewTaskId = causal?.phase === "review"
    ? causal.taskId
    : entry.blockers.find((item) => item.phase === "review")?.taskId ?? entry.taskId;
  const scopedBlocker = causal?.phase === "approval" || causal?.phase === "human-gate"
    ? causal
    : entry.blockers.find((item) => item.phase === "approval" || item.phase === "human-gate");
  if (entry.actionStage === "evidence-remediation") {
    const evidenceBlocker = causal?.phase === "evidence"
      ? causal
      : entry.blockers.find((item) => item.phase === "evidence");
    const evidenceTaskId = evidenceBlocker?.taskId ?? entry.taskId;
    const refreshExistingEvidence = Boolean(evidenceBlocker && (
      evidenceBlocker.code !== "evidence.invalid"
      || !evidenceBlocker.message.includes("(evidence.missing)")
    ));
    return {
      kind: "collect-evidence", owner: "ai", taskId: evidenceTaskId,
      command: `scwbs evidence collect --task ${evidenceTaskId}${refreshExistingEvidence ? " --force" : ""}`,
      reasonCode: "evidence.remediation.required",
      reasonMessage: entry.suggestedAction
    };
  }
  if (entry.actionStage === "review-request") {
    return { kind: "request-review", owner: "ai", taskId: reviewTaskId, command: `scwbs review request --task ${reviewTaskId}`, reasonCode: "review.request_missing", reasonMessage: entry.suggestedAction };
  }
  if (entry.actionStage === "review-refresh") {
    return { kind: "refresh-review", owner: "ai", taskId: reviewTaskId, command: `scwbs review request --task ${reviewTaskId} --force`, reasonCode: "review.refresh_required", reasonMessage: entry.suggestedAction };
  }
  if (entry.actionStage === "human-review" && (entry.reviewStatus === "requested" || entry.blockers.some((item) => item.code === "review.status"))) {
    return { kind: "human-review", owner: "human", taskId: reviewTaskId, command: `scwbs review approve --task ${reviewTaskId} --actor human`, aiStop: true, reasonCode: "review.human_decision_required", reasonMessage: entry.suggestedAction };
  }
  if (entry.actionStage === "scoped-approval") {
    const scope = scopedBlocker?.scope ?? "post-finish";
    const taskId = scopedBlocker?.taskId ?? entry.taskId;
    const missingArtifact = scopedBlocker?.code === "approval.post-finish-missing"
      && (scopedBlocker.message.includes("(approval.missing)") || scopedBlocker.message.includes("(approval.scope.missing)"));
    return {
      kind: "request-approval",
      owner: "ai",
      taskId,
      command: `scwbs request-approval --task ${taskId} --scope ${scope}${missingArtifact ? "" : " --force"}`,
      reasonCode: "approval.scoped_action_required",
      reasonMessage: entry.suggestedAction
    };
  }
  return { kind: "inspect-review-queue", owner: "ai", command: "scwbs review-queue", reasonCode: "review.blocked", reasonMessage: entry.suggestedAction };
}

function candidateNextCommand(entry: ReviewQueueEntry): string {
  return reviewQueueNextAction(entry).command;
}

export function buildReviewQueueSummary(root: string, limit?: number): ReviewQueueSummary {
  const entries = collectReviewQueueEntries(root);
  const prioritized = prioritizeEntries(entries);
  const selected = limit === undefined ? prioritized : prioritized.slice(0, limit);
  const blocked = entries.filter((entry) => isHardCompletionBlock(entry)).length;
  return {
    schemaVersion: "1.0.0",
    health: {
      candidates: entries.length,
      missingPullRequest: entries.filter((entry) => !entry.pullRequest).length,
      blocked,
      ready: entries.filter((entry) => entry.completionReady).length
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
      const state = entry.completionReady ? "completion-ready" : entry.actionStage;
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
  const blockedCount = sortedEntries.filter((item) => isHardCompletionBlock(item)).length;
  const readyCount = sortedEntries.filter((item) => item.completionReady).length;

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
    lines.push(`  actionStage: ${item.actionStage}`);
    lines.push(`  completionReady: ${item.completionReady}`);
    for (const reason of item.reasons) {
      lines.push(`  reason: ${reason}`);
    }
    for (const warning of item.warnings) {
      lines.push(`  warning: ${warning}`);
    }
    for (const blockedBy of item.completionBlockedBy) {
      lines.push(`  completionBlockedBy: ${blockedBy}`);
    }
    for (const itemBlocker of item.blockers) {
      lines.push(`  blocker: [${itemBlocker.code}] ${itemBlocker.message}`);
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

  const readyEntries = sortedEntries.filter((item) => item.completionReady);
  const humanReviewEntries = sortedEntries.filter((item) => item.actionStage === "human-review");
  const blockedEntries = sortedEntries.filter((item) => isHardCompletionBlock(item));
  const missingPullRequestEntries = sortedEntries.filter((item) => !item.pullRequest);

  lines.push("");
  lines.push("Ready for completion review:");
  if (readyEntries.length === 0) {
    if (humanReviewEntries.length === 0) lines.push("- None");
    else for (const item of humanReviewEntries) lines.push(`- ${item.taskId} (human review; completion prerequisites remain) `);
  } else {
    for (const item of readyEntries) lines.push(`- ${item.taskId}`);
    for (const item of humanReviewEntries) if (!readyEntries.some((ready) => ready.taskId === item.taskId)) lines.push(`- ${item.taskId} (human review; completion prerequisites remain)`);
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
