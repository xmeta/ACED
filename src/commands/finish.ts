import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { currentBranch } from "../core/git.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { runCheckDiff } from "./check-diff.js";
import { runEvidenceCollect } from "./evidence-collect.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { readProfile } from "./profile.js";
import type { Profile } from "../core/types.js";

export type FinishJsonOutput = {
  status: "pass";
  taskId: string;
  requiresHumanApproval: boolean;
  changedFiles: string[];
  violations: unknown[];
  requiredChecks: Array<{ name: string; status: string; source?: string; command?: string; executedAt?: string }>;
  evidencePath: string;
  approvalStatus: string;
  nextAction: string;
  humanGateFiles?: string[];
  diffHash?: string;
};

function captureStdout<T>(fn: () => T): { result: T; output: string } {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = fn();
    return { result, output: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function runSilentIfJson<T>(json: boolean, fn: () => T): { result: T; output: string } {
  if (!json) {
    return { result: fn(), output: "" };
  }
  return captureStdout(fn);
}

function inferTaskIdFromBranch(branch: string | undefined): string | undefined {
  const match = branch?.match(/(SCWBS-(?:DRAFT-)?[A-Z0-9-]+)/);
  return match?.[1];
}

export function buildHumanApprovalCommand(taskId: string): string {
  return `npm run scwbs -- approval approve --task ${taskId} --actor human --reason "Evidence and diff reviewed"`;
}

export function runFinish(root: string, options: { taskId?: string; baseRef?: string; pullRequest?: string; force?: boolean; json?: boolean; rerunChecks?: boolean } = {}): number {
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

  const { result: evidenceExit } = runSilentIfJson(options.json ?? false, () =>
    runEvidenceCollect(root, taskId, {
      force: options.force ?? true,
      baseRef: options.baseRef,
      pullRequest: options.pullRequest,
      rerunChecks: options.rerunChecks
    })
  );
  if (evidenceExit !== 0) return evidenceExit;
  if (options.json) {
    console.error("PASS required checks");
    console.error("PASS evidence collected");
  } else {
    console.log("PASS required checks");
    console.log("PASS evidence collected");
  }

  const { evidence } = readEvidence(root, taskId);
  const failedChecks = evidence?.checks.filter((check) => check.status !== "passed") ?? [];
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      console.error(`Check failed: ${check.name} (${check.command})`);
    }
    console.error("fixCommand: fix the failing checks, then run npm run scwbs -- finish --task <task-id>");
    return 1;
  }

  const { result: diffExit, output: checkDiffOutput } = runSilentIfJson(options.json ?? false, () =>
    runCheckDiff(root, taskId, { baseRef: options.baseRef, json: options.json ?? false })
  );

  const profile: Profile = readProfile(root);
  const approval = readApproval(root, taskId).approval;
  const humanGate = validateHumanGateApproval(task, evidence, approval, evidence?.changedFiles, root);
  const humanGateFiles = humanGate.requiredFiles;
  const needsHumanGate = humanGate.required && !humanGate.approved;
  const diffHash = evidence?.diffHash ?? evidence?.git?.diffHash ?? "(not recorded)";

  const approvalCommand = buildHumanApprovalCommand(taskId);
  const prCommand = `gh pr create --base main --title "feat: ${taskId}" --body ""`;
  let nextAction = needsHumanGate ? approvalCommand : prCommand;

  if (options.json) {
    console.error(`Profile: ${profile}`);
    if (needsHumanGate) {
      console.error("");
      console.error("Human approval required.");
      console.error("");
      console.error("Changed human-gated paths:");
      for (const file of humanGateFiles) {
        console.error(`  - ${file}`);
      }
      console.error("");
      console.error("Current diff hash:");
      console.error(`  ${diffHash}`);
      console.error("");
      console.error("Next action for human reviewer:");
      console.error(`  ${approvalCommand}`);
      console.error("");
      console.error("AI agents must stop here.");
      console.error("Do not approve this task yourself.");
    }
  } else {
    if (needsHumanGate) {
      console.log("");
      console.log("Human approval required.");
      console.log("");
      console.log("Changed human-gated paths:");
      for (const file of humanGateFiles) {
        console.log(`  - ${file}`);
      }
      console.log("");
      console.log("Current diff hash:");
      console.log(`  ${diffHash}`);
      console.log("");
      console.log("Next action for human reviewer:");
      console.log(`  ${approvalCommand}`);
      console.log("");
      console.log("AI agents must stop here.");
      console.log("Do not approve this task yourself.");
    }
  }

  if (diffExit !== 0) return diffExit;
  if (options.json) {
    console.error("PASS diff guard");
  } else {
    console.log("PASS diff guard");
  }

  const { result: registryWriteExit } = captureStdout(() =>
    runRegistryRebuild(root, { check: false, force: true })
  );
  if (registryWriteExit !== 0) return registryWriteExit;
  if (options.json) {
    console.error("PASS registry synchronized");
  } else {
    console.log("PASS registry synchronized");
  }
  const { result: registryExit } = runSilentIfJson(options.json ?? false, () =>
    runRegistryRebuild(root, { check: true, force: false })
  );
  if (registryExit !== 0) return registryExit;
  if (options.json) {
    console.error("PASS registry check");
  } else {
    console.log("PASS registry check");
  }

  if (!options.json && !needsHumanGate) {
    console.log(`Profile: ${profile}`);
    console.log("");
    console.log("Next action:");
    console.log("  Open a pull request and merge:");
    console.log(`  ${prCommand}`);
  }

  if (options.json) {
    let checkDiffResult: { status?: string; issues?: unknown[] } = {};
    try {
      checkDiffResult = JSON.parse(checkDiffOutput || "{}");
    } catch {
      checkDiffResult = {};
    }
    const output: FinishJsonOutput = {
      status: "pass",
      taskId,
      requiresHumanApproval: needsHumanGate,
      changedFiles: evidence?.changedFiles ?? [],
      violations: checkDiffResult.issues ?? [],
      requiredChecks: evidence?.checks ?? [],
      evidencePath: `contracts/evidence/${taskId}.yaml`,
      approvalStatus: approval?.status ?? "",
      nextAction,
      ...(needsHumanGate ? { humanGateFiles, diffHash } : {})
    };
    console.log(JSON.stringify(output, null, 2));
  }

  return 0;
}
