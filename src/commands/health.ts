import { approvalExists, listTasks, readApproval, readEvidence, readRegistry } from "../core/contracts.js";
import { baseBranchStatus, branchChangedFiles, branchDiffHash, changedFilesSince, commitExists, currentBranch, dirtySubmodulePaths, filesAddedOnBothSides, filesWithCrlf, headCommit } from "../core/git.js";
import { matchesAny } from "../core/glob.js";
import { hasErrors, printIssues } from "../core/report.js";
import type { Evidence, Issue, RegistryContract, TaskContract, WbsDocument } from "../core/types.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";

type EvidenceLevel = "A" | "B" | "C";

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
  return normalized === `contracts/evidence/${taskId}.yaml`
    || normalized === `contracts/approvals/${taskId}.yaml`
    || normalized === `contracts/reviews/${taskId}.yaml`
    || normalized === "contracts/registry.yaml";
}

function postEvidenceMetadataFiles(taskId: string): string[] {
  return [
    `contracts/evidence/${taskId}.yaml`,
    `contracts/approvals/${taskId}.yaml`,
    `contracts/reviews/${taskId}.yaml`,
    "contracts/registry.yaml"
  ];
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

function validateEvidenceTrust(root: string, wbs: WbsDocument, task: TaskContract, evidence: Evidence): Issue[] {
  const issues: Issue[] = [];
  const node = findNode(wbs, task.wbsNodeId);
  const currentHead = headCommit(root);
  const currentBranchName = currentBranch(root);
  const { approval, issues: approvalIssues } = readApproval(root, task.id);
  const missingApprovalOnly = approvalIssues.length === 1 && approvalIssues[0]?.code === "approval.missing";
  const approvalPullRequest = approval?.pullRequest;
  const hasApproval = Boolean(approval) && !missingApprovalOnly;

  if (node && isDoneNode(node) && strongestEvidenceLevel(evidence) === "C") {
    issues.push({
      severity: "warn",
      code: "health.evidence.lowTrust",
      message: `${task.id} is done but evidence only has Level C checks`
    });
  }

  const checksByName = new Map(evidence.checks.map((check) => [check.name, check]));
  for (const requiredCheck of task.requiredChecks) {
    const check = checksByName.get(requiredCheck);
    if (check && evidenceCheckLevel(check) === "C") {
      issues.push({
        severity: "warn",
        code: "health.evidence.check.lowTrust",
        message: `${task.id} required check ${requiredCheck} has no verifiable source metadata`
      });
    }
  }

  if (!evidence.commit) {
    issues.push({ severity: "warn", code: "health.evidence.commit.missing", message: `${task.id} evidence has no commit` });
  } else if (!commitExists(root, evidence.commit)) {
    issues.push({ severity: "warn", code: "health.evidence.commit.unknown", message: `${task.id} evidence commit was not found: ${evidence.commit}` });
  }

  if (!evidence.git?.branch && !task.branchName) {
    issues.push({ severity: "warn", code: "health.evidence.git.branch.missing", message: `${task.id} evidence has no branch metadata` });
  }
  const subjectHead = evidenceSubjectHead(evidence);
  if (!subjectHead) {
    issues.push({ severity: "warn", code: "health.evidence.subjectHeadCommit.missing", message: `${task.id} evidence has no subjectHeadCommit` });
  } else if (!commitExists(root, subjectHead)) {
    issues.push({ severity: "warn", code: "health.evidence.subjectHeadCommit.unknown", message: `${task.id} evidence subjectHeadCommit was not found: ${subjectHead}` });
  } else if (
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
    } else if (!commitExists(root, evidence.git.baseCommit)) {
      issues.push({ severity: "warn", code: "health.evidence.git.baseCommit.unknown", message: `${task.id} evidence git.baseCommit was not found: ${evidence.git.baseCommit}` });
    }
    const actualDiffHash = evidenceDiffHash(evidence);
    if (!actualDiffHash) {
      issues.push({ severity: "warn", code: "health.evidence.diffHash.missing", message: `${task.id} evidence has no diffHash` });
    } else if (shouldCheckEvidenceHeadStaleness(currentBranchName, task, evidence)) {
      const expectedFiles = branchChangedFiles(root, evidence.git.base);
      const expectedDiffHash = branchDiffHash(root, evidence.git.base, postEvidenceMetadataFiles(task.id));
      const actualFiles = [...evidence.changedFiles].sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
        issues.push({ severity: "warn", code: "health.evidence.changedFiles.stale", message: `${task.id} evidence changedFiles do not match current branch diff` });
      }
      if (actualDiffHash !== expectedDiffHash) {
        issues.push({ severity: "warn", code: "health.evidence.diffHash.stale", message: `${task.id} evidence diffHash does not match current branch diff` });
      }
    }
  }
  if (node && !isDoneNode(node) && !evidence.git?.pullRequest && !approvalPullRequest) {
    issues.push({ severity: "warn", code: "health.evidence.git.pullRequest.missing", message: `${task.id} is awaiting review but evidence has no git.pullRequest` });
  }

  for (const file of evidence.changedFiles) {
    if (task.allowedPaths.length > 0 && !matchesAny(file, task.allowedPaths)) {
      issues.push({ severity: "warn", code: "health.evidence.changedFiles.allowedPaths", message: `${file} is outside allowedPaths for ${task.id}` });
    }
    if (matchesAny(file, task.forbiddenPaths)) {
      issues.push({ severity: "error", code: "health.evidence.changedFiles.forbiddenPaths", message: `${file} is forbidden by ${task.id}` });
    }
    if (matchesAny(file, task.humanGateRequiredPaths) && !hasApproval) {
      issues.push({ severity: "warn", code: "health.evidence.changedFiles.humanGate", message: `${file} requires human gate approval for ${task.id}` });
    }
  }

  const changedTests = evidence.changedFiles.some((file) => /(^|\/|\\)(tests?|__tests__)(\/|\\)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  if (changedTests) {
    if (!evidence.testQuality) {
      issues.push({
        severity: "warn",
        code: "health.evidence.testQuality.missing",
        message: `${task.id} changes tests but evidence has no testQuality metadata`
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
    issues.push({ severity: "warn", code: "health.workingTree.crlf", message: `${file} contains CRLF line endings` });
  }
  for (const submodulePath of dirtySubmodulePaths(root)) {
    issues.push({ severity: "warn", code: "health.submodule.dirty", message: `${submodulePath} submodule has uncommitted changes or CRLF-normalized files` });
  }
  return issues;
}

export function collectHealthIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  let wbs: WbsDocument | undefined;

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

  for (const entry of listTasks(root)) {
    issues.push(...entry.issues);
    if (!wbs || !entry.task) continue;

    if (!entry.task.contractLock) {
      issues.push({ severity: "warn", code: "health.task.contractLock.missing", message: `${entry.task.id} has no contractLock` });
    }

    const { evidence, issues: evidenceIssues } = readEvidence(root, entry.task.id);
    const missingEvidenceOnly = evidenceIssues.length === 1 && evidenceIssues[0]?.code === "evidence.missing";
    if (missingEvidenceOnly) continue;
    issues.push(...evidenceIssues);
    if (evidence) issues.push(...validateEvidenceTrust(root, wbs, entry.task, evidence));
  }

  return issues;
}

export function runHealth(root: string): number {
  const issues = collectHealthIssues(root);
  if (issues.length === 0) {
    console.log("PASS scwbs health");
    return 0;
  }
  printIssues(issues);
  return hasErrors(issues) ? 1 : 0;
}
