import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listActiveTasks, readApproval, readEvidence, readRegistry, readReview, readTask } from "../core/contracts.js";
import { baseBranchStatus, branchChangedFiles, branchDiffHash, changedFilesBetween, changedFilesSince, commitExists, commitTreeHash, currentBranch, dirtySubmodulePaths, filesAddedOnBothSides, filesWithCrlf, headCommit, isCommitAncestor, isShallowRepository, trackedTextFiles } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { matchesManagedContractPath } from "../core/managed-contract-paths.js";
import { validateHumanGateApproval } from "../core/human-gate.js";
import { hasErrors } from "../core/report.js";
import type { Evidence, Issue, RegistryContract, TaskContract, WbsDocument } from "../core/types.js";
import { isDoneNode, readWbs } from "../core/wbs.js";
import { taskWbsAssociation } from "../core/task-wbs-policy.js";
import { taskRefreshReasons } from "./task-refresh.js";
import { buildCodeContextManifest, reverseImporterCounts, type ParsedImports } from "../core/code-context.js";
import { buildHealthLifecycleEvent, recordHealthLifecycleEvent } from "../core/health-lifecycle.js";
import { buildGovernanceCostSummary } from "./metrics.js";
import type { GovernanceWarningBudgets } from "../core/governance-warning-budget.js";
import { verifyPatchArtifact } from "../core/git.js";
import { taskLifecycleMetadataPaths } from "../core/managed-contract-paths.js";

export type CurrentPullRequest = {
  number: number;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
};

type GithubPullRequestView = {
  number?: unknown;
  state?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
};

export function normalizePullRequestNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(?:#|.*\/pull\/)?([1-9]\d*)\/?$/);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Read the current branch PR without mutating repository state; unavailable GitHub access fails safe. */
export function detectCurrentPullRequest(root: string): CurrentPullRequest | undefined {
  try {
    const gitConfig = readFileSync(path.join(root, ".git", "config"), "utf8");
    if (!/\[remote "origin"\]/.test(gitConfig)) return undefined;
    const output = execFileSync(
      "gh",
      ["pr", "view", "--json", "number,state,isDraft,headRefName,baseRefName"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const view = JSON.parse(output) as GithubPullRequestView;
    if (typeof view.number !== "number" || !Number.isInteger(view.number) || view.number < 1) return undefined;
    return {
      number: view.number,
      ...(typeof view.state === "string" ? { state: view.state } : {}),
      ...(typeof view.isDraft === "boolean" ? { isDraft: view.isDraft } : {}),
      ...(typeof view.headRefName === "string" ? { headRefName: view.headRefName } : {}),
      ...(typeof view.baseRefName === "string" ? { baseRefName: view.baseRefName } : {})
    };
  } catch {
    return undefined;
  }
}

export function pullRequestEvidenceCommand(taskId: string, pullRequest: number): string {
  return `npm run scwbs -- evidence collect --task ${taskId} --pull-request ${pullRequest} --force`;
}

type EvidenceLevel = "A" | "B" | "C";

export type HealthOptions = {
  json?: boolean;
  verbose?: boolean;
  representativeLimit?: number;
  governanceCost?: boolean;
};

export type HealthJsonOutput = {
  version: "scwbs.health.v1";
  status: "pass" | "warn" | "fail";
  repository: {
    shallow: boolean;
    commitReachability: "evaluated" | "not-evaluated";
  };
  summary: {
    total: number;
    errors: number;
    warnings: number;
    byCode: Array<{ code: string; severity: Issue["severity"]; count: number }>;
  };
  issues: Issue[];
  governanceCost?: GovernanceWarningBudgets;
};

function evidenceCheckLevel(check: Evidence["checks"][number]): EvidenceLevel {
  if (check.source === "ci" && (check.runId || check.url)) return "A";
  if (check.source === "local" && check.command && check.executedAt) return "B";
  return "C";
}

function strongestEvidenceLevel(evidence: Evidence): EvidenceLevel {
  const levels = evidence.checks.map(evidenceCheckLevel);
  if (levels.includes("A")) return "A";
  if (levels.includes("B")) return "B";
  return "C";
}

function isPostEvidenceMetadataFile(taskId: string, file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return taskLifecycleMetadataPaths(taskId).includes(normalized);
}

function postEvidenceMetadataFiles(taskId: string): string[] {
  return taskLifecycleMetadataPaths(taskId);
}

function evidenceHeadHasStaleImplementationChanges(root: string, taskId: string, evidenceHead: string, currentHead: string): boolean {
  if (evidenceHead === currentHead) return false;
  try {
    const files = changedFilesSince(root, evidenceHead);
    return files.some((file) => !isPostEvidenceMetadataFile(taskId, file));
  } catch {
    return true;
  }
}

function evidenceSubjectHead(evidence: Evidence): string | undefined {
  return evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit;
}

function evidenceDiffHash(evidence: Evidence): string | undefined {
  return evidence.diffHash ?? evidence.git?.diffHash;
}

function shouldCheckEvidenceHeadStaleness(currentBranchName: string | undefined, task: TaskContract, evidence: Evidence): boolean {
  if (!currentBranchName) return false;
  return currentBranchName === evidence.git?.branch || currentBranchName === task.branchName;
}

function hasTestQualityRationale(evidence: Evidence): boolean {
  return evidence.testQuality?.notes?.some((note) => note.trim().length > 0) ?? false;
}

export type EvidenceTrustOptions = {
  checkCommitReachability?: boolean;
  completed?: boolean;
  repositoryState?: {
    currentHead: string | undefined;
    currentBranchName: string | undefined;
    commitExists: (commit: string) => boolean;
  };
};

export function collectEvidenceTrustIssues(
  root: string,
  wbs: WbsDocument,
  task: TaskContract,
  evidence: Evidence,
  options: EvidenceTrustOptions = {}
): Issue[] {
  const issues: Issue[] = [];
  const association = taskWbsAssociation(wbs, task);
  const node = association.kind === "node" ? association.node : undefined;
  const checkCommitReachability = options.checkCommitReachability ?? true;
  const completed = options.completed ?? Boolean(node && isDoneNode(node));
  const currentHead = options.repositoryState ? options.repositoryState.currentHead : headCommit(root);
  const currentBranchName = options.repositoryState ? options.repositoryState.currentBranchName : currentBranch(root);
  const evidenceCommitExists = options.repositoryState?.commitExists ?? ((commit: string) => commitExists(root, commit));
  const { approval } = readApproval(root, task.id);
  const approvalPullRequest = approval?.pullRequest;
  const humanGate = validateHumanGateApproval(task, evidence, approval, evidence.changedFiles, root);
  let patchVerified = false;

  if (!evidence.provenance) {
    if (!completed) {
      issues.push({
        severity: "warn",
        code: "health.evidence.provenance.missing",
        message: `${task.id} active Evidence has no versioned subject provenance manifest`
      });
    }
  } else if (
    evidence.provenance.subject.commit !== evidenceSubjectHead(evidence)
    || evidence.provenance.subject.diffHash !== evidenceDiffHash(evidence)
  ) {
    issues.push({
      severity: "warn",
      code: "health.evidence.provenance.unverifiable",
      message: `${task.id} provenance subject does not match the legacy Evidence subject fields`
    });
  } else if (evidence.provenance.retention.mode === "patch-artifact") {
    const verification = verifyPatchArtifact(root, task.id, evidence, { shallow: !checkCommitReachability });
    if (verification.status === "verified") {
      patchVerified = true;
    } else {
      issues.push({
        severity: "warn",
        code: verification.status === "not-evaluated"
          ? `health.evidence.provenance.notEvaluated.${verification.code}`
          : `health.evidence.provenance.${verification.code}`,
        message: verification.message
      });
    }
  } else if (evidence.provenance.retention.mode !== "git-object") {
    issues.push({
      severity: "warn",
      code: "health.evidence.provenance.notEvaluated",
      message: `${task.id} ${evidence.provenance.retention.mode} payload verification is not evaluated by this CLI version`
    });
  } else if (evidence.provenance.retention.locator !== `git:${evidence.provenance.subject.commit}`) {
    issues.push({
      severity: "warn",
      code: "health.evidence.provenance.unverifiable",
      message: `${task.id} git-object retention locator is invalid`
    });
  } else if (checkCommitReachability && !evidenceCommitExists(evidence.provenance.subject.commit)) {
    issues.push({
      severity: "warn",
      code: "health.evidence.provenance.unverifiable",
      message: `${task.id} retained git object is unavailable; diffHash alone cannot reverify the subject`
    });
  } else if (
    checkCommitReachability
    && commitTreeHash(root, evidence.provenance.subject.commit) !== evidence.provenance.subject.treeHash
  ) {
    issues.push({
      severity: "warn",
      code: "health.evidence.provenance.treeHash",
      message: `${task.id} retained subject tree hash does not match Evidence`
    });
  }

  if (completed && strongestEvidenceLevel(evidence) === "C") {
    issues.push({
      severity: "warn",
      code: "health.evidence.lowTrust",
      message: `${task.id} is done but evidence only has Level C checks`
    });
  }

  const checksByName = new Map(evidence.checks.map((check) => [check.name, check]));
  for (const requiredCheck of task.requiredChecks) {
    const check = checksByName.get(requiredCheck);
    if (!check) {
      issues.push({
        severity: "warn",
        code: "health.evidence.check.missing",
        message: `${task.id} required check ${requiredCheck} is missing`
      });
    } else if (check.status !== "passed") {
      issues.push({
        severity: "warn",
        code: "health.evidence.check.notPassed",
        message: `${task.id} required check ${requiredCheck} status is ${check.status}`
      });
    } else if (evidenceCheckLevel(check) === "C") {
      issues.push({
        severity: "warn",
        code: "health.evidence.check.lowTrust",
        message: `${task.id} required check ${requiredCheck} has no verifiable source metadata`
      });
    }
  }

  if (!evidence.commit) {
    issues.push({ severity: "warn", code: "health.evidence.commit.missing", message: `${task.id} evidence has no commit` });
  } else if (checkCommitReachability && !patchVerified && !evidenceCommitExists(evidence.commit)) {
    issues.push({ severity: "warn", code: "health.evidence.commit.unknown", message: `${task.id} evidence commit was not found: ${evidence.commit}` });
  }

  if (!evidence.git?.branch && !task.branchName) {
    issues.push({ severity: "warn", code: "health.evidence.git.branch.missing", message: `${task.id} evidence has no branch metadata` });
  }
  const subjectHead = evidenceSubjectHead(evidence);
  if (!subjectHead) {
    issues.push({ severity: "warn", code: "health.evidence.subjectHeadCommit.missing", message: `${task.id} evidence has no subjectHeadCommit` });
  } else if (checkCommitReachability && !patchVerified && !evidenceCommitExists(subjectHead)) {
    issues.push({ severity: "warn", code: "health.evidence.subjectHeadCommit.unknown", message: `${task.id} evidence subjectHeadCommit was not found: ${subjectHead}` });
  } else if (
    checkCommitReachability
    &&
    currentHead
    && shouldCheckEvidenceHeadStaleness(currentBranchName, task, evidence)
    && evidenceHeadHasStaleImplementationChanges(root, task.id, subjectHead, currentHead)
  ) {
    issues.push({ severity: "warn", code: "health.evidence.subjectHeadCommit.stale", message: `${task.id} evidence subjectHeadCommit ${subjectHead} is behind implementation changes in current HEAD ${currentHead}` });
  }
  if (!evidence.git?.changedFilesBasis) {
    issues.push({ severity: "warn", code: "health.evidence.git.changedFilesBasis.missing", message: `${task.id} evidence has no git.changedFilesBasis` });
  }
  if (evidence.git?.changedFilesBasis === "branch-diff") {
    if (!evidence.git.base) {
      issues.push({ severity: "warn", code: "health.evidence.git.base.missing", message: `${task.id} branch-diff evidence has no git.base` });
    }
    if (!evidence.git.baseCommit) {
      issues.push({ severity: "warn", code: "health.evidence.git.baseCommit.missing", message: `${task.id} branch-diff evidence has no git.baseCommit` });
    } else if (checkCommitReachability && !evidenceCommitExists(evidence.git.baseCommit)) {
      issues.push({ severity: "warn", code: "health.evidence.git.baseCommit.unknown", message: `${task.id} evidence git.baseCommit was not found: ${evidence.git.baseCommit}` });
    }
    const actualDiffHash = evidenceDiffHash(evidence);
    const shouldCheckCurrentBranchEvidence = checkCommitReachability && shouldCheckEvidenceHeadStaleness(currentBranchName, task, evidence);
    if (!actualDiffHash && shouldCheckCurrentBranchEvidence) {
      issues.push({ severity: "warn", code: "health.evidence.diffHash.missing", message: `${task.id} evidence has no diffHash` });
    } else if (actualDiffHash && shouldCheckCurrentBranchEvidence) {
      const metadataFiles = postEvidenceMetadataFiles(task.id);
      const expectedFiles = branchChangedFiles(root, evidence.git.base).filter((file) => !metadataFiles.includes(file));
      const expectedDiffHash = branchDiffHash(root, evidence.git.base, metadataFiles);
      const actualFiles = evidence.changedFiles.filter((file) => !metadataFiles.includes(file)).sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
        issues.push({ severity: "warn", code: "health.evidence.changedFiles.stale", message: `${task.id} evidence changedFiles do not match current branch diff` });
      }
      if (actualDiffHash !== expectedDiffHash) {
        issues.push({ severity: "warn", code: "health.evidence.diffHash.stale", message: `${task.id} evidence diffHash does not match current branch diff` });
      }
    }
  }
  if (node && !isDoneNode(node) && !evidence.git?.pullRequest && !approvalPullRequest) {
    issues.push({
      severity: "warn",
      code: "health.evidence.git.pullRequest.missing",
      message: `${task.id} is awaiting review but evidence has no git.pullRequest`,
      fixCommand: `npm run scwbs -- evidence annotate --task ${task.id} --pull-request <pr-number>`
    });
  }
  const currentPullRequest = currentBranchName && (currentBranchName === task.branchName || currentBranchName === evidence.git?.branch)
    ? detectCurrentPullRequest(root)
    : undefined;
  const recordedPullRequest = normalizePullRequestNumber(evidence.git?.pullRequest);
  if (currentPullRequest && recordedPullRequest !== currentPullRequest.number) {
    issues.push({
      severity: "warn",
      code: "health.evidence.git.pullRequest.currentBranch",
      message: `${task.id} current branch already has PR #${currentPullRequest.number}, but Evidence records ${recordedPullRequest ? `PR #${recordedPullRequest}` : "no PR"}`,
      fixCommand: pullRequestEvidenceCommand(task.id, currentPullRequest.number)
    });
  }

  for (const file of evidence.changedFiles) {
    const managed = matchesManagedContractPath(task, file);
    if (!matchesAny(file, task.allowedPaths) && !managed) {
      issues.push({ severity: "warn", code: "health.evidence.changedFiles.allowedPaths", message: `${file} is outside allowedPaths for ${task.id}` });
    }
    if (matchesAny(file, task.forbiddenPaths)) {
      issues.push({ severity: "error", code: "health.evidence.changedFiles.forbiddenPaths", message: `${file} is forbidden by ${task.id}` });
    }
  }
  issues.push(...humanGate.issues.map((issue) => ({
    ...issue,
    severity: "warn" as const,
    code: `health.${issue.code}`
  })));

  const changedTests = evidence.changedFiles.some((file) => /(^|\/|\\)(tests?|__tests__)(\/|\\)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  if (changedTests) {
    if (!evidence.testQuality) {
      issues.push({
        severity: "warn",
        code: "health.evidence.testQuality.missing",
        message: `${task.id} changes tests but evidence has no testQuality metadata`,
        fixCommand: `npm run scwbs -- evidence annotate --task ${task.id} --test-assertions-added true --tests-disabled false --coverage-decreased false --test-quality-note "Describe regression coverage"`
      });
    } else {
      if (evidence.testQuality.assertionsAdded === false && !hasTestQualityRationale(evidence)) {
        issues.push({
          severity: "warn",
          code: "health.evidence.testQuality.assertions",
          message: `${task.id} changes tests without recorded verification assertions`
        });
      }
      if (evidence.testQuality.testsDisabled === true) {
        issues.push({
          severity: "warn",
          code: "health.evidence.testQuality.disabled",
          message: `${task.id} evidence reports disabled or weakened tests`
        });
      }
      if (evidence.testQuality.coverageDecreased === true) {
        issues.push({
          severity: "warn",
          code: "health.evidence.testQuality.coverage",
          message: `${task.id} evidence reports decreased coverage`
        });
      }
    }
  }

  return issues;
}

function validateReviewScope(root: string, task: TaskContract, evidence: Evidence, checkCommitReachability = true): Issue[] {
  const { review, issues } = readReview(root, task.id);
  const missingOnly = issues.length === 1 && issues[0]?.code === "review.missing";
  const pullRequest = evidence.git?.pullRequest;
  if (!review) {
    return missingOnly ? [] : issues.map((issue) => ({ ...issue, code: `health.${issue.code}` }));
  }

  const readiness: Issue[] = [];
  const subjectHead = evidenceSubjectHead(evidence);
  const diffHash = evidenceDiffHash(evidence);
  const fixCommand = `npm run scwbs -- review request --task ${task.id}${pullRequest ? ` --pull-request ${pullRequest}` : ""} --force`;
  if (checkCommitReachability && review.headCommit && subjectHead && review.headCommit !== subjectHead) {
    let metadataOnlyDescendant = false;
    if (review.diffHash && review.diffHash === diffHash && isCommitAncestor(root, review.headCommit, subjectHead)) {
      try {
        metadataOnlyDescendant = changedFilesBetween(root, review.headCommit, subjectHead)
          .every((file) => isPostEvidenceMetadataFile(task.id, file));
      } catch {
        metadataOnlyDescendant = false;
      }
    }
    if (!metadataOnlyDescendant) {
      readiness.push({ severity: "warn", code: "health.review.scope.headCommit", message: `${task.id} review headCommit is not a metadata-only ancestor of Evidence subjectHeadCommit`, fixCommand });
    }
  }
  if (review.diffHash && diffHash && review.diffHash !== diffHash) {
    readiness.push({ severity: "warn", code: "health.review.scope.diffHash", message: `${task.id} review diffHash does not match Evidence diffHash`, fixCommand });
  }
  if (review.pullRequest && pullRequest && review.pullRequest !== pullRequest) {
    readiness.push({ severity: "warn", code: "health.review.scope.pullRequest", message: `${task.id} review pullRequest does not match Evidence pullRequest`, fixCommand });
  }
  if (review.status === "changes-requested") {
    readiness.push({ severity: "warn", code: "health.review.status", message: `${task.id} review has requested changes`, fixCommand });
  }
  return readiness;
}

export function collectTaskHealthIssues(root: string, taskId: string): Issue[] {
  const { task, issues: taskIssues } = readTask(root, taskId);
  if (!task) return taskIssues;
  const issues: Issue[] = [];
  const refreshReasons = taskRefreshReasons(root, taskId);
  if (!task.contractLock) {
    issues.push({ severity: "warn", code: "health.task.contractLock.missing", message: `${task.id} has no contractLock`, fixCommand: `npm run scwbs -- task lock --task ${task.id}` });
  } else if (refreshReasons.length > 0) {
    issues.push({ severity: "warn", code: "health.task.contractLock.stale", message: `${task.id} contractLock is stale: ${refreshReasons.join("; ")}`, fixCommand: `npm run scwbs -- task refresh --task ${task.id} --apply` });
  }

  let wbs: WbsDocument;
  try {
    wbs = readWbs(root);
  } catch (error) {
    issues.push({ severity: "error", code: "health.wbs.read", message: error instanceof Error ? error.message : String(error) });
    return issues;
  }
  const { evidence, issues: evidenceIssues } = readEvidence(root, taskId);
  if (!evidence) {
    issues.push(...evidenceIssues.map((issue) => ({
      ...issue,
      code: `health.${issue.code}`,
      fixCommand: `npm run scwbs -- evidence collect --task ${task.id} --force`
    })));
    return issues;
  }
  issues.push(...evidenceIssues.map((issue) => ({ ...issue, code: `health.${issue.code}` })));
  const checkCommitReachability = !isShallowRepository(root);
  issues.push(...collectEvidenceTrustIssues(root, wbs, task, evidence, { checkCommitReachability }));
  issues.push(...validateReviewScope(root, task, evidence, checkCommitReachability));
  return issues;
}

function validateRegistryHealth(contract: RegistryContract): Issue[] {
  const issues: Issue[] = [];
  if (contract.type === "spec" || contract.type === "requirement") {
    if (!contract.status) {
      issues.push({ severity: "warn", code: "health.registry.status.missing", message: `${contract.id} has no status` });
    } else if (contract.status === "draft") {
      issues.push({ severity: "warn", code: "health.registry.status.draft", message: `${contract.id} is still draft` });
    }
  }
  if (contract.type === "spec" && !contract.version) {
    issues.push({ severity: "warn", code: "health.registry.spec.version.missing", message: `${contract.id} has no version` });
  }
  return issues;
}

function validateRepositoryHealth(root: string): Issue[] {
  const issues: Issue[] = [];
  const baseStatus = baseBranchStatus(root);
  if (baseStatus.isBehind) {
    issues.push({
      severity: "warn",
      code: "health.git.baseBehind",
      message: `current branch is behind ${baseStatus.baseRef}; merge or rebase before collecting final Evidence`
    });
  }
  const collidingContractFiles = filesAddedOnBothSides(root)
    .filter((file) => /^contracts\/(tasks|evidence|approvals|changesets)\//.test(file.replace(/\\/g, "/")));
  for (const file of collidingContractFiles) {
    issues.push({
      severity: "warn",
      code: "health.git.addedPathCollision",
      message: `${file} was also added on ${baseStatus.baseRef} with different content; rename or reassign the task before merge`
    });
  }
  for (const file of filesWithCrlf(root)) {
    issues.push({
      severity: "warn",
      code: "health.workingTree.crlf",
      message: `${file} contains CRLF line endings`,
      fixCommand: `Configure .gitattributes for LF text files, then run: git add --renormalize ${file}`
    });
  }
  for (const submodulePath of dirtySubmodulePaths(root)) {
    issues.push({ severity: "warn", code: "health.submodule.dirty", message: `${submodulePath} submodule has uncommitted changes or CRLF-normalized files` });
  }
  return issues;
}

const CODE_CONTEXT_FILE_LINES_WARN = 500;
const CODE_CONTEXT_FILE_BYTES_WARN = 40_960;
const CODE_CONTEXT_FAN_OUT_WARN = 8;
const CODE_CONTEXT_PLAN_OMITTED_WARN = 20;

function collectCodeContextHealthIssues(root: string, wbs: WbsDocument | undefined): Issue[] {
  const issues: Issue[] = [];
  if (!wbs) return issues;

  if (isShallowRepository(root)) {
    return [{
      severity: "warn",
      code: "health.codeContext.skipped",
      message: "codeContext check skipped (shallow repository)"
    }];
  }

  const parseCache = new Map<string, ParsedImports>();
  const gitObjectCache = new Map<string, string | undefined>();
  const trackedFilesCache = trackedTextFiles(root);

  type FileMetric = { lines: number; bytes: number; tasks: string[] };
  const fileTooLarge = new Map<string, FileMetric>();
  const importFanOut = new Map<string, { maxCount: number; tasks: string[] }>();
  const planBudget = new Map<string, { omitted: number; selectedBytes: number; maxBytes: number }>();
  const widening = new Map<string, string[]>();

  for (const entry of listActiveTasks(root)) {
    if (!entry.task) continue;
    const association = taskWbsAssociation(wbs, entry.task);
    if (association.kind !== "node") continue;
    const node = association.node;
    if (isDoneNode(node)) continue;

    let manifest;
    try {
      manifest = buildCodeContextManifest(root, entry.task.id, {}, { parse: parseCache, gitObject: gitObjectCache, trackedFiles: trackedFilesCache });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push({
        severity: "warn",
        code: "health.codeContext.skipped",
        message: `codeContext check skipped for ${entry.task.id}: ${detail}`
      });
      continue;
    }

    for (const file of [...manifest.mustRead, ...manifest.candidates]) {
      if (file.lines > CODE_CONTEXT_FILE_LINES_WARN || file.bytes > CODE_CONTEXT_FILE_BYTES_WARN) {
        const existing = fileTooLarge.get(file.path);
        if (existing) {
          if (file.bytes > existing.bytes) {
            existing.lines = file.lines;
            existing.bytes = file.bytes;
          }
          existing.tasks.push(entry.task.id);
        } else {
          fileTooLarge.set(file.path, { lines: file.lines, bytes: file.bytes, tasks: [entry.task.id] });
        }
      }
    }

    for (const [filePath, count] of reverseImporterCounts(manifest)) {
      if (count > CODE_CONTEXT_FAN_OUT_WARN) {
        const existing = importFanOut.get(filePath);
        if (existing) {
          if (count > existing.maxCount) existing.maxCount = count;
          existing.tasks.push(entry.task.id);
        } else {
          importFanOut.set(filePath, { maxCount: count, tasks: [entry.task.id] });
        }
      }
    }

    if (manifest.budget.omitted >= CODE_CONTEXT_PLAN_OMITTED_WARN) {
      planBudget.set(entry.task.id, {
        omitted: manifest.budget.omitted,
        selectedBytes: manifest.budget.selectedBytes,
        maxBytes: manifest.budget.maxBytes
      });
    }

    if (manifest.completeness.status === "widening-required") {
      for (const reason of manifest.completeness.reasons) {
        const tasks = widening.get(reason) ?? [];
        tasks.push(entry.task.id);
        widening.set(reason, tasks);
      }
    }
  }

  function formatExamples(tasks: string[]): string {
    const examples = tasks.slice(0, 3).join(", ");
    const suffix = tasks.length > 3 ? ` and ${tasks.length - 3} more` : "";
    return `e.g., ${examples}${suffix}`;
  }

  for (const [path, metric] of fileTooLarge) {
    issues.push({
      severity: "warn",
      code: "health.codeContext.fileTooLarge",
      message: `context file ${path} is too large (${metric.lines} lines, ${metric.bytes} bytes); referenced by ${metric.tasks.length} active task plan${metric.tasks.length === 1 ? "" : "s"} (${formatExamples(metric.tasks)})`
    });
  }

  for (const [path, metric] of importFanOut) {
    issues.push({
      severity: "warn",
      code: "health.codeContext.importFanOut",
      message: `context file ${path} has ${metric.maxCount} reverse importers; referenced by ${metric.tasks.length} active task plan${metric.tasks.length === 1 ? "" : "s"} (${formatExamples(metric.tasks)})`
    });
  }

  for (const [taskId, metric] of planBudget) {
    issues.push({
      severity: "warn",
      code: "health.codeContext.planBudget",
      message: `${taskId} context plan omits ${metric.omitted} candidates (budget saturated at ${metric.selectedBytes}/${metric.maxBytes} bytes)`
    });
  }

  for (const [reason, tasks] of widening) {
    issues.push({
      severity: "warn",
      code: "health.codeContext.widening",
      message: `${tasks.length} active task plan${tasks.length === 1 ? "" : "s"} require widening (${reason}): ${formatExamples(tasks)}`
    });
  }

  return issues;
}

export function collectHealthIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  let wbs: WbsDocument | undefined;
  const checkCommitReachability = !isShallowRepository(root);

  try {
    issues.push(...validateRepositoryHealth(root));
  } catch (error) {
    issues.push({ severity: "warn", code: "health.repository.inspect", message: error instanceof Error ? error.message : String(error) });
  }

  try {
    wbs = readWbs(root);
  } catch (error) {
    issues.push({ severity: "error", code: "health.wbs.read", message: error instanceof Error ? error.message : String(error) });
  }

  const { registry, issues: registryIssues } = readRegistry(root);
  issues.push(...registryIssues);
  if (registry) {
    for (const contract of registry.contracts) {
      issues.push(...validateRegistryHealth(contract));
    }
  }

  for (const entry of listActiveTasks(root)) {
    issues.push(...entry.issues);
    if (!wbs || !entry.task) continue;

    if (!entry.task.contractLock) {
      issues.push({ severity: "warn", code: "health.task.contractLock.missing", message: `${entry.task.id} has no contractLock` });
    }

    const { evidence, issues: evidenceIssues } = readEvidence(root, entry.task.id);
    const missingEvidenceOnly = evidenceIssues.length === 1 && evidenceIssues[0]?.code === "evidence.missing";
    if (missingEvidenceOnly) continue;
    issues.push(...evidenceIssues);
    if (evidence) issues.push(...collectEvidenceTrustIssues(root, wbs, entry.task, evidence, { checkCommitReachability }));
  }

  issues.push(...collectCodeContextHealthIssues(root, wbs));

  return issues;
}

function issuePriority(issue: Issue): number {
  if (issue.severity === "error") return 0;
  if (/humanGate|approval/i.test(issue.code)) return 1;
  if (issue.fixCommand) return 2;
  return 3;
}

export function sortHealthIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) =>
    issuePriority(left) - issuePriority(right)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  );
}

export function buildHealthJsonOutput(root: string, issues = collectHealthIssues(root)): HealthJsonOutput {
  const sorted = sortHealthIssues(issues);
  const byCode = new Map<string, { code: string; severity: Issue["severity"]; count: number }>();
  for (const issue of sorted) {
    const existing = byCode.get(issue.code);
    if (existing) existing.count += 1;
    else byCode.set(issue.code, { code: issue.code, severity: issue.severity, count: 1 });
  }
  const errors = sorted.filter((issue) => issue.severity === "error").length;
  const shallow = isShallowRepository(root);
  return {
    version: "scwbs.health.v1",
    status: errors > 0 ? "fail" : sorted.length > 0 ? "warn" : "pass",
    repository: {
      shallow,
      commitReachability: shallow ? "not-evaluated" : "evaluated"
    },
    summary: {
      total: sorted.length,
      errors,
      warnings: sorted.length - errors,
      byCode: [...byCode.values()]
    },
    issues: sorted
  };
}

export function buildHealthText(root: string, issues = collectHealthIssues(root), options: HealthOptions = {}): string {
  const report = buildHealthJsonOutput(root, issues);
  if (report.status === "pass") return "PASS scwbs health\n";
  const lines = [
    `SC-WBS Health: ${report.status.toUpperCase()} (${report.summary.total} issues: ${report.summary.errors} errors, ${report.summary.warnings} warnings)`
  ];
  if (report.repository.shallow) {
    lines.push("Repository: shallow clone; commit reachability=not-evaluated");
  }
  if (options.verbose) {
    for (const issue of report.issues) {
      lines.push(`${issue.severity === "error" ? "ERROR" : "WARN"} ${issue.code}: ${issue.message}`);
      if (issue.fixCommand) lines.push(`  fixCommand: ${issue.fixCommand}`);
    }
    return `${lines.join("\n")}\n`;
  }

  const representativeLimit = Math.max(1, options.representativeLimit ?? 2);
  for (const group of report.summary.byCode) {
    const matching = report.issues.filter((issue) => issue.code === group.code);
    const prefix = group.severity === "error" ? "ERROR" : "WARN";
    if (matching.length === 1) {
      const issue = matching[0]!;
      lines.push(`${prefix} ${issue.code}: ${issue.message}`);
      if (issue.fixCommand) lines.push(`  fixCommand: ${issue.fixCommand}`);
      continue;
    }
    lines.push(`${prefix} ${group.code} (count=${matching.length})`);
    for (const issue of matching.slice(0, representativeLimit)) {
      lines.push(`  - ${issue.message}`);
    }
    const fixCommand = matching.find((issue) => issue.fixCommand)?.fixCommand;
    if (fixCommand) lines.push(`  fixCommand: ${fixCommand}`);
    const omitted = matching.length - representativeLimit;
    if (omitted > 0) lines.push(`  ... ${omitted} more omitted; rerun with --verbose`);
  }
  return `${lines.join("\n")}\n`;
}

export function runHealth(root: string, options: HealthOptions = {}): number {
  const issues = collectHealthIssues(root);
  try {
    for (const entry of listActiveTasks(root)) {
      if (!entry.task) continue;
      recordHealthLifecycleEvent(root, entry.task.id, buildHealthLifecycleEvent(collectTaskHealthIssues(root, entry.task.id)));
    }
  } catch (error) {
    console.error(`WARN health lifecycle receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const governanceCost = options.governanceCost ? buildGovernanceCostSummary(root).warningBudgets : undefined;
  if (options.json) {
    console.log(JSON.stringify({
      ...buildHealthJsonOutput(root, issues),
      ...(governanceCost ? { governanceCost } : {})
    }, null, 2));
  } else {
    process.stdout.write(buildHealthText(root, issues, options));
    if (governanceCost) {
      process.stdout.write(`Governance cost: ${governanceCost.status}; warnings=${governanceCost.warnings.length}${governanceCost.warnings.length > 0 ? ` (${governanceCost.warnings.join("; ")})` : ""}\n`);
    }
  }
  return hasErrors(issues) ? 1 : 0;
}
