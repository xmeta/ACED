import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { branchChangedFiles, currentBranch, workingTreeChangedFiles, workingTreeState, type WorkingTreeState } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { collectCheckCoverageIssues } from "../core/check-coverage.js";
import { matchesManagedContractPath, taskLifecycleMetadataPaths } from "../core/managed-contract-paths.js";
import { hasErrors, printIssues, withDefaultFixCommand } from "../core/report.js";
import { buildTaskAuthorityRepairPreflights, collectTaskAuthorityIssues, type TaskAuthorityRepairPreflight } from "../core/task-authority.js";
import type { Evidence, Issue, TaskContract } from "../core/types.js";
import { runWjsValidate } from "../core/wbs.js";
import { collectWbsChangesetGateIssues } from "./check.js";

export type HumanGateActionOwnership = {
  nextActionOwner: "human";
  humanAction: { command: string; reason: string };
  aiNextAction: { action: "stop"; reason: string };
};

export function buildHumanGateActionOwnership(command: string): HumanGateActionOwnership {
  return {
    nextActionOwner: "human",
    humanAction: {
      command,
      reason: "A human reviewer must approve the current Evidence and diff scope."
    },
    aiNextAction: {
      action: "stop",
      reason: "Human Approval is required. AI must not execute the human approval command."
    }
  };
}

const SENSITIVE_META_PATHS = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  ".gitignore",
  ".github/**"
];

function requiresMetaFileGuard(file: string): boolean {
  return matchesAny(file, SENSITIVE_META_PATHS);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stashCommand(files: string[]): string {
  return `git stash push --include-untracked -m "scwbs: clean working tree before Evidence" -- ${files.map(shellQuote).join(" ")}`;
}

function printAuthorityRepairPreflights(reports: TaskAuthorityRepairPreflight[]): void {
  for (const report of reports) {
    console.log("");
    console.log(`Authority repair preflight (read-only): ${report.targetTaskId}`);
    console.log(`  Changed fields: ${report.changedFields.join(", ")}`);
    console.log(`  Trusted fingerprint: ${report.authorityFingerprint.trusted}`);
    console.log(`  Current fingerprint: ${report.authorityFingerprint.current}`);
    console.log(`  Managed paths added: ${report.managedPathChanges.added.join(", ") || "(none)"}`);
    console.log(`  Managed paths removed: ${report.managedPathChanges.removed.join(", ") || "(none)"}`);
    console.log(`  Existing Evidence: ${report.impact.evidencePresent ? "present" : "missing"}`);
    console.log(`  Existing Approval: ${report.impact.approvalStatus}`);
    console.log("  Impact: Evidence regeneration and Approval re-request are required; previous Approval is not reusable.");
    console.log(`  Human decision: ${report.requiredHumanDecision}`);
    console.log("  Recovery sequence:");
    for (const step of report.recoverySteps) {
      console.log(`    ${step.step}. [${step.actor}] ${step.action}`);
      if (step.command) console.log(`       ${step.command}`);
    }
    console.log("  This preflight did not modify any files.");
  }
}

function normalizedSubmoduleChecks(checks: Array<{ name: string; status: string; url?: string }> | undefined): string {
  return JSON.stringify([...(checks ?? [])]
    .map((check) => ({ name: check.name, status: check.status, url: check.url }))
    .sort((left, right) => `${left.name}\0${left.status}\0${left.url ?? ""}`.localeCompare(`${right.name}\0${right.status}\0${right.url ?? ""}`)));
}

function verifiedUpstreamReleasePaths(
  task: TaskContract,
  evidence: Evidence | undefined,
  files: string[]
): { paths: Set<string>; issues: Issue[] } {
  const paths = new Set<string>();
  const issues: Issue[] = [];
  for (const dependency of task.submoduleDependencies ?? []) {
    if (dependency.authorityMode !== "upstream-release" || !files.includes(dependency.path)) continue;
    const checks = dependency.checks ?? [];
    const complete = Boolean(
      dependency.repository
      && dependency.pullRequest
      && dependency.upstreamRef
      && checks.length > 0
      && checks.every((check) => check.status === "passed")
    );
    const submodule = evidence?.submodules?.find((item) => item.path === dependency.path);
    const matchesDeclaration = Boolean(
      submodule
      && submodule.repository === dependency.repository
      && submodule.pullRequest === dependency.pullRequest
      && submodule.upstreamRef === dependency.upstreamRef
      && normalizedSubmoduleChecks(submodule.checks) === normalizedSubmoduleChecks(checks)
    );
    const validHead = Boolean(submodule && /^[0-9a-f]{40}$/.test(submodule.headCommit) && !/^0+$/.test(submodule.headCommit));
    if (!complete || !matchesDeclaration || !validHead || submodule?.upstreamReachable !== true) {
      issues.push({
        severity: "error",
        code: "diff.submodule.upstreamRelease",
        message: `${dependency.path} upstream-release authority requires complete immutable declaration, matching Evidence, a non-zero head commit, and upstream reachability`
      });
      continue;
    }
    paths.add(dependency.path);
  }
  return { paths, issues };
}

export function evaluateWorkingTreeGuard(root: string, taskId: string): { state: WorkingTreeState; issues: Issue[] } {
  const state = workingTreeState(root, taskLifecycleMetadataPaths(taskId));
  const issues: Issue[] = [];
  const tracked = Array.from(new Set([...state.staged, ...state.unstaged]));
  if (tracked.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.workingTree.tracked",
      message: `Commit intended tracked changes before Evidence collection, or stash them temporarily: ${tracked.join(", ")}`,
      fixCommand: stashCommand(tracked)
    });
  }
  if (state.untracked.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.workingTree.untracked",
      message: `Commit intended untracked files before Evidence collection, or stash them temporarily: ${state.untracked.join(", ")}`,
      fixCommand: stashCommand(state.untracked)
    });
  }
  if (state.submodules.length > 0) {
    issues.push({
      severity: "error",
      code: "diff.workingTree.submodule",
      message: `Commit or stash dirty submodule worktrees before Evidence collection: ${state.submodules.join(", ")}`,
      fixCommand: state.submodules.map((file) => `git -C ${shellQuote(file)} stash push --include-untracked -m "scwbs: clean submodule before Evidence"`).join(" && ")
    });
  }
  return { state, issues };
}

/**
 * M2-019: managedContractPaths are CLI-generated contract files (Evidence,
 * Approval, Review, registry.yaml, the task's own contract file, etc). They
 * are exempt from allowedPaths and the sensitive meta-file guard, but never
 * from forbiddenPaths or humanGateRequiredPaths, which always take priority.
 */
export function collectDiffIssues(root: string, task: TaskContract, files: string[], evidenceOverride?: Evidence): Issue[] {
  const issues: Issue[] = [];
  const evidence = evidenceOverride ?? readEvidence(root, task.id).evidence;
  const releaseAuthority = verifiedUpstreamReleasePaths(task, evidence, files);
  issues.push(...releaseAuthority.issues);
  const nestedFiles = (evidence?.submodules ?? []).flatMap((submodule) =>
    submodule.changedFiles.map((file) => `${submodule.path}/${file}`));
  const authorityNestedFiles = (evidence?.submodules ?? [])
    .filter((submodule) => !releaseAuthority.paths.has(submodule.path))
    .flatMap((submodule) => submodule.changedFiles.map((file) => `${submodule.path}/${file}`));
  const authorityFiles = Array.from(new Set([...files, ...authorityNestedFiles]));
  const coverageFiles = Array.from(new Set([...files, ...nestedFiles]));
  const gate = validateHumanGateApproval(task, evidence, readApproval(root, task.id).approval, authorityFiles, root);
  for (const dependency of task.submoduleDependencies ?? []) {
    if (files.includes(dependency.path) && !evidence?.submodules?.some((submodule) => submodule.path === dependency.path)) {
      issues.push({ severity: "error", code: "diff.submodule.evidence.missing", message: `${dependency.path} gitlink changed but nested Evidence is missing` });
    }
  }
  for (const submodule of evidence?.submodules ?? []) {
    if (!submodule.upstreamReachable) {
      issues.push({ severity: "error", code: "diff.submodule.upstreamReachable", message: `${submodule.path} head ${submodule.headCommit} is not reachable from upstream target ${submodule.upstreamRef}` });
    }
    for (const check of submodule.checks ?? []) {
      if (check.status !== "passed") issues.push({ severity: "error", code: "diff.submodule.check", message: `${submodule.path} check ${check.name} is ${check.status}` });
    }
  }
  for (const issue of collectWbsChangesetGateIssues(authorityFiles)) {
    issues.push({ ...issue, code: `diff.${issue.code}`, message: `${issue.message} (for ${task.id})` });
  }
  const wbsChangeSets = files.filter((file) => /^contracts\/changesets\/.+\.json$/.test(file.replace(/\\/g, "/")));
  for (const changeSet of wbsChangeSets) {
    issues.push(...runWjsValidate(root, changeSet, "operations").map((issue) => ({
      ...issue,
      code: `diff.wbsOperations.${issue.code}`,
      message: `${changeSet}: ${issue.message}`
    })));
  }
  for (const file of authorityFiles) {
    const managed = matchesManagedContractPath(task, file);
    if (!matchesAny(file, task.allowedPaths) && !managed) {
      issues.push({
        severity: "error",
        code: "diff.allowedPaths",
        message: `${file} is outside allowedPaths for ${task.id}`,
        fixCommand: `Move this change out of the diff, or explicitly add ${file} to allowedPaths in contracts/tasks/${task.id}.yaml`
      });
    }
    if (matchesAny(file, task.forbiddenPaths)) {
      issues.push({
        severity: "error",
        code: "diff.forbiddenPaths",
        message: `${file} is forbidden by ${task.id}`,
        fixCommand: `Revert changes to ${file}; forbiddenPaths always takes priority over allowedPaths/managedContractPaths`
      });
    }
    const explicitlyAllowed = matchesAny(file, task.allowedPaths);
    const humanGateRequired = matchesAny(file, task.humanGateRequiredPaths);
    if (requiresMetaFileGuard(file) && !explicitlyAllowed && !humanGateRequired && !managed) {
      issues.push({
        severity: "error",
        code: "diff.metaFile",
        message: `${file} is a sensitive meta/config file and must be explicitly allowed for ${task.id}`,
        fixCommand: `Add ${file} to allowedPaths or humanGateRequiredPaths in contracts/tasks/${task.id}.yaml if this change is intentional`
      });
    }
  }
  issues.push(...gate.issues.map((issue) => ({
    ...issue,
    code: "diff.humanGate",
    message: `${issue.message} (${issue.code})`
  })));
  issues.push(...collectCheckCoverageIssues(root, task, coverageFiles).map((issue) => ({
    ...issue,
    code: `diff.${issue.code}`
  })));
  return issues;
}

export function collectBranchIssues(task: TaskContract, branch: string | undefined): Issue[] {
  if (!task.branchName || !branch) return [];
  if (task.branchName === branch) return [];
  return [{
    severity: "error",
    code: "diff.branchName",
    message: `current branch ${branch} does not match ${task.id} branchName ${task.branchName}`,
    fixCommand: `git checkout -b ${task.branchName}`
  }];
}

export function collectEvidenceGateIssues(root: string, task: TaskContract, evidenceOverride?: Evidence): Issue[] {
  if (evidenceOverride) return [];
  const { evidence, issues } = readEvidence(root, task.id);
  if (!evidence) {
    return issues.map((issue) => ({
      ...issue,
      code: `diff.${issue.code}`,
      message: issue.message,
      fixCommand: `npm run scwbs -- evidence collect --task ${task.id} before opening a PR`
    }));
  }
  return issues.map((issue) => ({
    ...issue,
    code: `diff.${issue.code}`
  }));
}

export function runCheckDiff(root: string, taskId: string, options: { baseRef?: string; json?: boolean; evidence?: Evidence } = {}): number {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    const taskIssues = withDefaultFixCommand(issues, `Create the task contract: npm run scwbs -- task new "<title>" (or fix contracts/tasks/${taskId}.yaml)`);
    if (options.json) console.log(JSON.stringify({ status: "fail", taskId, issues: taskIssues }, null, 2));
    else printIssues(taskIssues);
    return 1;
  }
  const baseRef = options.baseRef ?? "origin/main";
  let files: string[] = [];
  let authorityFiles: string[] = [];
  let workingTree: WorkingTreeState = { staged: [], unstaged: [], untracked: [], submodules: [], changedFiles: [] };
  let workingTreeIssues: Issue[] = [];
  try {
    files = branchChangedFiles(root, baseRef);
    ({ state: workingTree, issues: workingTreeIssues } = evaluateWorkingTreeGuard(root, taskId));
    authorityFiles = Array.from(new Set([
      ...files,
      ...workingTreeChangedFiles(root).filter((file) => /^contracts\/tasks\/[^/]+\.ya?ml$/.test(file))
    ]));
  } catch (error) {
    const baseIssues = [{
      severity: "error",
      code: "diff.git.base",
      message: error instanceof Error ? error.message : String(error),
      fixCommand: `npm run scwbs -- check-diff --task ${taskId} --base <a-valid-ref>`
    }] as Issue[];
    if (options.json) console.log(JSON.stringify({ status: "fail", taskId, issues: baseIssues, workingTree }, null, 2));
    else printIssues(baseIssues);
    return 1;
  }
  const diffIssues = withDefaultFixCommand([
    ...collectBranchIssues(task, currentBranch(root)),
    ...collectEvidenceGateIssues(root, task, options.evidence),
    ...workingTreeIssues,
    ...collectTaskAuthorityIssues(root, task, baseRef, authorityFiles),
    ...collectDiffIssues(root, task, files, options.evidence)
  ], `npm run scwbs -- check-diff --task ${taskId} --base ${baseRef}`);
  const authorityRepairPreflights = diffIssues.some((issue) => issue.code === "diff.taskAuthority.change")
    ? buildTaskAuthorityRepairPreflights(root, baseRef, authorityFiles)
    : [];

  const humanGateIssues = diffIssues.filter((issue) => issue.code === "diff.humanGate");
  const requiresHumanApproval = humanGateIssues.length > 0;

  let nextAction = "";
  let humanGateFiles: string[] = [];
  let diffHash = "(not recorded)";
  if (requiresHumanApproval) {
    const evidence = options.evidence ?? readEvidence(root, taskId).evidence;
    diffHash = evidence?.diffHash ?? evidence?.git?.diffHash ?? "(not recorded)";
    const gate = validateHumanGateApproval(task, evidence, readApproval(root, taskId).approval, files, root);
    humanGateFiles = gate.requiredFiles;
    nextAction = `npm run scwbs -- approval approve --task ${taskId} --actor human --reason "Evidence and diff reviewed"`;
  }

  if (diffIssues.length === 0) {
    if (options.json) console.log(JSON.stringify({ status: "pass", taskId, issues: [], workingTree, requiresHumanApproval: false, nextAction: "" }, null, 2));
    else console.log(`PASS check-diff ${taskId}`);
    return 0;
  }

  if (options.json) {
    console.log(JSON.stringify({
      status: hasErrors(diffIssues) ? "fail" : "warn",
      taskId,
      issues: diffIssues,
      workingTree,
      ...(authorityRepairPreflights.length > 0 ? { authorityRepairPreflights } : {}),
      ...(requiresHumanApproval ? {
        requiresHumanApproval: true,
        nextAction,
        ...buildHumanGateActionOwnership(nextAction)
      } : {})
    }, null, 2));
  } else {
    printIssues(diffIssues);
    printAuthorityRepairPreflights(authorityRepairPreflights);
    if (requiresHumanApproval) {
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
      console.log("  Action owner: human only");
      console.log(`  ${nextAction}`);
      console.log("");
      console.log("AI agents must stop here.");
      console.log("Do not approve this task yourself.");
    }
  }
  return hasErrors(diffIssues) ? 1 : 0;
}
