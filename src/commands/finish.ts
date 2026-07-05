import { runCheckDiff } from "./check-diff.js";
import { runEvidenceCollect } from "./evidence-collect.js";
import { readEvidence } from "../core/contracts.js";
import { currentBranch } from "../core/git.js";

function inferTaskIdFromBranch(branch: string | undefined): string | undefined {
  const match = branch?.match(/(SCWBS-(?:DRAFT-)?[A-Z0-9-]+)/);
  return match?.[1];
}

export function runFinish(root: string, options: { taskId?: string; baseRef?: string; pullRequest?: string; force?: boolean } = {}): number {
  const taskId = options.taskId ?? inferTaskIdFromBranch(currentBranch(root));
  if (!taskId) {
    console.error("Missing --task <task-id> and current branch does not contain a task id");
    console.error("fixCommand: npm run scwbs -- finish --task <task-id>");
    return 2;
  }

  const evidenceExit = runEvidenceCollect(root, taskId, {
    force: options.force ?? true,
    baseRef: options.baseRef,
    pullRequest: options.pullRequest
  });
  if (evidenceExit !== 0) return evidenceExit;
  const { evidence } = readEvidence(root, taskId);
  const failedChecks = evidence?.checks.filter((check) => check.status !== "passed") ?? [];
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      console.error(`Check failed: ${check.name} (${check.command})`);
    }
    console.error("fixCommand: fix the failing checks, then run npm run scwbs -- finish --task <task-id>");
    return 1;
  }
  return runCheckDiff(root, taskId, { baseRef: options.baseRef });
}
