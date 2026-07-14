import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { branchChangedFiles, currentBranch } from "../core/git.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { recoverAtomicFileWrites, writeFilesAtomically, type AtomicFileWrite } from "../core/atomic-files.js";
import { gitCommonDir } from "../core/required-check-run.js";
import { defaultRegistryPath, evidencePath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { evaluateWorkingTreeGuard, runCheckDiff } from "./check-diff.js";
import { buildCollectedEvidence } from "./evidence-collect.js";
import { buildRegistryYaml, runRegistryRebuild } from "./registry-rebuild.js";
import { readProfile } from "./profile.js";
import type { Profile } from "../core/types.js";
import type { WorkingTreeState } from "../core/git.js";
import type { Evidence, Issue } from "../core/types.js";
import { collectTaskHealthIssues } from "./health.js";
import { taskRefreshReasons } from "./task-refresh.js";
import { printIssues } from "../core/report.js";

export type FinishPhase = "preflight" | "required-checks" | "validation" | "checkpoint" | "readiness" | "complete";
export type FinishOutcome =
  | "ready"
  | "readiness-blocked"
  | "required-check-failed"
  | "validation-failed"
  | "awaiting-human-approval"
  | "checkpoint-failed"
  | "completed";

export type FinishJsonOutput = {
  schemaVersion: "1.0.0";
  status: "pass" | "blocked";
  phase: FinishPhase;
  outcome: FinishOutcome;
  taskId: string;
  requiresHumanApproval: boolean;
  changedFiles: string[];
  violations: unknown[];
  requiredChecks: Array<{ name: string; status: string; source?: string; command?: string; executedAt?: string }>;
  evidencePath: string;
  approvalStatus: string;
  nextAction: string;
  resumeCommand: string;
  mutatedFiles: string[];
  humanGateFiles?: string[];
  diffHash?: string;
  readinessWarnings: Array<{ code: string; message: string; fixCommand?: string }>;
  fixCommands: string[];
  workingTree?: WorkingTreeState;
};

type TestQuality = NonNullable<Evidence["testQuality"]>;
type CheckpointWriter = (files: AtomicFileWrite[]) => string[];

type FinishOptions = {
  taskId?: string;
  baseRef?: string;
  pullRequest?: string;
  force?: boolean;
  json?: boolean;
  rerunChecks?: boolean;
  preflight?: boolean;
  testQuality?: TestQuality;
  checkpointWriter?: CheckpointWriter;
};

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
  const originalLog = console.log;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    chunks.push(`${args.map(String).join(" ")}\n`);
  };
  try {
    return { result: fn(), output: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

function runSilentIfJson<T>(json: boolean, fn: () => T): { result: T; output: string } {
  if (!json) return { result: fn(), output: "" };
  return captureStdout(fn);
}

function inferTaskIdFromBranch(branch: string | undefined): string | undefined {
  return branch?.match(/(SCWBS-(?:DRAFT-)?[A-Z0-9-]+)/)?.[1];
}

export function buildHumanApprovalCommand(taskId: string): string {
  return `npm run scwbs -- approval approve --task ${taskId} --actor human --reason "Evidence and diff reviewed"`;
}

function resumeFinishCommand(taskId: string): string {
  return `npm run scwbs -- finish --task ${taskId}`;
}

function finishJournalPath(root: string, taskId: string): string {
  return path.join(gitCommonDir(root), `scwbs-finish-${taskId}.journal.json`);
}

function finishOutput(input: Omit<FinishJsonOutput, "schemaVersion">): FinishJsonOutput {
  return { schemaVersion: "1.0.0", ...input };
}

function emitJson(output: FinishJsonOutput, enabled: boolean): void {
  if (enabled) console.log(JSON.stringify(output, null, 2));
}

function checkpointFinishMetadata(root: string, evidence: Evidence, writer: CheckpointWriter): string[] {
  const evidenceRelativePath = evidencePath(evidence.taskId);
  const registryYaml = buildRegistryYaml(root, { evidence });
  const writes = [
    {
      relativePath: evidenceRelativePath,
      path: resolveFrom(root, evidenceRelativePath),
      content: stringifySimpleYaml(evidence as unknown as Record<string, unknown>)
    },
    {
      relativePath: defaultRegistryPath,
      path: resolveFrom(root, defaultRegistryPath),
      content: registryYaml
    }
  ];
  const changedWrites = writes.filter((file) => !existsSync(file.path) || readFileSync(file.path, "utf8") !== file.content);
  writer(changedWrites.map(({ path, content }) => ({ path, content })));
  return changedWrites.map((file) => file.relativePath);
}

function printHumanGate(taskId: string, files: string[], diffHash: string): void {
  console.log("");
  console.log("Human approval required.");
  console.log("");
  console.log("Changed human-gated paths:");
  for (const file of files) console.log(`  - ${file}`);
  console.log("");
  console.log("Current diff hash:");
  console.log(`  ${diffHash}`);
  console.log("");
  console.log("Next action for human reviewer:");
  console.log(`  ${buildHumanApprovalCommand(taskId)}`);
  console.log("");
  console.log("AI agents must stop here.");
  console.log("Do not approve this task yourself.");
}

export function runFinish(root: string, options: FinishOptions = {}): number {
  const json = options.json ?? false;
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

  const evidenceRelativePath = evidencePath(taskId);
  const approvalStatus = () => readApproval(root, taskId).approval?.status ?? "";
  const journalPath = finishJournalPath(root, taskId);
  if (existsSync(journalPath) && options.preflight) {
    const nextAction = resumeFinishCommand(taskId);
    const issues: Issue[] = [{
      severity: "error",
      code: "finish.checkpoint.recovery-required",
      message: "An interrupted finish checkpoint must be recovered before preflight can continue",
      fixCommand: nextAction
    }];
    printReadinessIssues(issues, json);
    emitJson(finishOutput({
      status: "blocked", phase: "preflight", outcome: "readiness-blocked", taskId,
      requiresHumanApproval: false, changedFiles: [], violations: issues, requiredChecks: [],
      evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(), nextAction,
      resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: issues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
      fixCommands: [nextAction]
    }), json);
    return 1;
  }
  if (!options.preflight) {
    try {
      const recovered = recoverAtomicFileWrites(journalPath, [
        resolveFrom(root, evidenceRelativePath),
        resolveFrom(root, defaultRegistryPath)
      ]);
      if (recovered.length > 0) console.error(`Recovered interrupted finish checkpoint for ${taskId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAction = `Inspect and remove the invalid checkpoint journal: ${journalPath}`;
      console.error(message);
      emitJson(finishOutput({
        status: "blocked", phase: "checkpoint", outcome: "checkpoint-failed", taskId,
        requiresHumanApproval: false, changedFiles: [], violations: [{ message }], requiredChecks: [],
        evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(), nextAction,
        resumeCommand: nextAction, mutatedFiles: [], readinessWarnings: [], fixCommands: [nextAction]
      }), json);
      return 1;
    }
  }
  const preflightIssues = collectFinishPreflightIssues(root, taskId, options.baseRef, options.testQuality);
  if (preflightIssues.length > 0) {
    printReadinessIssues(preflightIssues, json);
    const nextAction = preflightIssues[0]?.fixCommand ?? "Resolve task readiness warnings";
    emitJson(finishOutput({
      status: "blocked", phase: "preflight", outcome: "readiness-blocked", taskId,
      requiresHumanApproval: false, changedFiles: [], violations: [], requiredChecks: [],
      evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(), nextAction,
      resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: preflightIssues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
      fixCommands: readinessFixCommands(preflightIssues)
    }), json);
    return 1;
  }

  const workingTree = evaluateWorkingTreeGuard(root, taskId);
  if (workingTree.issues.length > 0) {
    printReadinessIssues(workingTree.issues, json);
    const nextAction = workingTree.issues[0]?.fixCommand ?? "Commit or stash working tree changes";
    emitJson(finishOutput({
      status: "blocked", phase: "preflight", outcome: "readiness-blocked", taskId,
      requiresHumanApproval: false, changedFiles: workingTree.state.changedFiles,
      violations: workingTree.issues, requiredChecks: [], evidencePath: evidenceRelativePath,
      approvalStatus: approvalStatus(), nextAction, resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: workingTree.issues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
      fixCommands: readinessFixCommands(workingTree.issues), workingTree: workingTree.state
    }), json);
    return 1;
  }

  if (options.preflight) {
    const nextAction = resumeFinishCommand(taskId);
    if (!json) {
      console.log(`PASS finish preflight ${taskId}`);
      console.log(`plannedMutations: ${evidenceRelativePath}, ${defaultRegistryPath}`);
      console.log(`nextAction: ${nextAction}`);
    }
    emitJson(finishOutput({
      status: "pass", phase: "preflight", outcome: "ready", taskId,
      requiresHumanApproval: false, changedFiles: branchChangedFiles(root, options.baseRef ?? "origin/main"),
      violations: [], requiredChecks: [], evidencePath: evidenceRelativePath,
      approvalStatus: approvalStatus(), nextAction, resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: [], fixCommands: []
    }), json);
    return 0;
  }

  let evidence: Evidence;
  try {
    evidence = buildCollectedEvidence(root, taskId, {
      baseRef: options.baseRef,
      pullRequest: options.pullRequest,
      testQuality: options.testQuality,
      rerunChecks: options.rerunChecks
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    const nextAction = resumeFinishCommand(taskId);
    emitJson(finishOutput({
      status: "blocked", phase: "required-checks", outcome: "required-check-failed", taskId,
      requiresHumanApproval: false, changedFiles: [], violations: [{ message }], requiredChecks: [],
      evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(), nextAction,
      resumeCommand: nextAction, mutatedFiles: [], readinessWarnings: [], fixCommands: [nextAction]
    }), json);
    return 1;
  }

  if (json) console.error("PASS evidence candidate built");
  else console.log("PASS evidence candidate built");
  const failedChecks = evidence.checks.filter((check) => check.status !== "passed");
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      console.error(`Check failed: ${check.name} (${check.command})`);
      if (check.stdoutSummary) console.error(`stdout:\n${check.stdoutSummary}`);
      if (check.stderrSummary) console.error(`stderr:\n${check.stderrSummary}`);
    }
    const nextAction = resumeFinishCommand(taskId);
    console.error(`fixCommand: fix the failing checks, then run ${nextAction}`);
    emitJson(finishOutput({
      status: "blocked", phase: "required-checks", outcome: "required-check-failed", taskId,
      requiresHumanApproval: false, changedFiles: evidence.changedFiles, violations: failedChecks,
      requiredChecks: evidence.checks, evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(),
      nextAction, resumeCommand: nextAction, mutatedFiles: [], readinessWarnings: [], fixCommands: [nextAction]
    }), json);
    return 1;
  }
  if (json) console.error("PASS required checks");
  else console.log("PASS required checks");

  const { result: diffExit, output: checkDiffOutput } = captureStdout(() =>
    runCheckDiff(root, taskId, { baseRef: options.baseRef, json: true, evidence })
  );
  let checkDiffResult: { issues?: Issue[] } = {};
  try {
    checkDiffResult = JSON.parse(checkDiffOutput || "{}");
  } catch {
    checkDiffResult = { issues: [{ severity: "error", code: "diff.output", message: "check-diff returned invalid JSON" }] };
  }
  const diffIssues = checkDiffResult.issues ?? [];
  const humanGateIssues = diffIssues.filter((issue) => issue.code === "diff.humanGate");
  const nonHumanGateIssues = diffIssues.filter((issue) => issue.code !== "diff.humanGate");
  if (diffExit !== 0 && nonHumanGateIssues.length > 0) {
    if (!json) printIssues(diffIssues);
    const nextAction = nonHumanGateIssues[0]?.fixCommand ?? `npm run scwbs -- check-diff --task ${taskId}`;
    emitJson(finishOutput({
      status: "blocked", phase: "validation", outcome: "validation-failed", taskId,
      requiresHumanApproval: humanGateIssues.length > 0, changedFiles: evidence.changedFiles,
      violations: diffIssues, requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approvalStatus(), nextAction, resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: [], fixCommands: readinessFixCommands(nonHumanGateIssues)
    }), json);
    return 1;
  }
  if (humanGateIssues.length === 0) {
    if (json) console.error("PASS diff guard");
    else console.log("PASS diff guard");
  }

  let mutatedFiles: string[] = [];
  try {
    const writer = options.checkpointWriter
      ?? ((files: AtomicFileWrite[]) => writeFilesAtomically(files, { journalPath }));
    mutatedFiles = checkpointFinishMetadata(root, evidence, writer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`finish checkpoint failed: ${message}`);
    const nextAction = resumeFinishCommand(taskId);
    emitJson(finishOutput({
      status: "blocked", phase: "checkpoint", outcome: "checkpoint-failed", taskId,
      requiresHumanApproval: humanGateIssues.length > 0, changedFiles: evidence.changedFiles,
      violations: [{ message }], requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approvalStatus(), nextAction, resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: [], fixCommands: [nextAction]
    }), json);
    return 1;
  }
  if (json) console.error("PASS Evidence and registry checkpoint synchronized");
  else console.log("PASS registry synchronized");

  const { result: registryExit } = runSilentIfJson(json, () => runRegistryRebuild(root, { check: true, force: false }));
  if (registryExit !== 0) {
    const nextAction = resumeFinishCommand(taskId);
    emitJson(finishOutput({
      status: "blocked", phase: "checkpoint", outcome: "checkpoint-failed", taskId,
      requiresHumanApproval: humanGateIssues.length > 0, changedFiles: evidence.changedFiles,
      violations: [{ message: "Registry check failed after checkpoint" }], requiredChecks: evidence.checks,
      evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(), nextAction,
      resumeCommand: nextAction, mutatedFiles, readinessWarnings: [], fixCommands: [nextAction]
    }), json);
    return 1;
  }
  if (json) console.error("PASS registry check");

  const approval = readApproval(root, taskId).approval;
  const gate = validateHumanGateApproval(task, evidence, approval, evidence.changedFiles, root);
  const diffHash = evidence.diffHash ?? evidence.git?.diffHash ?? "(not recorded)";
  if (humanGateIssues.length > 0) {
    const approvalCommand = buildHumanApprovalCommand(taskId);
    if (!json) printHumanGate(taskId, gate.requiredFiles, diffHash);
    emitJson(finishOutput({
      status: "blocked", phase: "checkpoint", outcome: "awaiting-human-approval", taskId,
      requiresHumanApproval: true, changedFiles: evidence.changedFiles, violations: humanGateIssues,
      requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approval?.status ?? "", nextAction: approvalCommand, resumeCommand: approvalCommand,
      mutatedFiles, humanGateFiles: gate.requiredFiles, diffHash, readinessWarnings: [],
      fixCommands: [approvalCommand]
    }), json);
    return 1;
  }

  const readinessIssues = collectTaskHealthIssues(root, taskId);
  if (readinessIssues.length > 0) {
    printReadinessIssues(readinessIssues, json);
    const nextAction = readinessIssues[0]?.fixCommand ?? resumeFinishCommand(taskId);
    emitJson(finishOutput({
      status: "blocked", phase: "readiness", outcome: "readiness-blocked", taskId,
      requiresHumanApproval: false, changedFiles: evidence.changedFiles, violations: [],
      requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approval?.status ?? "", nextAction, resumeCommand: nextAction, mutatedFiles,
      readinessWarnings: readinessIssues.map(({ code, message, fixCommand }) => ({ code, message, ...(fixCommand ? { fixCommand } : {}) })),
      fixCommands: readinessFixCommands(readinessIssues)
    }), json);
    return 1;
  }

  const profile: Profile = readProfile(root);
  const prCommand = `gh pr create --base main --title "feat: ${taskId}" --body ""`;
  if (!json) {
    console.log(`Profile: ${profile}`);
    console.log("");
    console.log("Next action:");
    console.log("  Open a pull request and merge:");
    console.log(`  ${prCommand}`);
  }
  emitJson(finishOutput({
    status: "pass", phase: "complete", outcome: "completed", taskId,
    requiresHumanApproval: false, changedFiles: evidence.changedFiles, violations: [],
    requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
    approvalStatus: approval?.status ?? "", nextAction: prCommand, resumeCommand: prCommand,
    mutatedFiles, readinessWarnings: [], fixCommands: []
  }), json);
  return 0;
}
