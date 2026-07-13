import { collectCheckIssues } from "./check.js";
import { buildReviewQueue } from "./review-queue.js";
import { buildNextTask } from "./ai-queue.js";
import { listTasks, evidenceExists, readBlock, readEvidence, reviewExists } from "../core/contracts.js";

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

export function buildNextAction(root: string): string {
  const stale = collectCheckIssues(root).find((issue) => {
    if (!issue.code.startsWith("task.contractLock")) return false;
    const taskId = taskIdFromMessage(issue.message);
    return !taskId || !hasActiveBlock(root, taskId);
  });
  if (stale) {
    const taskId = taskIdFromMessage(stale.message) ?? "<task-id>";
    return `Next suggested action:

Refresh stale task ${taskId}
Reason:
- ${stale.message}

Command:
  scwbs task refresh --task ${taskId}
`;
  }

  const missingEvidence = listTasks(root).find((entry) => entry.task && !hasActiveBlock(root, entry.task.id) && !evidenceExists(root, entry.task.id));
  if (missingEvidence?.task) {
    return `Next suggested action:

Collect evidence for ${missingEvidence.task.id}
Reason:
- Task has no Evidence file yet

Command:
  scwbs evidence collect --task ${missingEvidence.task.id}
`;
  }

  const failedCheck = listTasks(root).flatMap((entry) => {
    if (!entry.task) return [];
    if (hasActiveBlock(root, entry.task.id)) return [];
    const { evidence } = readEvidence(root, entry.task.id);
    const failed = evidence?.checks.find((check) => check.status === "failed");
    return failed ? [{ task: entry.task, checkName: failed.name }] : [];
  })[0];
  if (failedCheck) {
    return `Next suggested action:

Fix failed check for ${failedCheck.task.id}
Reason:
- Evidence check failed: ${failedCheck.checkName}

Command:
  scwbs finish --task ${failedCheck.task.id}
`;
  }

  const queue = buildReviewQueue(root);
  const reviewTask = taskIdsFromSection(queue, "Ready for completion review").find((taskId) => !hasActiveBlock(root, taskId));
  if (reviewTask) {
    if (reviewExists(root, reviewTask)) {
      return `Next suggested action:

Human review for ${reviewTask}
Reason:
- Evidence and review metadata exist; human completion review is next

Command:
  scwbs review-queue
`;
    }
    return `Next suggested action:

Review ${reviewTask}
Reason:
- Evidence exists and review queue has a candidate

Command:
  scwbs review request --task ${reviewTask}
`;
  }
  const blockedReviewTask = taskIdsFromSection(queue, "Blocked review candidates").find((taskId) => !hasActiveBlock(root, taskId));
  if (blockedReviewTask) {
    return `Next suggested action:

Review blocked candidates
Reason:
- Review candidates exist, but completion is blocked by prerequisites

Command:
  scwbs review-queue
`;
  }

  const nextTask = buildNextTask(root);
  return `Next suggested action:

${nextTask.trim() || "No available action."}
`;
}

export function runNext(root: string): number {
  try {
    process.stdout.write(buildNextAction(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
