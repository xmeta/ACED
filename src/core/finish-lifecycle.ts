import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readEvidence } from "./contracts.js";
import { changedFilesBetween, headCommit, isCommitAncestor, isShallowRepository } from "./git.js";
import { gitCommonDir } from "./required-check-run.js";

export const finishLifecycleEventLimit = 50;
export const finishLifecycleTaskLimit = 100;

export type FinishLifecycleEvent = {
  runMode: "preflight" | "full";
  startedAt: string;
  endedAt: string;
  durationMilliseconds: number;
  phase: string;
  outcome: string;
  exitCode: number;
  mutatedFileCount: number;
  subjectHeadCommit: string | null;
  headCommit: string | null;
  verifiedMetadataAncestryCount: number | null;
};

export type FinishLifecycleReceipt = {
  schemaVersion: "1.0.0";
  taskId: string;
  historyTruncated: boolean;
  events: FinishLifecycleEvent[];
};

export type FinishLifecycleTerminalOutput = {
  phase: string;
  outcome: string;
  mutatedFiles: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isFinishLifecycleEvent(value: unknown): value is FinishLifecycleEvent {
  if (!isRecord(value)) return false;
  return (value.runMode === "preflight" || value.runMode === "full")
    && isIsoDate(value.startedAt)
    && isIsoDate(value.endedAt)
    && typeof value.durationMilliseconds === "number"
    && value.durationMilliseconds >= 0
    && typeof value.phase === "string"
    && typeof value.outcome === "string"
    && Number.isInteger(value.exitCode)
    && typeof value.mutatedFileCount === "number"
    && Number.isInteger(value.mutatedFileCount)
    && value.mutatedFileCount >= 0
    && isNullableString(value.subjectHeadCommit)
    && isNullableString(value.headCommit)
    && isNullableNonNegativeInteger(value.verifiedMetadataAncestryCount);
}

export function isFinishLifecycleReceipt(value: unknown): value is FinishLifecycleReceipt {
  return isRecord(value)
    && value.schemaVersion === "1.0.0"
    && typeof value.taskId === "string"
    && typeof value.historyTruncated === "boolean"
    && Array.isArray(value.events)
    && value.events.length <= finishLifecycleEventLimit
    && value.events.every(isFinishLifecycleEvent);
}

export function finishLifecycleDirectory(root: string): string {
  return path.join(gitCommonDir(root), "scwbs-finish-lifecycle");
}

function receiptPath(root: string, taskId: string): string {
  return path.join(finishLifecycleDirectory(root), `${encodeURIComponent(taskId)}.json`);
}

function approvedMetadataFiles(taskId: string): Set<string> {
  return new Set([
    `contracts/evidence/${taskId}.yaml`,
    `contracts/approvals/${taskId}.yaml`,
    `contracts/reviews/${taskId}.yaml`,
    "contracts/registry.yaml"
  ]);
}

function commitCount(root: string, from: string, to: string): number {
  const output = execFileSync("git", ["rev-list", "--count", `${from}..${to}`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const count = Number(output);
  if (!Number.isInteger(count) || count < 0) throw new Error("Invalid git rev-list count");
  return count;
}

export function verifiedMetadataAncestryCount(
  root: string,
  taskId: string,
  subjectHeadCommit: string | null,
  currentHeadCommit: string | null
): number | null {
  if (!subjectHeadCommit || !currentHeadCommit || isShallowRepository(root)) return null;
  try {
    if (!isCommitAncestor(root, subjectHeadCommit, currentHeadCommit)) return null;
    const allowed = approvedMetadataFiles(taskId);
    const changedFiles = changedFilesBetween(root, subjectHeadCommit, currentHeadCommit)
      .map((file) => file.replace(/\\/g, "/"));
    if (changedFiles.some((file) => !allowed.has(file))) return null;
    return commitCount(root, subjectHeadCommit, currentHeadCommit);
  } catch {
    return null;
  }
}

function readExistingReceipt(root: string, taskId: string): FinishLifecycleReceipt | undefined {
  const file = receiptPath(root, taskId);
  if (!existsSync(file)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isFinishLifecycleReceipt(value) && value.taskId === taskId ? value : undefined;
  } catch {
    return undefined;
  }
}

function pruneTaskReceipts(root: string, protectedFile: string): void {
  const directory = finishLifecycleDirectory(root);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      let observedAt = statSync(file).mtime.toISOString();
      try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (isFinishLifecycleReceipt(value)) observedAt = value.events.at(-1)?.endedAt ?? observedAt;
      } catch {
        // A corrupt receipt remains bounded using its filesystem timestamp.
      }
      return { file, observedAt, name: entry.name };
    })
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.name.localeCompare(right.name));
  while (files.length > finishLifecycleTaskLimit) {
    const candidateIndex = files.findIndex((entry) => entry.file !== protectedFile);
    if (candidateIndex < 0) break;
    const [candidate] = files.splice(candidateIndex, 1);
    if (candidate) unlinkSync(candidate.file);
  }
}

export function recordFinishLifecycleEvent(root: string, taskId: string, event: FinishLifecycleEvent): void {
  const directory = finishLifecycleDirectory(root);
  mkdirSync(directory, { recursive: true });
  const file = receiptPath(root, taskId);
  const existing = readExistingReceipt(root, taskId);
  const combined = [...(existing?.events ?? []), event];
  const truncated = combined.length > finishLifecycleEventLimit;
  const receipt: FinishLifecycleReceipt = {
    schemaVersion: "1.0.0",
    taskId,
    historyTruncated: (existing === undefined && existsSync(file)) || existing?.historyTruncated === true || truncated,
    events: combined.slice(-finishLifecycleEventLimit)
  };
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  pruneTaskReceipts(root, file);
}

export function buildFinishLifecycleEvent(
  root: string,
  taskId: string,
  startedAt: Date,
  endedAt: Date,
  exitCode: number,
  output: FinishLifecycleTerminalOutput,
  preflight: boolean
): FinishLifecycleEvent {
  const evidence = readEvidence(root, taskId).evidence;
  const subjectHeadCommit = evidence?.subjectHeadCommit
    ?? evidence?.git?.subjectHeadCommit
    ?? evidence?.git?.headCommit
    ?? evidence?.commit
    ?? null;
  let currentHeadCommit: string | null = null;
  try {
    currentHeadCommit = headCommit(root) ?? null;
  } catch {
    currentHeadCommit = null;
  }
  return {
    runMode: preflight ? "preflight" : "full",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMilliseconds: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    phase: output.phase,
    outcome: output.outcome,
    exitCode,
    mutatedFileCount: output.mutatedFiles.length,
    subjectHeadCommit,
    headCommit: currentHeadCommit,
    verifiedMetadataAncestryCount: verifiedMetadataAncestryCount(root, taskId, subjectHeadCommit, currentHeadCommit)
  };
}
