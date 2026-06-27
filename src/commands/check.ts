import { existsSync } from "node:fs";
import { approvalExists, evidenceExists, listTasks, readEvidence, readRegistry } from "../core/contracts.js";
import { resolveFrom } from "../core/paths.js";
import { hasErrors, printIssues } from "../core/report.js";
import type { Evidence, Issue, TaskContract, WbsDocument } from "../core/types.js";
import { findNode, isDoneNode, readWbs, runWjsValidate, validateWbsDocument } from "../core/wbs.js";

function validateRequiredChecks(task: TaskContract, evidence?: Evidence): Issue[] {
  if (!evidence) return [];
  const evidenceChecks = new Set(evidence.checks.map((check) => check.name));
  return task.requiredChecks
    .filter((check) => !evidenceChecks.has(check))
    .map((check) => ({
      severity: "error" as const,
      code: "evidence.check.missing",
      message: `${task.id} evidence is missing required check: ${check}`
    }));
}

function validateTaskAgainstWbs(root: string, wbs: WbsDocument, task: TaskContract): Issue[] {
  const issues: Issue[] = [];
  const node = findNode(wbs, task.wbsNodeId);
  if (!node) {
    issues.push({ severity: "error", code: "task.wbsNodeId", message: `${task.id} references missing WBS node: ${task.wbsNodeId}` });
    return issues;
  }

  const done = isDoneNode(node);
  const hasEvidence = evidenceExists(root, task.id);
  if (done && !hasEvidence) {
    issues.push({ severity: "error", code: "evidence.missing", message: `${task.id} is done but evidence is missing` });
  }

  if (hasEvidence) {
    const { evidence, issues: evidenceIssues } = readEvidence(root, task.id);
    issues.push(...evidenceIssues);
    issues.push(...validateRequiredChecks(task, evidence));
  }

  if (task.humanGateRequiredPaths.length > 0 && done && !approvalExists(root, task.id)) {
    issues.push({ severity: "warn", code: "approval.missing", message: `${task.id} touches human gate paths but no approval record was found` });
  }

  return issues;
}

export function collectCheckIssues(root: string): Issue[] {
  const issues: Issue[] = [];
  issues.push(...runWjsValidate(root));
  if (issues.some((item) => item.code === "wjs.validate")) return issues;
  issues.push(...validateWbsDocument(root));

  let wbs: WbsDocument | undefined;
  try {
    wbs = readWbs(root);
  } catch (error) {
    issues.push({ severity: "error", code: "wbs.read", message: error instanceof Error ? error.message : String(error) });
  }

  const { registry, issues: registryIssues } = readRegistry(root);
  issues.push(...registryIssues);
  if (registry) {
    for (const contract of registry.contracts) {
      if (!existsSync(resolveFrom(root, contract.path))) {
        issues.push({ severity: "error", code: "registry.path", message: `${contract.id} path does not exist: ${contract.path}` });
      }
    }
  }

  for (const entry of listTasks(root)) {
    issues.push(...entry.issues);
    if (wbs && entry.task) issues.push(...validateTaskAgainstWbs(root, wbs, entry.task));
  }

  return issues;
}

export function runCheck(root: string): number {
  const issues = collectCheckIssues(root);
  if (issues.length === 0) {
    console.log("PASS scwbs check");
    return 0;
  }
  printIssues(issues);
  return hasErrors(issues) ? 1 : 0;
}
