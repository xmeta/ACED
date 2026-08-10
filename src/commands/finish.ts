import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readApproval, readEvidence, readReview, readTask } from "../core/contracts.js";
import { branchChangedFiles, buildPatchArtifact, currentBranch } from "../core/git.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { gitCommonDir } from "../core/required-check-run.js";
import { defaultRegistryPath, evidencePath, evidencePayloadPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { buildHumanGateActionOwnership, evaluateWorkingTreeGuard, runCheckDiff, type HumanGateActionOwnership } from "./check-diff.js";
import { buildCollectedEvidence } from "./evidence-collect.js";
import { buildRegistryYaml, runRegistryRebuild } from "./registry-rebuild.js";
import { readProfile } from "./profile.js";
import type { WorkingTreeState } from "../core/git.js";
import type { ApprovalStatus, Evidence, Issue, Profile, Remediation } from "../core/types.js";
import { collectTaskHealthIssues } from "./health.js";
import { taskRefreshReasons } from "./task-refresh.js";
import { createBufferedStdoutReporter, createConsoleReporter, printIssues, type Reporter, withDefaultFixCommand as remediate } from "../core/report.js";
import { buildFinishLifecycleEvent, recordFinishLifecycleEvent, type FinishLifecycleTerminalOutput } from "../core/finish-lifecycle.js";
import { detectCurrentPullRequest, normalizePullRequestNumber, pullRequestEvidenceCommand } from "./health.js";
import {
  evaluateMergePreflight,
  summarizeMergeReadiness,
  unavailableMergeReport,
  type MergePreflightReport,
  type MergePullRequestView,
  type MergeReadinessSummary
} from "../core/merge-preflight.js";

export { normalizePullRequestNumber } from "./health.js";

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
  readinessWarnings: Array<{ code: string; message: string; fixCommand?: string; remediation?: Remediation }>;
  fixCommands: string[];
  mergeReadiness?: MergeReadinessSummary;
  workingTree?: WorkingTreeState;
} & Partial<HumanGateActionOwnership>;

type TestQuality = NonNullable<Evidence["testQuality"]>;
type CheckpointWriter = (files: AtomicFileWrite[]) => string[];

export type PullRequestState =
  | "draft"
  | "checks-pending"
  | "checks-failure"
  | "checks-success"
  | "closed"
  | "merged"
  | "unavailable";
export type PullRequestStateResolver = (root: string, pullRequest: number) => PullRequestState;

type PullRequestStatusCheck = { status?: string; conclusion?: string; state?: string };
type PullRequestView = Omit<MergePullRequestView, "statusCheckRollup"> & { statusCheckRollup?: PullRequestStatusCheck[] };
const FAILED_CHECK_CONCLUSIONS = new Set(["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STALE", "STARTUP_FAILURE", "TIMED_OUT"]);
const VIEW_FIELDS = "number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup";

function githubRepository(root: string): string | undefined {
  try {
    const result = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return result.trim().match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  } catch {
    return undefined;
  }
}

type PullRequestReadinessResult = { view?: PullRequestView; report: MergePreflightReport };

function readPullRequestReadiness(root: string, pullRequest: number): PullRequestReadinessResult {
  let repository: string | undefined;
  try {
    repository = githubRepository(root);
    const args = ["pr", "view", String(pullRequest)];
    if (repository) args.push("--repo", repository);
    args.push("--json", VIEW_FIELDS);
    const output = execFileSync(
      "gh",
      args,
      { cwd: root, encoding: "utf8" }
    );
    const view = JSON.parse(output) as PullRequestView;
    return { view, report: evaluateMergePreflight(pullRequest, view, repository ?? null) };
  } catch (error) {
    return {
      report: unavailableMergeReport(
        pullRequest,
        error instanceof Error ? error.message : String(error),
        repository ?? null
      )
    };
  }
}

function stateFromReadiness(result: PullRequestReadinessResult): PullRequestState {
  if (result.view?.state === "MERGED") return "merged";
  if (result.view?.state === "CLOSED") return "closed";
  if (result.view?.isDraft) return "draft";
  const checks = result.view?.statusCheckRollup ?? [];
  if (checks.some((check) => FAILED_CHECK_CONCLUSIONS.has(check.conclusion ?? check.state ?? ""))) return "checks-failure";
  if (result.report.validate.status === "failure") return "checks-failure";
  if (result.report.status === "pass") return "checks-success";
  return "checks-pending";
}

export const resolvePullRequestState: PullRequestStateResolver = (root, pullRequest) => {
  const result = readPullRequestReadiness(root, pullRequest);
  return result.report.violations.some((violation) => violation.code === "merge.github.unavailable")
    ? "unavailable"
    : stateFromReadiness(result);
};

export function resolvePullRequestReadiness(root: string, pullRequest: number): MergePreflightReport {
  return readPullRequestReadiness(root, pullRequest).report;
}

export type AtomicFileWrite = { path: string; content: string | Buffer };
type AtomicWriteJournal = {
  schemaVersion: "1.0.0";
  files: Array<{ path: string; existed: boolean; previous?: string; previousEncoding?: "base64" }>;
};

function removeIfPresent(file: string): void {
  if (existsSync(file)) unlinkSync(file);
}

function restoreJournal(journal: AtomicWriteJournal): string[] {
  for (const file of journal.files) {
    if (file.existed) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      const previous = file.previousEncoding === "base64"
        ? Buffer.from(file.previous ?? "", "base64")
        : file.previous ?? "";
      writeFileSync(file.path, previous);
    } else {
      removeIfPresent(file.path);
    }
  }
  return journal.files.map((file) => file.path);
}

function recoverAtomicFileWrites(journalPath: string, allowedPaths: string[]): string[] {
  if (!existsSync(journalPath)) return [];
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as AtomicWriteJournal;
  if (journal.schemaVersion !== "1.0.0" || !Array.isArray(journal.files)) {
    throw new Error(`Invalid atomic write journal: ${journalPath}`);
  }
  const allowed = new Set(allowedPaths.map((file) => path.resolve(file)));
  const unexpected = journal.files.find((file) => !allowed.has(path.resolve(file.path)));
  if (unexpected) throw new Error(`Atomic write journal contains an unexpected path: ${unexpected.path}`);
  const restored = restoreJournal(journal);
  removeIfPresent(journalPath);
  return restored;
}

export function writeFilesAtomically(
  files: AtomicFileWrite[],
  options: { beforeCommit?: (index: number, file: AtomicFileWrite) => void; journalPath?: string } = {}
): string[] {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staged = files.map((file, index) => {
    mkdirSync(path.dirname(file.path), { recursive: true });
    const tempPath = `${file.path}.scwbs-${token}-${index}.tmp`;
    writeFileSync(tempPath, file.content, "utf8");
    return {
      ...file,
      tempPath,
      existed: existsSync(file.path),
      previous: existsSync(file.path) ? readFileSync(file.path) : undefined
    };
  });
  const committed: typeof staged = [];
  try {
    if (options.journalPath) {
      mkdirSync(path.dirname(options.journalPath), { recursive: true });
      const journal: AtomicWriteJournal = {
        schemaVersion: "1.0.0",
        files: staged.map(({ path: filePath, existed, previous }) => ({
          path: filePath,
          existed,
          ...(previous !== undefined ? { previous: previous.toString("base64"), previousEncoding: "base64" as const } : {})
        }))
      };
      const journalTemp = `${options.journalPath}.${token}.tmp`;
      writeFileSync(journalTemp, `${JSON.stringify(journal)}\n`, "utf8");
      renameSync(journalTemp, options.journalPath);
    }
    staged.forEach((file, index) => {
      options.beforeCommit?.(index, file);
      renameSync(file.tempPath, file.path);
      committed.push(file);
    });
    return files.map((file) => file.path);
  } catch (error) {
    for (const file of committed.reverse()) {
      if (file.existed) writeFileSync(file.path, file.previous ?? Buffer.alloc(0));
      else removeIfPresent(file.path);
    }
    if (options.journalPath) removeIfPresent(options.journalPath);
    throw error;
  } finally {
    for (const file of staged) removeIfPresent(file.tempPath);
    if (committed.length === staged.length && options.journalPath) removeIfPresent(options.journalPath);
  }
}

export type FinishOptions = {
  taskId?: string;
  baseRef?: string;
  pullRequest?: string;
  force?: boolean;
  json?: boolean;
  rerunChecks?: boolean;
  preflight?: boolean;
  testQuality?: TestQuality;
  checkpointWriter?: CheckpointWriter;
  pullRequestStateResolver?: PullRequestStateResolver;
  pullRequestReadinessResolver?: (root: string, pullRequest: number) => MergePreflightReport;
};

type PullRequestMetadata = {
  evidence?: number;
  review?: number;
  selected?: number;
  issue?: Issue;
};

function collectPullRequestMetadata(root: string, taskId: string): PullRequestMetadata {
  const evidenceValue = readEvidence(root, taskId).evidence?.git?.pullRequest;
  const reviewValue = readReview(root, taskId).review?.pullRequest;
  const evidence = normalizePullRequestNumber(evidenceValue);
  const review = normalizePullRequestNumber(reviewValue);
  if (evidenceValue && evidence === undefined) {
    return {
      issue: {
        severity: "error",
        code: "finish.pullRequest.evidence.invalid",
        message: `${taskId} Evidence pullRequest is not a PR number: ${evidenceValue}`,
        fixCommand: `npm run scwbs -- evidence annotate --task ${taskId} --pull-request <pr-number>`
      }
    };
  }
  if (reviewValue && review === undefined) {
    return {
      evidence,
      issue: {
        severity: "error",
        code: "finish.pullRequest.review.invalid",
        message: `${taskId} Review pullRequest is not a PR number: ${reviewValue}`,
        fixCommand: `npm run scwbs -- review request --task ${taskId} --pull-request <pr-number> --force`
      }
    };
  }
  if (evidence !== undefined && review !== undefined && evidence !== review) {
    return {
      evidence,
      review,
      issue: {
        severity: "error",
        code: "finish.pullRequest.metadata.mismatch",
        message: `${taskId} Evidence pullRequest #${evidence} does not match Review pullRequest #${review}`,
        fixCommand: `npm run scwbs -- review request --task ${taskId} --pull-request ${evidence} --force`
      }
    };
  }
  const current = detectCurrentPullRequest(root);
  if (current && (evidence !== current.number || (review !== undefined && review !== current.number))) {
    return {
      evidence,
      review,
      issue: {
        severity: "error",
        code: "finish.pullRequest.current.metadata.mismatch",
        message: `${taskId} current branch already has PR #${current.number}, but Evidence/Review metadata is missing or points elsewhere`,
        fixCommand: pullRequestEvidenceCommand(taskId, current.number)
      }
    };
  }
  return { evidence, review, selected: evidence ?? review };
}

export function pullRequestNextAction(taskId: string, pullRequest: number | undefined, state?: PullRequestState): { label: string; command: string } {
  if (pullRequest === undefined) {
    return {
      label: "Open a pull request:",
      command: `gh pr create --base main --title "feat: ${taskId}" --body ""`
    };
  }
  switch (state) {
    case "draft":
      return { label: `Mark pull request #${pullRequest} ready for review:`, command: `gh pr ready ${pullRequest}` };
    case "checks-failure":
      return { label: `Inspect failing checks for pull request #${pullRequest}:`, command: `gh pr checks ${pullRequest}` };
    case "checks-success":
      return { label: `Merge pull request #${pullRequest} through the validate preflight:`, command: `npm run scwbs -- merge --pr ${pullRequest}` };
    case "closed":
      return { label: `Reopen closed pull request #${pullRequest} or reconcile its recorded metadata:`, command: `gh pr reopen ${pullRequest}` };
    case "merged":
      return { label: `Synchronize main after merged pull request #${pullRequest}:`, command: "git switch main && git pull --ff-only origin main" };
    case "checks-pending":
      return { label: `Watch checks for pull request #${pullRequest}:`, command: `gh pr checks ${pullRequest} --watch` };
    default:
      return { label: `Verify checks for existing pull request #${pullRequest}:`, command: `gh pr checks ${pullRequest} --watch` };
  }
}

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

function readinessWarnings(issues: Issue[]): FinishJsonOutput["readinessWarnings"] {
  return remediate(issues).map(({ code, message, fixCommand, remediation }) => ({
    code,
    message,
    ...(fixCommand ? { fixCommand } : {}),
    ...(remediation ? { remediation } : {})
  }));
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

function runWithReporterIfJson<T>(json: boolean, fn: (reporter: Reporter) => T): { result: T; output: string } {
  if (!json) return { result: fn(createConsoleReporter()), output: "" };
  const { reporter, output } = createBufferedStdoutReporter();
  const result = fn(reporter);
  return { result, output: output() };
}

function inferTaskIdFromBranch(branch: string | undefined): string | undefined {
  return branch?.match(/(SCWBS-(?:DRAFT-)?[A-Z0-9-]+)/)?.[1];
}

export function buildHumanApprovalCommand(taskId: string, approvalStatus?: ApprovalStatus): string {
  const force = approvalStatus === "approved" || approvalStatus === "rejected" ? " --force" : "";
  return `npm run scwbs -- approval approve --task ${taskId} --actor human${force} --reason "Evidence and diff reviewed"`;
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

export const FINISH_LIFECYCLE_STEPS = [
  "preflight",
  "required-checks",
  "validation",
  "checkpoint",
  "readiness",
  "complete"
] as const satisfies readonly FinishPhase[];

export function finishLifecycleStepOrder(): readonly FinishPhase[] {
  return FINISH_LIFECYCLE_STEPS;
}

let finishLifecycleObserver: ((output: FinishJsonOutput) => void) | undefined;

function emitJson(output: FinishJsonOutput, enabled: boolean): void {
  finishLifecycleObserver?.(output);
  if (enabled) console.log(JSON.stringify(output, null, 2));
}

function checkpointFinishMetadata(root: string, evidence: Evidence, writer: CheckpointWriter): string[] {
  const evidenceRelativePath = evidencePath(evidence.taskId);
  const payloadRelativePath = evidencePayloadPath(evidence.taskId);
  const baseCommit = evidence.git?.baseCommit;
  const subjectCommit = evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.commit;
  const artifact = evidence.provenance?.retention.mode === "patch-artifact" && baseCommit && subjectCommit
    ? buildPatchArtifact(root, evidence.taskId, baseCommit, subjectCommit)
    : undefined;
  if (
    artifact
    && (
      artifact.locator !== evidence.provenance?.retention.locator
      || artifact.manifestHash !== evidence.provenance.retention.manifestHash
      || artifact.treeHash !== evidence.provenance.subject.treeHash
    )
  ) {
    throw new Error(`${evidence.taskId} patch artifact does not match the Evidence candidate`);
  }
  const registryYaml = buildRegistryYaml(root, { evidence });
  const writes = [
    ...(artifact ? [{
      relativePath: payloadRelativePath,
      path: resolveFrom(root, payloadRelativePath),
      content: artifact.bytes
    }] : []),
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
  const changedWrites = writes.filter((file) =>
    !existsSync(file.path)
    || !readFileSync(file.path).equals(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content))
  );
  writer(changedWrites.map(({ path, content }) => ({ path, content })));
  return changedWrites.map((file) => file.relativePath);
}

function printHumanGate(approvalCommand: string, files: string[], diffHash: string): void {
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
  console.log("  Action owner: human only");
  console.log(`  ${approvalCommand}`);
  console.log("");
  console.log("AI agents must stop here.");
  console.log("Do not approve this task yourself.");
}

function runFinishWorkflow(root: string, options: FinishOptions = {}): number {
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
      readinessWarnings: readinessWarnings(issues),
      fixCommands: [nextAction]
    }), json);
    return 1;
  }
  if (!options.preflight) {
    try {
      const recovered = recoverAtomicFileWrites(journalPath, [
        resolveFrom(root, evidencePayloadPath(taskId)),
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
      readinessWarnings: readinessWarnings(preflightIssues),
      fixCommands: readinessFixCommands(preflightIssues)
    }), json);
    return 1;
  }

  const initialPullRequestMetadata = collectPullRequestMetadata(root, taskId);
  if (initialPullRequestMetadata.issue) {
    const issue = initialPullRequestMetadata.issue;
    printReadinessIssues([issue], json);
    const nextAction = issue.fixCommand ?? "Reconcile pull request metadata";
    emitJson(finishOutput({
      status: "blocked", phase: "validation", outcome: "validation-failed", taskId,
      requiresHumanApproval: false, changedFiles: [], violations: [issue], requiredChecks: [],
      evidencePath: evidenceRelativePath, approvalStatus: approvalStatus(), nextAction,
      resumeCommand: nextAction, mutatedFiles: [],
      readinessWarnings: readinessWarnings([issue]),
      fixCommands: issue.fixCommand ? [issue.fixCommand] : []
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
      readinessWarnings: readinessWarnings(workingTree.issues),
      fixCommands: readinessFixCommands(workingTree.issues), workingTree: workingTree.state
    }), json);
    return 1;
  }

  if (options.preflight) {
    const nextAction = resumeFinishCommand(taskId);
    if (!json) {
      console.log(`PASS finish preflight ${taskId}`);
      console.log(`plannedMutations: ${evidencePayloadPath(taskId)}, ${evidenceRelativePath}, ${defaultRegistryPath}`);
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
      pullRequest: options.pullRequest ?? (initialPullRequestMetadata.selected ? String(initialPullRequestMetadata.selected) : undefined),
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

  const { result: diffExit, output: checkDiffOutput } = runWithReporterIfJson(true, (reporter) =>
    runCheckDiff(root, taskId, { baseRef: options.baseRef, json: true, evidence, reporter })
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

  const { result: registryExit } = runWithReporterIfJson(json, (reporter) => runRegistryRebuild(root, { check: true, force: false, reporter }));
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
    const approvalCommand = buildHumanApprovalCommand(taskId, approval?.status);
    if (!json) printHumanGate(approvalCommand, gate.requiredFiles, diffHash);
    emitJson(finishOutput({
      status: "blocked", phase: "checkpoint", outcome: "awaiting-human-approval", taskId,
      requiresHumanApproval: true, changedFiles: evidence.changedFiles, violations: humanGateIssues,
      requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approval?.status ?? "", nextAction: approvalCommand, resumeCommand: approvalCommand,
      mutatedFiles, humanGateFiles: gate.requiredFiles, diffHash, readinessWarnings: [],
      fixCommands: [approvalCommand], ...buildHumanGateActionOwnership(approvalCommand)
    }), json);
    return 1;
  }

  const finalPullRequestMetadata = collectPullRequestMetadata(root, taskId);
  if (finalPullRequestMetadata.issue) {
    const issue = finalPullRequestMetadata.issue;
    printReadinessIssues([issue], json);
    const nextAction = issue.fixCommand ?? "Reconcile pull request metadata";
    emitJson(finishOutput({
      status: "blocked", phase: "readiness", outcome: "readiness-blocked", taskId,
      requiresHumanApproval: false, changedFiles: evidence.changedFiles, violations: [issue],
      requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approval?.status ?? "", nextAction, resumeCommand: nextAction, mutatedFiles,
      readinessWarnings: readinessWarnings([issue]),
      fixCommands: issue.fixCommand ? [issue.fixCommand] : []
    }), json);
    return 1;
  }
  const readinessIssues = collectTaskHealthIssues(root, taskId)
    .filter((issue) => ![
      "health.evidence.git.pullRequest.missing",
      "health.review.scope.pullRequest"
    ].includes(issue.code));
  if (readinessIssues.length > 0) {
    printReadinessIssues(readinessIssues, json);
    const nextAction = readinessIssues[0]?.fixCommand ?? resumeFinishCommand(taskId);
    emitJson(finishOutput({
      status: "blocked", phase: "readiness", outcome: "readiness-blocked", taskId,
      requiresHumanApproval: false, changedFiles: evidence.changedFiles, violations: [],
      requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
      approvalStatus: approval?.status ?? "", nextAction, resumeCommand: nextAction, mutatedFiles,
      readinessWarnings: readinessWarnings(readinessIssues),
      fixCommands: readinessFixCommands(readinessIssues)
    }), json);
    return 1;
  }

  const profile: Profile = readProfile(root);
  const pullRequest = finalPullRequestMetadata.selected;
  let readinessReport: MergePreflightReport | undefined;
  let pullRequestState: PullRequestState | undefined;
  if (pullRequest !== undefined) {
    if (options.pullRequestReadinessResolver) {
      readinessReport = options.pullRequestReadinessResolver(root, pullRequest);
      pullRequestState = stateFromReadiness({ report: readinessReport });
    } else if (options.pullRequestStateResolver) {
      pullRequestState = options.pullRequestStateResolver(root, pullRequest);
    } else {
      const readiness = readPullRequestReadiness(root, pullRequest);
      readinessReport = readiness.report;
      pullRequestState = readiness.report.violations.some((violation) => violation.code === "merge.github.unavailable")
        ? "unavailable"
        : stateFromReadiness(readiness);
    }
  }
  const next = pullRequestNextAction(taskId, pullRequest, pullRequestState);
  if (!json) {
    console.log(`Profile: ${profile}`);
    console.log("");
    console.log("Next action:");
    console.log(`  ${next.label}`);
    console.log(`  ${next.command}`);
  }
  emitJson(finishOutput({
    status: "pass", phase: "complete", outcome: "completed", taskId,
    requiresHumanApproval: false, changedFiles: evidence.changedFiles, violations: [],
    requiredChecks: evidence.checks, evidencePath: evidenceRelativePath,
    approvalStatus: approval?.status ?? "", nextAction: next.command, resumeCommand: next.command,
    mutatedFiles, readinessWarnings: [], fixCommands: [],
    ...(readinessReport ? { mergeReadiness: summarizeMergeReadiness(readinessReport) } : {})
  }), json);
  return 0;
}

function runFinishInternal(root: string, options: FinishOptions = {}): number {
  const taskId = options.taskId ?? inferTaskIdFromBranch(currentBranch(root));
  return runFinishWorkflow(root, taskId ? { ...options, taskId } : options);
}

export function runFinish(root: string, options: FinishOptions = {}): number {
  const startedAt = new Date();
  const taskId = options.taskId ?? inferTaskIdFromBranch(currentBranch(root));
  let terminalOutput: FinishLifecycleTerminalOutput | undefined;
  const previousObserver = finishLifecycleObserver;
  finishLifecycleObserver = (output) => {
    terminalOutput = {
      phase: output.phase,
      outcome: output.outcome,
      mutatedFiles: output.mutatedFiles
    };
    previousObserver?.(output);
  };
  let exitCode = 1;
  try {
    exitCode = runFinishInternal(root, options);
    return exitCode;
  } catch (error) {
    terminalOutput ??= { phase: "preflight", outcome: "unexpected-error", mutatedFiles: [] };
    throw error;
  } finally {
    finishLifecycleObserver = previousObserver;
    if (taskId && terminalOutput) {
      try {
        const endedAt = new Date();
        recordFinishLifecycleEvent(
          root,
          taskId,
          buildFinishLifecycleEvent(root, taskId, startedAt, endedAt, exitCode, terminalOutput, options.preflight ?? false)
        );
      } catch (error) {
        console.error(`WARN finish lifecycle receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
