import { collectCheckIssues } from "./check.js";
import { buildReviewQueue } from "./review-queue.js";
import { buildNextTask } from "./ai-queue.js";
import { listActiveTasks, evidenceExists, readBlock, readEvidence, readReview, reviewExists } from "../core/contracts.js";
import { discoveryNextLine, discoveryStateFromProbe, listDiscoveryProbes } from "../core/discovery.js";
import { readWbs } from "../core/wbs.js";

function hasActiveBlock(root: string, taskId: string): boolean {
  return readBlock(root, taskId).block?.status === "blocked";
}

function taskIdFromMessage(message: string): string | undefined {
  return /\b[A-Z]+-\d+(?:-\d+)?\b/.exec(message)?.[0];
}

function taskIdsFromSection(queue: string, heading: string): string[] {
  const section = new RegExp(`${heading}:\\n([\\s\\S]*?)(?:\\n\\n|$)`).exec(queue)?.[1] ?? "";
  return [...section.matchAll(/^- ([A-Z]+-\d+(?:-\d+)?)/gm)].map((match) => match[1]!);
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
  action: {
    kind: string;
    owner: "ai" | "human";
    taskId?: string;
    command?: string;
    aiStop?: boolean;
  } | null;
  reasons: Array<{ code: string; message: string }>;
};

function nextJsonAction(
  status: NextJsonOutput["status"],
  action: NextJsonOutput["action"],
  reasons: NextJsonOutput["reasons"]
): NextJsonOutput {
  return { version: "scwbs.next.v1", status, action, reasons };
}

function plannedTaskJson(message: string): NextJsonOutput {
  return nextJsonAction("actionable", {
    kind: "select-planned-task",
    owner: "ai",
    command: "scwbs ai next-task"
  }, [{ code: "task.planned.available", message }]);
}

export function buildNextJsonOutput(root: string): NextJsonOutput {
  const activeTasks = listActiveTasks(root);
  const activeTaskIds = activeTasks.flatMap((entry) => entry.task ? [entry.task.id] : []);
  const stale = collectCheckIssues(root).find((issue) => {
    if (!issue.code.startsWith("task.contractLock")) return false;
    const taskId = activeTaskIds.find((id) => issue.message.includes(id));
    return Boolean(taskId) && !hasActiveBlock(root, taskId!);
  });
  if (stale) {
    const taskId = activeTaskIds.find((id) => stale.message.includes(id)) ?? taskIdFromMessage(stale.message) ?? "<task-id>";
    return nextJsonAction("actionable", {
      kind: "refresh-task",
      owner: "ai",
      taskId,
      command: `scwbs task refresh --task ${taskId}`
    }, [{ code: stale.code, message: stale.message }]);
  }

  const failedCheck = activeTasks.flatMap((entry) => {
    if (!entry.task || hasActiveBlock(root, entry.task.id)) return [];
    const { evidence } = readEvidence(root, entry.task.id);
    const failed = evidence?.checks.find((check) => check.status === "failed");
    return failed ? [{ task: entry.task, checkName: failed.name }] : [];
  })[0];
  if (failedCheck) {
    return nextJsonAction("actionable", {
      kind: "fix-check",
      owner: "ai",
      taskId: failedCheck.task.id,
      command: `scwbs finish --task ${failedCheck.task.id}`
    }, [{ code: "evidence.check.failed", message: `Evidence check failed: ${failedCheck.checkName}` }]);
  }

  const queue = buildReviewQueue(root);
  const blockedReviewTask = taskIdsFromSection(queue, "Blocked review candidates").find((taskId) => !hasActiveBlock(root, taskId));
  if (blockedReviewTask) {
    const plannedTasks = buildNextTask(root).trim();
    if (plannedTasks && plannedTasks.startsWith("Planned task candidates:")) return plannedTaskJson(plannedTasks);
    return nextJsonAction("actionable", {
      kind: "inspect-review-queue",
      owner: "ai",
      command: "scwbs review-queue"
    }, [{ code: "review.blocked", message: "Review candidates exist, but completion is blocked by prerequisites" }]);
  }

  const missingEvidence = activeTasks.find((entry) => entry.task && !hasActiveBlock(root, entry.task.id) && !evidenceExists(root, entry.task.id));
  if (missingEvidence?.task) {
    return nextJsonAction("actionable", {
      kind: "collect-evidence",
      owner: "ai",
      taskId: missingEvidence.task.id,
      command: `scwbs evidence collect --task ${missingEvidence.task.id}`
    }, [{ code: "evidence.missing", message: "Task has no Evidence file yet" }]);
  }

  const reviewTask = taskIdsFromSection(queue, "Ready for completion review").find((taskId) => !hasActiveBlock(root, taskId));
  if (reviewTask) {
    if (reviewExists(root, reviewTask)) {
      const { review } = readReview(root, reviewTask);
      if (review?.status === "requested") {
        return nextJsonAction("waiting", {
          kind: "human-review",
          owner: "human",
          taskId: reviewTask,
          command: `scwbs review approve --task ${reviewTask} --actor human`,
          aiStop: true
        }, [{ code: "review.human_decision_required", message: "Evidence and review metadata exist; human completion review is next" }]);
      }
      return nextJsonAction("waiting", {
        kind: "human-review",
        owner: "human",
        taskId: reviewTask,
        command: "scwbs review-queue",
        aiStop: true
      }, [{ code: "review.human_decision_required", message: "Evidence exists and human completion review is next" }]);
    }
    return nextJsonAction("actionable", {
      kind: "request-review",
      owner: "ai",
      taskId: reviewTask,
      command: `scwbs review request --task ${reviewTask}`
    }, [{ code: "review.request_missing", message: "Evidence exists and a review request is needed" }]);
  }

  const nextTask = buildNextTask(root).trim();
  if (nextTask.startsWith("Planned task candidates:")) return plannedTaskJson(nextTask);
  if (nextTask.startsWith("No available planned tasks.")) {
    return nextJsonAction("idle", null, [{ code: "task.none.available", message: nextTask }]);
  }
  return nextJsonAction("actionable", {
    kind: "inspect-next",
    owner: "ai",
    command: "scwbs next"
  }, [{ code: "task.follow_up.pending", message: nextTask || "No available action." }]);
}

export function buildNextAction(root: string): string {
  const discovery = discoveryGuidance(root);
  const activeTasks = listActiveTasks(root);
  const activeTaskIds = activeTasks.flatMap((entry) => entry.task ? [entry.task.id] : []);
  const stale = collectCheckIssues(root).find((issue) => {
    if (!issue.code.startsWith("task.contractLock")) return false;
    const taskId = activeTaskIds.find((id) => issue.message.includes(id));
    return Boolean(taskId) && !hasActiveBlock(root, taskId!);
  });
  if (stale) {
    const taskId = activeTaskIds.find((id) => stale.message.includes(id)) ?? taskIdFromMessage(stale.message) ?? "<task-id>";
    return `Next suggested action:

${discovery}Refresh stale task ${taskId}
Reason:
- ${stale.message}

Command:
  scwbs task refresh --task ${taskId}
`;
  }

  const failedCheck = activeTasks.flatMap((entry) => {
    if (!entry.task) return [];
    if (hasActiveBlock(root, entry.task.id)) return [];
    const { evidence } = readEvidence(root, entry.task.id);
    const failed = evidence?.checks.find((check) => check.status === "failed");
    return failed ? [{ task: entry.task, checkName: failed.name }] : [];
  })[0];
  if (failedCheck) {
    return `Next suggested action:

${discovery}Fix failed check for ${failedCheck.task.id}
Reason:
- Evidence check failed: ${failedCheck.checkName}

Command:
  scwbs finish --task ${failedCheck.task.id}
`;
  }

  const queue = buildReviewQueue(root);
  const blockedReviewTask = taskIdsFromSection(queue, "Blocked review candidates").find((taskId) => !hasActiveBlock(root, taskId));
  if (blockedReviewTask) {
    const plannedTasks = buildNextTask(root).trim();
    if (plannedTasks && plannedTasks.startsWith("Planned task candidates:")) {
      return `Next suggested action:

${discovery}${plannedTasks}
`;
    }
    return `Next suggested action:

${discovery}Review blocked candidates
Reason:
- Review candidates exist, but completion is blocked by prerequisites

Command:
  scwbs review-queue
`;
  }

  const missingEvidence = activeTasks.find((entry) => entry.task && !hasActiveBlock(root, entry.task.id) && !evidenceExists(root, entry.task.id));
  if (missingEvidence?.task) {
    return `Next suggested action:

${discovery}Collect evidence for ${missingEvidence.task.id}
Reason:
- Task has no Evidence file yet

Command:
  scwbs evidence collect --task ${missingEvidence.task.id}
`;
  }

  const reviewTask = taskIdsFromSection(queue, "Ready for completion review").find((taskId) => !hasActiveBlock(root, taskId));
  if (reviewTask) {
    if (reviewExists(root, reviewTask)) {
      const { review } = readReview(root, reviewTask);
      if (review?.status === "requested") {
        return `Next suggested action:

${discovery}Human review for ${reviewTask}
Reason:
- Evidence and review metadata exist; review decision is next

Command:
  scwbs review approve --task ${reviewTask} --actor human

Queue context:
  scwbs review-queue
`;
      }
      return `Next suggested action:

${discovery}Human review for ${reviewTask}
Reason:
- Evidence and review metadata exist; human completion review is next

Command:
  scwbs review-queue
`;
    }
    return `Next suggested action:

${discovery}Review ${reviewTask}
Reason:
- Evidence exists and review queue has a candidate

Command:
  scwbs review request --task ${reviewTask}
`;
  }

  const nextTask = buildNextTask(root);
  return `Next suggested action:

${discovery}${nextTask.trim() || "No available action."}
`;
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
