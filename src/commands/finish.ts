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
  return `npm run scwbs -- approval approve --task ${taskId} --reason "Evidence and diff reviewed"`;
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

  const { result: evidenceExit } = runSilentIfJson(options.json ?? false, () =>
    runEvidenceCollect(root, taskId, {
      force: options.force ?? true,
      baseRef: options.baseRef,
      pullRequest: options.pullRequest
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
  if (diffExit !== 0) return diffExit;
  if (options.json) {
    console.error("PASS diff guard");
  } else {
    console.log("PASS diff guard");
  }

  const { result: registryExit } = runSilentIfJson(options.json ?? false, () =>
    runRegistryRebuild(root, { check: true, force: false })
  );
  if (registryExit !== 0) {
    const fixCommand = "fixCommand: npm run scwbs -- registry rebuild --force, then re-run finish";
    if (options.json) {
      console.error(fixCommand);
    } else {
      console.log(fixCommand);
    }
    return registryExit;
  }
  if (options.json) {
    console.error("PASS registry check");
  } else {
    console.log("PASS registry check");
  }

  const profile: Profile = readProfile(root);

  const approval = readApproval(root, taskId).approval;
  const humanGate = validateHumanGateApproval(task, evidence, approval, evidence?.changedFiles, root);
  const humanGateFiles = humanGate.requiredFiles;
  const needsHumanGate = humanGate.required && !humanGate.approved;

  let nextAction = "";
  if (options.json) {
    console.error(`Profile: ${profile}`);
    if (needsHumanGate) {
      console.error("");
      console.error("Human approval required:");
      for (const file of humanGateFiles) {
        console.error(`  - ${file}`);
      }
    }
    nextAction = needsHumanGate
      ? buildHumanApprovalCommand(taskId)
      : `gh pr create --base main --title "feat: ${taskId}" --body ""`;
  } else {
    console.log(`Profile: ${profile}`);
    if (needsHumanGate) {
      console.log("");
      console.log("Human approval required:");
      for (const file of humanGateFiles) {
        console.log(`  - ${file}`);
      }
      console.log("");
      console.log("Next action:");
      console.log("  Human reviewer must run:");
      console.log(`  ${buildHumanApprovalCommand(taskId)}`);
      nextAction = buildHumanApprovalCommand(taskId);
    } else {
      console.log("");
      console.log("Next action:");
      console.log("  Open a pull request and merge:");
      console.log(`  gh pr create --base main --title "feat: ${taskId}" --body ""`);
      nextAction = `gh pr create --base main --title "feat: ${taskId}" --body ""`;
    }
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
      nextAction
    };
    console.log(JSON.stringify(output, null, 2));
  }

  return 0;
}
