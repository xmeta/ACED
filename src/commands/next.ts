import { collectCheckIssues } from "./check.js";
import { buildReviewQueue } from "./review-queue.js";
import { buildNextTask } from "./ai-queue.js";
import { listTasks, evidenceExists, reviewExists } from "../core/contracts.js";

function taskIdFromMessage(message: string): string | undefined {
  return /\b[A-Z]+-\d+(?:-\d+)?\b/.exec(message)?.[0];
}

function taskIdFromSection(queue: string, heading: string): string | undefined {
  const section = new RegExp(`${heading}:\\n([\\s\\S]*?)(?:\\n\\n|$)`).exec(queue)?.[1] ?? "";
  return /^- ([A-Z]+-\d+(?:-\d+)?)/m.exec(section)?.[1];
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
  const reviewTask = taskIdFromSection(queue, "Ready for completion review");
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
  const blockedReviewTask = taskIdFromSection(queue, "Blocked review candidates");
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
