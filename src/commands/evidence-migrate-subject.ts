import { readEvidence, readTask } from "../core/contracts.js";
import {
  changedFilesBetweenRefs,
  diffBinary,
  fetchPullRequestHead,
  hashDiffBinary,
  isCommitAncestor,
  isShallowRepository,
  resolveCommit
} from "../core/git.js";
import { taskLifecycleMetadataPaths } from "../core/managed-contract-paths.js";
import type { Evidence } from "../core/types.js";

export const EVIDENCE_SUBJECT_MIGRATION_SCHEMA_VERSION = "1.0.0" as const;
export const EVIDENCE_SUBJECT_MIGRATION_TYPE = "scwbs.evidence-subject-migration.v1" as const;

const MAX_RESULT_FILES = 256;
const MAX_BLOCKER_CODES = 32;

export type EvidenceSubjectMigrationStatus = "ready" | "blocked";

export type EvidenceSubjectMigrationReport = {
  schemaVersion: typeof EVIDENCE_SUBJECT_MIGRATION_SCHEMA_VERSION;
  type: typeof EVIDENCE_SUBJECT_MIGRATION_TYPE;
  status: EvidenceSubjectMigrationStatus;
  taskId: string;
  baseCommit: string | null;
  subjectHeadCommit: string | null;
  pullRequest: string | null;
  canonicalization: "git-diff-binary-v1";
  changedFiles: string[];
  diffHash: string | null;
  classifiedLifecycleMetadata: string[];
  blockerCodes: string[];
  truncated: {
    changedFiles: boolean;
    classifiedLifecycleMetadata: boolean;
    blockerCodes: boolean;
  };
};

type CommitCandidate = {
  label: string;
  value: string;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(normalizePath))].sort();
}

function normalizePullRequest(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^#?([1-9][0-9]*)$/);
  return match ? `#${match[1]}` : undefined;
}

function pullRequestNumber(value: string): string {
  return value.replace(/^#/, "");
}

function subjectCandidates(evidence: Evidence): CommitCandidate[] {
  return [
    ["subjectHeadCommit", evidence.subjectHeadCommit],
    ["git.subjectHeadCommit", evidence.git?.subjectHeadCommit],
    ["commit", evidence.commit],
    ["git.headCommit", evidence.git?.headCommit]
  ]
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([label, value]) => ({ label, value: value.trim() }));
}

function uniqueCandidateValues(candidates: CommitCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.value))];
}

function bounded(values: string[], limit: number): { values: string[]; truncated: boolean } {
  return { values: values.slice(0, limit), truncated: values.length > limit };
}

function createReport(taskId: string, values: Partial<EvidenceSubjectMigrationReport> = {}): EvidenceSubjectMigrationReport {
  return {
    schemaVersion: EVIDENCE_SUBJECT_MIGRATION_SCHEMA_VERSION,
    type: EVIDENCE_SUBJECT_MIGRATION_TYPE,
    status: "blocked",
    taskId,
    baseCommit: null,
    subjectHeadCommit: null,
    pullRequest: null,
    canonicalization: "git-diff-binary-v1",
    changedFiles: [],
    diffHash: null,
    classifiedLifecycleMetadata: [],
    blockerCodes: [],
    truncated: {
      changedFiles: false,
      classifiedLifecycleMetadata: false,
      blockerCodes: false
    },
    ...values
  };
}

function addBlocker(codes: string[], code: string): void {
  if (!codes.includes(code)) codes.push(code);
}

function readPullRequestValue(evidence: Evidence): { value?: string; invalid: boolean; mismatch: boolean } {
  const gitValue = evidence.git?.pullRequest?.trim();
  const receiptValue = evidence.ciReceipt?.pullRequest?.trim();
  const gitPullRequest = normalizePullRequest(gitValue);
  const receiptPullRequest = normalizePullRequest(receiptValue);
  return {
    value: gitPullRequest ?? receiptPullRequest,
    invalid: Boolean((gitValue && !gitPullRequest) || (receiptValue && !receiptPullRequest)),
    mismatch: Boolean(gitPullRequest && receiptPullRequest && gitPullRequest !== receiptPullRequest)
  };
}

function classifyChangedFiles(
  recorded: string[],
  canonical: string[],
  metadataFiles: string[]
): { metadata: string[]; unexpected: boolean } {
  const recordedSet = new Set(sortedUnique(recorded));
  const canonicalSet = new Set(sortedUnique(canonical));
  const differences = sortedUnique([
    ...[...recordedSet].filter((file) => !canonicalSet.has(file)),
    ...[...canonicalSet].filter((file) => !recordedSet.has(file))
  ]);
  const metadata = differences.filter((file) => metadataFiles.includes(file));
  return { metadata, unexpected: differences.some((file) => !metadataFiles.includes(file)) };
}

/**
 * Evaluate a legacy Evidence record using only immutable Git objects.  This
 * function intentionally has no write path and does not inspect the working
 * tree, registry, Review, or Approval records.
 */
export function evaluateEvidenceSubjectMigration(
  root: string,
  taskId: string,
  options: { fetchPrHead?: boolean } = {}
): EvidenceSubjectMigrationReport {
  const report = createReport(taskId);
  const taskResult = readTask(root, taskId);
  if (!taskResult.task) {
    report.blockerCodes = bounded(["task.missing"], MAX_BLOCKER_CODES).values;
    return report;
  }

  const evidenceResult = readEvidence(root, taskId);
  if (!evidenceResult.evidence) {
    const issueCodes = evidenceResult.issues.map((issue) => issue.code);
    report.blockerCodes = bounded(issueCodes.length > 0 ? issueCodes : ["evidence.missing"], MAX_BLOCKER_CODES).values;
    return report;
  }
  const evidence = evidenceResult.evidence;
  const blockers: string[] = [];

  const baseRecorded = evidence.git?.baseCommit?.trim();
  if (!baseRecorded) addBlocker(blockers, "base.missing");
  const subjectCandidatesValue = subjectCandidates(evidence);
  const subjectValues = uniqueCandidateValues(subjectCandidatesValue);
  if (subjectValues.length === 0) addBlocker(blockers, "subject.missing");
  if (subjectValues.length > 1) addBlocker(blockers, "subject.ambiguous");

  const baseCommit = baseRecorded ? resolveCommit(root, baseRecorded) : undefined;
  if (baseRecorded && !baseCommit) addBlocker(blockers, "base.unavailable");
  const subjectRecorded = subjectValues.length === 1 ? subjectValues[0] : undefined;
  const subjectCommit = subjectRecorded ? resolveCommit(root, subjectRecorded) : undefined;
  if (subjectRecorded && !subjectCommit) addBlocker(blockers, "subject.unavailable");

  report.baseCommit = baseCommit ?? (baseRecorded ?? null);
  report.subjectHeadCommit = subjectCommit ?? (subjectRecorded ?? null);

  if (isShallowRepository(root)) addBlocker(blockers, "history.shallow");
  if (baseCommit && subjectCommit && !isCommitAncestor(root, baseCommit, subjectCommit)) {
    addBlocker(blockers, "base.not-ancestor");
  }

  const pullRequest = readPullRequestValue(evidence);
  report.pullRequest = pullRequest.value ?? null;
  if (pullRequest.invalid) addBlocker(blockers, "pull-request.invalid");
  if (pullRequest.mismatch) addBlocker(blockers, "pull-request.metadata-mismatch");

  if (pullRequest.value) {
    const prNumber = pullRequestNumber(pullRequest.value);
    // A local refs/pull/* ref is not authoritative: it can be created or
    // rewritten by any local process.  Only an explicit opt-in fetch may
    // establish the PR head used for this migration plan.
    const prHead = options.fetchPrHead ? fetchPullRequestHead(root, prNumber) : undefined;
    if (!options.fetchPrHead) {
      addBlocker(blockers, "pull-request.ancestry-unavailable");
    } else if (!prHead) {
      addBlocker(blockers, "pull-request.fetch-failed");
      addBlocker(blockers, "pull-request.ancestry-unavailable");
    }
    if (!prHead) {
      // The fetch failure/unavailable blocker above is intentionally the only
      // PR provenance result when no authoritative head was obtained.
    } else if (subjectCommit && !isCommitAncestor(root, subjectCommit, prHead)) {
      addBlocker(blockers, "pull-request.ancestry-mismatch");
    }
    if (baseCommit && prHead && !isCommitAncestor(root, baseCommit, prHead)) {
      addBlocker(blockers, "pull-request.base-mismatch");
    }
  }

  const metadataFiles = taskLifecycleMetadataPaths(taskId).map(normalizePath);
  if (baseCommit && subjectCommit && !blockers.includes("base.not-ancestor")) {
    try {
      const canonicalChangedFiles = sortedUnique(changedFilesBetweenRefs(root, baseCommit, subjectCommit, metadataFiles));
      const canonicalDiffHash = hashDiffBinary(diffBinary(root, baseCommit, subjectCommit, metadataFiles));
      const changedFilesResult = bounded(canonicalChangedFiles, MAX_RESULT_FILES);
      report.changedFiles = changedFilesResult.values;
      report.truncated.changedFiles = changedFilesResult.truncated;
      report.diffHash = canonicalDiffHash;
      if (changedFilesResult.truncated) addBlocker(blockers, "result.changed-files-limit");

      const drift = classifyChangedFiles(evidence.changedFiles, canonicalChangedFiles, metadataFiles);
      const metadataResult = bounded(drift.metadata, MAX_RESULT_FILES);
      report.classifiedLifecycleMetadata = metadataResult.values;
      report.truncated.classifiedLifecycleMetadata = metadataResult.truncated;
      if (metadataResult.truncated) addBlocker(blockers, "result.metadata-drift-limit");
      if (drift.unexpected) addBlocker(blockers, "changed-files.unexpected-drift");

      const recordedDiffHash = evidence.diffHash ?? evidence.git?.diffHash;
      if (recordedDiffHash && recordedDiffHash !== canonicalDiffHash) {
        addBlocker(blockers, "diff-hash.mismatch");
      }
    } catch {
      addBlocker(blockers, "canonicalization.failed");
    }
  }

  const blockerResult = bounded([...new Set(blockers)].sort(), MAX_BLOCKER_CODES);
  report.blockerCodes = blockerResult.values;
  report.truncated.blockerCodes = blockerResult.truncated;
  report.status = report.blockerCodes.length === 0 ? "ready" : "blocked";
  return report;
}

export type EvidenceSubjectMigrationOptions = { json?: boolean; fetchPrHead?: boolean };

export function runEvidenceMigrateSubject(root: string, taskId: string, options: EvidenceSubjectMigrationOptions = {}): number {
  try {
    const report = evaluateEvidenceSubjectMigration(root, taskId, { fetchPrHead: options.fetchPrHead });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${report.status === "ready" ? "READY" : "BLOCKED"} evidence subject migration ${taskId}\n`);
      process.stdout.write(`baseCommit: ${report.baseCommit ?? "(missing)"}\n`);
      process.stdout.write(`subjectHeadCommit: ${report.subjectHeadCommit ?? "(missing)"}\n`);
      process.stdout.write(`pullRequest: ${report.pullRequest ?? "(not recorded)"}\n`);
      process.stdout.write(`changedFiles: ${report.changedFiles.length}\n`);
      process.stdout.write(`diffHash: ${report.diffHash ?? "(not computed)"}\n`);
      process.stdout.write(`blockerCodes: ${report.blockerCodes.join(", ") || "none"}\n`);
    }
    return report.status === "ready" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
