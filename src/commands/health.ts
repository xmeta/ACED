import { approvalExists, listTasks, readApproval, readEvidence, readRegistry } from "../core/contracts.js";
import { commitExists } from "../core/git.js";
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

function validateEvidenceTrust(root: string, wbs: WbsDocument, task: TaskContract, evidence: Evidence): Issue[] {
  const issues: Issue[] = [];
  const node = findNode(wbs, task.wbsNodeId);
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
  if (!evidence.git?.headCommit) {
    issues.push({ severity: "warn", code: "health.evidence.git.headCommit.missing", message: `${task.id} evidence has no git.headCommit` });
  } else if (!commitExists(root, evidence.git.headCommit)) {
    issues.push({ severity: "warn", code: "health.evidence.git.headCommit.unknown", message: `${task.id} evidence git.headCommit was not found: ${evidence.git.headCommit}` });
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
      if (evidence.testQuality.assertionsAdded === false) {
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

export function collectHealthIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  let wbs: WbsDocument | undefined;

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
