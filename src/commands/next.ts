import { collectCheckIssues } from "./check.js";
import { buildReviewQueueSummary, reviewQueueNextAction, type ReviewQueueAction, type ReviewQueueEntry } from "./review-queue.js";
import { buildNextTask } from "./ai-queue.js";
import { listActiveTasks, evidenceExists, readBlock, readEvidence } from "../core/contracts.js";
import { discoveryNextLine, discoveryStateFromProbe, listDiscoveryProbes } from "../core/discovery.js";
import { readWbs } from "../core/wbs.js";

function hasActiveBlock(root: string, taskId: string): boolean {
  return readBlock(root, taskId).block?.status === "blocked";
}

function taskIdFromMessage(message: string): string | undefined {
  return /\b[A-Z]+-\d+(?:-\d+)?\b/.exec(message)?.[0];
}

function discoveryGuidance(root: string): string {
  const items = readWbs(root).nodes
    .filter((node) => node.workMode === "discovery" && node.discovery)
    .map((node) => discoveryNextLine(node.id, node.discovery!));
  for (const entry of listDiscoveryProbes(root)) {
    if (entry.probe) items.push(discoveryNextLine(entry.probe.id, discoveryStateFromProbe(entry.probe)));
  }
  return items.length === 0 ? "" : `Discovery readiness:\n${items.join("\n")}\n\n`;
}

export type NextJsonOutput = {
  version: "scwbs.next.v1";
  status: "actionable" | "waiting" | "idle";
  action: { kind: string; owner: "ai" | "human"; taskId?: string; command?: string; aiStop?: boolean } | null;
  reasons: Array<{ code: string; message: string }>;
};

function nextJsonAction(status: NextJsonOutput["status"], action: NextJsonOutput["action"], reasons: NextJsonOutput["reasons"]): NextJsonOutput {
  return { version: "scwbs.next.v1", status, action, reasons };
}

function plannedTaskJson(message: string): NextJsonOutput {
  return nextJsonAction("actionable", { kind: "select-planned-task", owner: "ai", command: "scwbs ai next-task" }, [{ code: "task.planned.available", message }]);
}

function queueEntries(root: string): ReviewQueueEntry[] {
  return buildReviewQueueSummary(root).candidates;
}

function inspectBlockedAction(): ReviewQueueAction {
  return { kind: "inspect-review-queue", owner: "ai", command: "scwbs review-queue", reasonCode: "review.blocked", reasonMessage: "Review candidates exist, but completion is blocked by prerequisites" };
}

function missingEvidenceAction(root: string): ReviewQueueAction | undefined {
  const task = listActiveTasks(root).find((entry) => entry.task && !hasActiveBlock(root, entry.task.id) && !evidenceExists(root, entry.task.id))?.task;
  if (!task) return undefined;
  return {
    kind: "collect-evidence",
    owner: "ai",
    taskId: task.id,
    command: `scwbs evidence collect --task ${task.id}`,
    reasonCode: "evidence.remediation.required",
    reasonMessage: `Collect evidence for ${task.id}`
  };
}

function hasActiveBlockEntry(root: string, entry: ReviewQueueEntry): boolean {
  return hasActiveBlock(root, entry.taskId) || entry.blockers.some((item) => item.code === "wbs.active-block");
}

function hasStructuralBlock(entry: ReviewQueueEntry): boolean {
  // A shared-node/graph/dependency blocker means this candidate cannot be
  // advanced by an Evidence or Review command. A merely not-yet-ready WBS
  // node still permits human review of the Evidence while completion waits.
  return entry.blockers.some((item) => item.phase === "graph" || item.phase === "dependency" || item.code === "wbs.shared-node-task")
    || entry.completionBlockedBy.some((item) => item.includes("multiple Task Contracts"));
}

/** Resolve navigation from the same structured queue entries used by review-queue. */
function queueNavigation(root: string): ReviewQueueAction | undefined {
  const entries = queueEntries(root);
  // Active Blocks and structural completion blockers remain visible in the
  // review queue, but neither may preempt an eligible lifecycle action.
  const actionable = entries.filter((entry) => !hasActiveBlockEntry(root, entry) && !hasStructuralBlock(entry));
  const missingEvidence = missingEvidenceAction(root);
  if (missingEvidence) return missingEvidence;
  const evidenceRemediation = actionable.find((entry) => entry.actionStage === "evidence-remediation");
  if (evidenceRemediation) return reviewQueueNextAction(evidenceRemediation);
  const refresh = actionable.find((entry) => entry.actionStage === "review-refresh");
  if (refresh) return reviewQueueNextAction(refresh);
  const request = actionable.find((entry) => entry.actionStage === "review-request");
  if (request) return reviewQueueNextAction(request);
  const humanReview = actionable.find((entry) => entry.actionStage === "human-review");
  if (humanReview) return reviewQueueNextAction(humanReview);
  const scopedApproval = actionable.find((entry) => entry.actionStage === "scoped-approval");
  if (scopedApproval) return reviewQueueNextAction(scopedApproval);
  const blocked = entries.find((entry) => !hasActiveBlockEntry(root, entry) && hasStructuralBlock(entry));
  if (blocked) return inspectBlockedAction();
  return undefined;
}

function queueActionJson(action: ReviewQueueAction): NextJsonOutput {
  return nextJsonAction(action.owner === "human" ? "waiting" : "actionable", { kind: action.kind, owner: action.owner, ...(action.taskId ? { taskId: action.taskId } : {}), command: action.command, ...(action.aiStop ? { aiStop: true } : {}) }, [{ code: action.reasonCode, message: action.reasonMessage }]);
}

function queueActionText(discovery: string, action: ReviewQueueAction): string {
  const label = action.kind === "human-review" ? "Human review" : action.kind === "inspect-review-queue" ? "Review blocked candidates" : action.kind === "refresh-review" ? "Refresh Review" : action.kind === "request-review" ? "Request Review" : action.kind === "request-approval" ? "Request scoped Approval" : action.reasonMessage.startsWith("Collect evidence for") ? action.reasonMessage : "Remediate Evidence";
  return `Next suggested action:\n\n${discovery}${label}\nReason:\n- ${action.reasonMessage}\n\nCommand:\n  ${action.command}\n`;
}

function staleTaskAction(root: string): { taskId: string; message: string; code: string } | undefined {
  const activeTasks = listActiveTasks(root);
  const activeTaskIds = activeTasks.flatMap((entry) => entry.task ? [entry.task.id] : []);
  const stale = collectCheckIssues(root).find((issue) => {
    if (!issue.code.startsWith("task.contractLock")) return false;
    const taskId = activeTaskIds.find((id) => issue.message.includes(id));
    return Boolean(taskId) && !hasActiveBlock(root, taskId!);
  });
  if (!stale) return undefined;
  return { taskId: activeTaskIds.find((id) => stale.message.includes(id)) ?? taskIdFromMessage(stale.message) ?? "<task-id>", message: stale.message, code: stale.code };
}

function failedCheckAction(root: string): { taskId: string; checkName: string } | undefined {
  return listActiveTasks(root).flatMap((entry) => {
    if (!entry.task || hasActiveBlock(root, entry.task.id)) return [];
    const { evidence } = readEvidence(root, entry.task.id);
    const failed = evidence?.checks.find((check) => check.status === "failed");
    return failed ? [{ taskId: entry.task.id, checkName: failed.name }] : [];
  })[0];
}

export function buildNextJsonOutput(root: string): NextJsonOutput {
  const stale = staleTaskAction(root);
  if (stale) return nextJsonAction("actionable", { kind: "refresh-task", owner: "ai", taskId: stale.taskId, command: `scwbs task refresh --task ${stale.taskId}` }, [{ code: stale.code, message: stale.message }]);
  const failedCheck = failedCheckAction(root);
  if (failedCheck) return nextJsonAction("actionable", { kind: "fix-check", owner: "ai", taskId: failedCheck.taskId, command: `scwbs finish --task ${failedCheck.taskId}` }, [{ code: "evidence.check.failed", message: `Evidence check failed: ${failedCheck.checkName}` }]);
  const queueAction = queueNavigation(root);
  if (queueAction?.kind === "inspect-review-queue") {
    const plannedTasks = buildNextTask(root).trim();
    if (plannedTasks && plannedTasks.startsWith("Planned task candidates:")) return plannedTaskJson(plannedTasks);
    return queueActionJson(queueAction);
  }
  if (queueAction) return queueActionJson(queueAction);
  const nextTask = buildNextTask(root).trim();
  if (nextTask.startsWith("Planned task candidates:")) return plannedTaskJson(nextTask);
  if (nextTask.startsWith("No available planned tasks.")) return nextJsonAction("idle", null, [{ code: "task.none.available", message: nextTask }]);
  return nextJsonAction("actionable", { kind: "inspect-next", owner: "ai", command: "scwbs next" }, [{ code: "task.follow_up.pending", message: nextTask || "No available action." }]);
}

export function buildNextAction(root: string): string {
  const discovery = discoveryGuidance(root);
  const stale = staleTaskAction(root);
  if (stale) return `Next suggested action:\n\n${discovery}Refresh stale task ${stale.taskId}\nReason:\n- ${stale.message}\n\nCommand:\n  scwbs task refresh --task ${stale.taskId}\n`;
  const failedCheck = failedCheckAction(root);
  if (failedCheck) return `Next suggested action:\n\n${discovery}Fix failed check for ${failedCheck.taskId}\nReason:\n- Evidence check failed: ${failedCheck.checkName}\n\nCommand:\n  scwbs finish --task ${failedCheck.taskId}\n`;
  const queueAction = queueNavigation(root);
  if (queueAction?.kind === "inspect-review-queue") {
    const plannedTasks = buildNextTask(root).trim();
    if (plannedTasks && plannedTasks.startsWith("Planned task candidates:")) return `Next suggested action:\n\n${discovery}${plannedTasks}\n`;
    return queueActionText(discovery, queueAction);
  }
  if (queueAction) return queueActionText(discovery, queueAction);
  const nextTask = buildNextTask(root);
  return `Next suggested action:\n\n${discovery}${nextTask.trim() || "No available action."}\n`;
}

export function runNext(root: string, options: { json?: boolean } = {}): number {
  try {
    if (options.json) console.log(JSON.stringify(buildNextJsonOutput(root)));
    else process.stdout.write(buildNextAction(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
