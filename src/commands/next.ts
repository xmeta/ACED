import { collectCheckIssues } from "./check.js";
import { buildReviewQueue } from "./review-queue.js";
import { buildNextTask } from "./ai-queue.js";
import { listTasks, evidenceExists } from "../core/contracts.js";

function taskIdFromMessage(message: string): string | undefined {
  return /\b[A-Z]+-\d+(?:-\d+)?\b/.exec(message)?.[0];
}

export function buildNextAction(root: string): string {
  const stale = collectCheckIssues(root).find((issue) => issue.code.startsWith("task.contractLock"));
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

  const missingEvidence = listTasks(root).find((entry) => entry.task && !evidenceExists(root, entry.task.id));
  if (missingEvidence?.task) {
    return `Next suggested action:

Collect evidence for ${missingEvidence.task.id}
Reason:
- Task has no Evidence file yet

Command:
  scwbs evidence collect --task ${missingEvidence.task.id}
`;
  }

  const queue = buildReviewQueue(root);
  const reviewTask = /^- ([A-Z]+-\d+(?:-\d+)?)/m.exec(queue)?.[1];
  if (reviewTask) {
    return `Next suggested action:

Review ${reviewTask}
Reason:
- Evidence exists and review queue has a candidate

Command:
  scwbs review request --task ${reviewTask}
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
