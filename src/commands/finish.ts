import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { currentBranch } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { runCheckDiff } from "./check-diff.js";
import { runEvidenceCollect } from "./evidence-collect.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { readProfile } from "./profile.js";
import type { Profile } from "../core/types.js";

function inferTaskIdFromBranch(branch: string | undefined): string | undefined {
  const match = branch?.match(/(SCWBS-(?:DRAFT-)?[A-Z0-9-]+)/);
  return match?.[1];
}

function hasApprovedHumanGateApproval(root: string, taskId: string): boolean {
  const approval = readApproval(root, taskId).approval;
  if (approval?.status !== "approved") return false;
  const evidence = readEvidence(root, taskId).evidence;
  const evidenceHead = evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit;
  const evidenceDiffHash = evidence?.diffHash ?? evidence?.git?.diffHash;
  if (!approval.headCommit || !approval.diffHash || !evidenceHead || !evidenceDiffHash) return false;
  return approval.headCommit === evidenceHead && approval.diffHash === evidenceDiffHash;
}

export function runFinish(root: string, options: { taskId?: string; baseRef?: string; pullRequest?: string; force?: boolean; json?: boolean } = {}): number {
  const taskId = options.taskId ?? inferTaskIdFromBranch(currentBranch(root));
  if (!taskId) {
    console.error("Missing --task <task-id> and current branch does not contain a task id");
    console.error("fixCommand: npm run scwbs -- finish --task <task-id>");
    return 2;
  }

  const { task } = readTask(root, taskId);
  if (!task) {
    console.error(`Task contract ${taskId} not found`);
    return 1;
  }

  const evidenceExit = runEvidenceCollect(root, taskId, {
    force: options.force ?? true,
    baseRef: options.baseRef,
    pullRequest: options.pullRequest
  });
  if (evidenceExit !== 0) return evidenceExit;
  console.log("PASS required checks");
  console.log("PASS evidence collected");

  const { evidence } = readEvidence(root, taskId);
  const failedChecks = evidence?.checks.filter((check) => check.status !== "passed") ?? [];
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      console.error(`Check failed: ${check.name} (${check.command})`);
    }
    console.error("fixCommand: fix the failing checks, then run npm run scwbs -- finish --task <task-id>");
    return 1;
  }

  let checkDiffOutput = "";
  let diffExit: number;
  if (options.json) {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => { output.push(String(message)); };
    try {
      diffExit = runCheckDiff(root, taskId, { baseRef: options.baseRef, json: true });
    } finally {
      console.log = originalLog;
    }
    checkDiffOutput = output.join("\n");
  } else {
    diffExit = runCheckDiff(root, taskId, { baseRef: options.baseRef });
  }
  if (diffExit !== 0) return diffExit;
  console.log("PASS diff guard");

  const registryExit = runRegistryRebuild(root, { check: true, force: false });
  if (registryExit !== 0) {
    console.log("fixCommand: npm run scwbs -- registry rebuild --force, then re-run finish");
    return registryExit;
  }
  console.log("PASS registry check");

  const profile: Profile = readProfile(root);

  const humanGateFiles = task.humanGateRequiredPaths.filter((pattern) => {
    const files = evidence?.changedFiles ?? [];
    return files.some((file) => matchesAny(file, [pattern]));
  });

  const approval = readApproval(root, taskId).approval;
  const needsHumanGate = humanGateFiles.length > 0 && !hasApprovedHumanGateApproval(root, taskId);

  console.log(`Profile: ${profile}`);

  let nextAction = "";
  if (needsHumanGate) {
    console.log("");
    console.log("Human approval required:");
    for (const file of humanGateFiles) {
      console.log(`  - ${file}`);
    }
    console.log("");
    console.log("Next action:");
    console.log("  Human reviewer must run:");
    console.log(`  npm run scwbs -- approval approve --task ${taskId} --actor human --approved-by <name> --human-confirm`);
    nextAction = `npm run scwbs -- approval approve --task ${taskId} --actor human --approved-by <name> --human-confirm`;
  } else if (approval?.status === "requested" && humanGateFiles.length === 0) {
    console.log("");
    console.log("Next action:");
    console.log("  Human reviewer must review and approve:");
    console.log(`  npm run scwbs -- approval approve --task ${taskId} --actor human --approved-by <name> --human-confirm`);
    nextAction = `npm run scwbs -- approval approve --task ${taskId} --actor human --approved-by <name> --human-confirm`;
  } else {
    console.log("");
    console.log("Next action:");
    console.log("  Open a pull request and merge:");
    console.log(`  gh pr create --base main --title "feat: ${taskId}" --body ""`);
    nextAction = `gh pr create --base main --title "feat: ${taskId}" --body ""`;
  }

  if (options.json) {
    let checkDiffResult: { status?: string; issues?: unknown[] } = {};
    try {
      checkDiffResult = JSON.parse(checkDiffOutput || "{}");
    } catch {
      checkDiffResult = {};
    }
    console.log(JSON.stringify({
      status: "pass",
      taskId,
      requiresHumanApproval: needsHumanGate,
      changedFiles: evidence?.changedFiles ?? [],
      violations: checkDiffResult.issues ?? [],
      requiredChecks: evidence?.checks ?? [],
      evidencePath: `contracts/evidence/${taskId}.yaml`,
      approvalStatus: approval?.status ?? "",
      nextAction
    }, null, 2));
  }

  return 0;
}
