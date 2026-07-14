import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { branchChangedFiles, currentBranch } from "../core/git.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { evaluateWorkingTreeGuard, runCheckDiff } from "./check-diff.js";
import { runEvidenceCollect } from "./evidence-collect.js";
import { runRegistryRebuild } from "./registry-rebuild.js";
import { readProfile } from "./profile.js";
import type { Profile } from "../core/types.js";
import type { WorkingTreeState } from "../core/git.js";
import type { Evidence, Issue } from "../core/types.js";
import { collectTaskHealthIssues } from "./health.js";
import { taskRefreshReasons } from "./task-refresh.js";

export type FinishJsonOutput = {
  schemaVersion: "1.0.0";
  status: "pass" | "blocked";
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
  readinessWarnings: Array<{ code: string; message: string; fixCommand?: string }>;
  fixCommands: string[];
  workingTree?: WorkingTreeState;
};

type TestQuality = NonNullable<Evidence["testQuality"]>;

function readinessFixCommands(issues: Issue[]): string[] {
  return [...new Set(issues.flatMap((issue) => issue.fixCommand ? [issue.fixCommand] : []))];
}

function printReadinessIssues(issues: Issue[], json: boolean): void {
  const write = json ? console.error : console.log;
  write("Task readiness blocked:");
  for (const issue of issues) {
    write(`- ${issue.code}: ${issue.message}`);
    if (issue.fixCommand) write(`  fixCommand: ${issue.fixCommand}`);
  }
}

function collectFinishPreflightIssues(root: string, taskId: string, baseRef: string | undefined, testQuality: TestQuality | undefined): Issue[] {
  const { task } = readTask(root, taskId);
  if (!task) return [];
  const issues: Issue[] = [];
  if (!task.contractLock) {
    issues.push({ severity: "warn", code: "health.task.contractLock.missing", message: `${task.id} has no contractLock`, fixCommand: `npm run scwbs -- task lock --task ${task.id}` });
  } else {
    const reasons = taskRefreshReasons(root, taskId);
    if (reasons.length > 0) {
      issues.push({ severity: "warn", code: "health.task.contractLock.stale", message: `${task.id} contractLock is stale: ${reasons.join("; ")}`, fixCommand: `npm run scwbs -- task refresh --task ${task.id} --apply` });
    }
  }
  if (issues.length > 0) return issues;
  const changedTests = branchChangedFiles(root, baseRef ?? "origin/main")
    .some((file) => /(^|\/|\\)(tests?|__tests__)(\/|\\)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  const existingTestQuality = readEvidence(root, taskId).evidence?.testQuality;
  if (changedTests && !testQuality && !existingTestQuality) {
    issues.push({
      severity: "warn",
      code: "health.evidence.testQuality.missing",
      message: `${task.id} changes tests but Evidence testQuality metadata is missing`,
      fixCommand: `npm run scwbs -- finish --task ${task.id} --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Describe regression coverage"`
    });
  }
  return issues;
}

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

export function runFinish(root: string, options: { taskId?: string; baseRef?: string; pullRequest?: string; force?: boolean; json?: boolean; rerunChecks?: boolean; testQuality?: TestQuality } = {}): number {
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

  const preflightIssues = collectFinishPreflightIssues(root, taskId, options.baseRef, options.testQuality);
  if (preflightIssues.length > 0) {
    printReadinessIssues(preflightIssues, options.json ?? false);
    if (options.json) {
      const output: FinishJsonOutput = {
        schemaVersion: "1.0.0",
        status: "blocked",
        taskId,
        requiresHumanApproval: false,
        changedFiles: [],
        violations: [],
        requiredChecks: [],
        evidencePath: `contracts/evidence/${taskId}.yaml`,
        approvalStatus: readApproval(root, taskId).approval?.status ?? "",
        nextAction: preflightIssues[0]?.fixCommand ?? "Resolve task readiness warnings",
        readinessWarnings: preflightIssues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
        fixCommands: readinessFixCommands(preflightIssues)
      };
      console.log(JSON.stringify(output, null, 2));
    }
    return 1;
  }

  const workingTree = evaluateWorkingTreeGuard(root, taskId);
  if (workingTree.issues.length > 0) {
    printReadinessIssues(workingTree.issues, options.json ?? false);
    if (options.json) {
      const output: FinishJsonOutput = {
        schemaVersion: "1.0.0",
        status: "blocked",
        taskId,
        requiresHumanApproval: false,
        changedFiles: workingTree.state.changedFiles,
        violations: workingTree.issues,
        requiredChecks: [],
        evidencePath: `contracts/evidence/${taskId}.yaml`,
        approvalStatus: readApproval(root, taskId).approval?.status ?? "",
        nextAction: workingTree.issues[0]?.fixCommand ?? "Commit or stash working tree changes",
        readinessWarnings: workingTree.issues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
        fixCommands: readinessFixCommands(workingTree.issues),
        workingTree: workingTree.state
      };
      console.log(JSON.stringify(output, null, 2));
    }
    return 1;
  }

  const evidenceExit = runEvidenceCollect(root, taskId, {
    force: options.force ?? true,
    baseRef: options.baseRef,
    pullRequest: options.pullRequest,
    testQuality: options.testQuality,
    rerunChecks: options.rerunChecks,
    quiet: true
  });
  if (evidenceExit !== 0) return evidenceExit;

  const { evidence } = readEvidence(root, taskId);
  if (options.json) {
    console.error("PASS evidence collected");
  } else {
    console.log("PASS evidence collected");
  }
  const failedChecks = evidence?.checks.filter((check) => check.status !== "passed") ?? [];
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      console.error(`Check failed: ${check.name} (${check.command})`);
      if (check.stdoutSummary) console.error(`stdout:\n${check.stdoutSummary}`);
      if (check.stderrSummary) console.error(`stderr:\n${check.stderrSummary}`);
    }
    console.error("fixCommand: fix the failing checks, then run npm run scwbs -- finish --task <task-id>");
    return 1;
  }
  if (options.json) {
    console.error("PASS required checks");
  } else {
    console.log("PASS required checks");
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

  const readinessIssues = collectTaskHealthIssues(root, taskId);
  if (readinessIssues.length > 0) {
    printReadinessIssues(readinessIssues, options.json ?? false);
    if (!options.json) return 1;
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
      schemaVersion: "1.0.0",
      status: readinessIssues.length > 0 ? "blocked" : "pass",
      taskId,
      requiresHumanApproval: needsHumanGate,
      changedFiles: evidence?.changedFiles ?? [],
      violations: checkDiffResult.issues ?? [],
      requiredChecks: evidence?.checks ?? [],
      evidencePath: `contracts/evidence/${taskId}.yaml`,
      approvalStatus: approval?.status ?? "",
      nextAction: readinessIssues[0]?.fixCommand ?? nextAction,
      readinessWarnings: readinessIssues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
      fixCommands: readinessFixCommands(readinessIssues),
      ...(needsHumanGate ? { humanGateFiles, diffHash } : {})
    };
    console.log(JSON.stringify(output, null, 2));
  }

  return readinessIssues.length > 0 ? 1 : 0;
}
