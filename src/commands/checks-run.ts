import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { readTask } from "../core/contracts.js";
import { buildCheckCacheKey, buildCheckCacheSubject } from "../core/check-cache.js";
import { resolveCheckCommand } from "../core/check-catalog.js";
import { checkReceiptPath, collectCheckReceiptProvenance, readCheckReceipt, removeCheckReceipt, writeCheckReceipt } from "../core/check-receipt.js";
import { headCommit } from "../core/git.js";
import type { Evidence, EvidenceCheckStatus } from "../core/types.js";
import {
  acquireRequiredCheckRun,
  formatRequiredCheckProgress,
  releaseRequiredCheckRun,
  startRequiredCheckHeartbeat,
  stopRequiredCheckHeartbeat,
  updateRequiredCheckRun,
  type RequiredCheckRunLease
} from "../core/required-check-run.js";

const maxOutputLength = 1000;

export type ChecksRunSummary = {
  schemaVersion: "1.0.0";
  status: "pass" | "fail";
  taskId: string;
  headCommit: string;
  subjectFingerprint: string;
  receiptPath: string | null;
  receiptReason: string;
  checks: Array<{
    name: string;
    status: EvidenceCheckStatus;
    disposition: "executed" | "reused" | "not-run";
    reason: string;
    command: string;
    cacheKey: string;
    exitStatus?: number;
    stdoutSummary?: string;
    stderrSummary?: string;
  }>;
};

export type ChecksRunOptions = { baseRef?: string; rerunChecks?: boolean; json?: boolean };

function metadataFiles(taskId: string): string[] {
  return [
    `contracts/evidence/${taskId}.yaml`,
    `contracts/approvals/${taskId}.yaml`,
    `contracts/reviews/${taskId}.yaml`,
    "contracts/registry.yaml"
  ];
}

function summarize(value: string | null | undefined): string | undefined {
  const normalized = (value ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxOutputLength) return normalized;
  const diagnosticsIndex = normalized.indexOf("\nfailed test=");
  if (diagnosticsIndex >= 0) {
    const diagnostics = normalized.slice(diagnosticsIndex + 1);
    const marker = "\n[truncated]\n";
    const headLength = 750;
    return `${diagnostics.slice(0, headLength)}${marker}${diagnostics.slice(-(maxOutputLength - headLength - marker.length))}`;
  }
  const marker = "\n[truncated]\n";
  const edge = Math.floor((maxOutputLength - marker.length) / 2);
  return `${normalized.slice(0, edge)}${marker}${normalized.slice(-edge)}`;
}

function executeCheck(root: string, taskId: string, check: string, cacheKey: string, lease: RequiredCheckRunLease, index: number): Evidence["checks"][number] {
  const command = resolveCheckCommand(check);
  updateRequiredCheckRun(lease, check, index);
  process.stderr.write(`${formatRequiredCheckProgress(lease.state, "executed")}\n`);
  const heartbeat = startRequiredCheckHeartbeat(lease);
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(command[0] ?? "npm", command.slice(1), {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32"
    });
  } finally {
    stopRequiredCheckHeartbeat(heartbeat);
  }
  const status: EvidenceCheckStatus = result.status === 0 ? "passed" : "failed";
  process.stderr.write(`${formatRequiredCheckProgress(lease.state, status)}\n`);
  return {
    name: check,
    status,
    source: "local",
    command: command.join(" "),
    cacheKey,
    executedAt: new Date().toISOString(),
    ...(typeof result.status === "number" && status === "failed" ? { exitStatus: result.status } : {}),
    ...(status === "failed" && summarize(result.stdout) ? { stdoutSummary: summarize(result.stdout) } : {}),
    ...(status === "failed" && summarize(result.stderr) ? { stderrSummary: summarize(result.stderr) } : {})
  };
}

export function buildChecksRunSummary(root: string, taskId: string, options: ChecksRunOptions = {}): ChecksRunSummary {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const baseRef = options.baseRef ?? "origin/main";
  const head = headCommit(root);
  if (!head) throw new Error("Unable to resolve HEAD");
  const subject = buildCheckCacheSubject(root, { baseRef, excludedMetadataFiles: metadataFiles(taskId) });
  const provenance = collectCheckReceiptProvenance(root);
  const receiptRead = readCheckReceipt(root, { taskId, headCommit: head, subjectFingerprint: subject.fingerprint, provenance });
  const expected = task.requiredChecks.map((name) => {
    const command = resolveCheckCommand(name);
    return { name, command, commandText: command.join(" "), cacheKey: buildCheckCacheKey(subject, name, command) };
  });
  const reusable = !options.rerunChecks && subject.reusable && receiptRead.receipt
    ? expected.map((item) => receiptRead.receipt?.checks.find((check) => check.name === item.name
      && check.status === "passed" && check.command === item.commandText && check.cacheKey === item.cacheKey))
    : [];
  if (reusable.length === expected.length && reusable.every(Boolean)) {
    return {
      schemaVersion: "1.0.0",
      status: "pass",
      taskId,
      headCommit: head,
      subjectFingerprint: subject.fingerprint,
      receiptPath: path.relative(root, checkReceiptPath(root, taskId)),
      receiptReason: "receipt-valid",
      checks: expected.map((item) => ({
        name: item.name,
        status: "passed",
        disposition: "reused",
        reason: "exact-receipt-match",
        command: item.commandText,
        cacheKey: item.cacheKey
      }))
    };
  }

  removeCheckReceipt(root, taskId);
  const lease = acquireRequiredCheckRun(root, taskId, expected.length);
  const checks: Evidence["checks"] = [];
  try {
    for (const [index, item] of expected.entries()) {
      const result = executeCheck(root, taskId, item.name, item.cacheKey, lease, index + 1);
      checks.push(result);
      if (result.status !== "passed") break;
    }
  } finally {
    releaseRequiredCheckRun(lease);
  }
  const passed = checks.length === expected.length && checks.every((check) => check.status === "passed");
  const receiptPath = passed ? writeCheckReceipt(root, {
    schemaVersion: "1.0.0",
    taskId,
    createdAt: new Date().toISOString(),
    headCommit: head,
    subjectFingerprint: subject.fingerprint,
    provenance,
    checks
  }) : undefined;
  const executionReason = options.rerunChecks ? "forced-rerun" : subject.reusable ? receiptRead.reason : "subject-not-reusable";
  return {
    schemaVersion: "1.0.0",
    status: passed ? "pass" : "fail",
    taskId,
    headCommit: head,
    subjectFingerprint: subject.fingerprint,
    receiptPath: receiptPath ? path.relative(root, receiptPath) : null,
    receiptReason: passed ? "receipt-written" : "check-failed-no-receipt",
    checks: expected.map((item) => {
      const check = checks.find((candidate) => candidate.name === item.name);
      if (!check) return {
        name: item.name,
        status: "skipped" as const,
        disposition: "not-run" as const,
        reason: "prior-check-failed",
        command: item.commandText,
        cacheKey: item.cacheKey
      };
      return {
        name: check.name,
        status: check.status,
        disposition: "executed" as const,
        reason: executionReason,
        command: check.command ?? "",
        cacheKey: check.cacheKey ?? "",
        ...(check.exitStatus !== undefined ? { exitStatus: check.exitStatus } : {}),
        ...(check.stdoutSummary ? { stdoutSummary: check.stdoutSummary } : {}),
        ...(check.stderrSummary ? { stderrSummary: check.stderrSummary } : {})
      };
    })
  };
}

export function formatChecksRunSummary(summary: ChecksRunSummary): string {
  return [
    `${summary.status === "pass" ? "PASS" : "FAIL"} required checks`,
    `task: ${summary.taskId}`,
    `receipt: ${summary.receiptPath ?? "(not written)"}`,
    `reason: ${summary.receiptReason}`,
    ...summary.checks.flatMap((check) => [
      `${check.name}: ${check.status} (${check.disposition}, ${check.reason})`,
      ...(check.stdoutSummary ? [`stdout: ${check.stdoutSummary}`] : []),
      ...(check.stderrSummary ? [`stderr: ${check.stderrSummary}`] : [])
    ])
  ].join("\n") + "\n";
}

export function runChecksRun(root: string, taskId: string, options: ChecksRunOptions = {}): number {
  try {
    const summary = buildChecksRunSummary(root, taskId, options);
    process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : formatChecksRunSummary(summary));
    return summary.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
