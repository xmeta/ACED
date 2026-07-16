import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Evidence } from "./types.js";
import { gitCommonDir } from "./required-check-run.js";

export type CheckReceipt = {
  schemaVersion: "1.0.0";
  taskId: string;
  createdAt: string;
  headCommit: string;
  subjectFingerprint: string;
  provenance: CheckReceiptProvenance;
  checks: Evidence["checks"];
};

export type CheckReceiptProvenance = {
  nodeVersion: string;
  platform: string;
  lockfiles: Array<{ path: string; sha256: string | null }>;
  submoduleStatus: string[];
};

const dependencyLockfiles = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"
];

export function collectCheckReceiptProvenance(root: string): CheckReceiptProvenance {
  const submodules = spawnSync("git", ["-c", "core.quotePath=false", "submodule", "status", "--recursive"], {
    cwd: root,
    encoding: "utf8"
  });
  if (submodules.status !== 0) throw new Error(submodules.stderr || "Unable to collect submodule provenance");
  return {
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    lockfiles: dependencyLockfiles.map((relativePath) => {
      const fullPath = path.join(root, relativePath);
      return {
        path: relativePath,
        sha256: existsSync(fullPath) ? createHash("sha256").update(readFileSync(fullPath)).digest("hex") : null
      };
    }),
    submoduleStatus: submodules.stdout.split(/\r?\n/).filter(Boolean)
  };
}

export type CheckReceiptReadResult = {
  receipt?: CheckReceipt;
  reason: "receipt-missing" | "receipt-invalid" | "task-mismatch" | "head-mismatch" | "subject-mismatch" | "provenance-mismatch" | "receipt-valid";
};

export function checkReceiptPath(root: string, taskId: string): string {
  return path.join(gitCommonDir(root), "scwbs-check-receipts", `${encodeURIComponent(taskId)}.json`);
}

export function isCheckReceipt(value: unknown): value is CheckReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<CheckReceipt>;
  return receipt.schemaVersion === "1.0.0"
    && typeof receipt.taskId === "string"
    && typeof receipt.createdAt === "string"
    && typeof receipt.headCommit === "string"
    && typeof receipt.subjectFingerprint === "string"
    && !!receipt.provenance
    && typeof receipt.provenance.nodeVersion === "string"
    && typeof receipt.provenance.platform === "string"
    && Array.isArray(receipt.provenance.lockfiles)
    && Array.isArray(receipt.provenance.submoduleStatus)
    && Array.isArray(receipt.checks)
    && receipt.checks.every((check) => check
      && typeof check.name === "string"
      && check.status === "passed"
      && typeof check.command === "string"
      && typeof check.cacheKey === "string"
      && typeof check.executedAt === "string"
      && (check.durationMilliseconds === undefined
        || (typeof check.durationMilliseconds === "number"
          && Number.isFinite(check.durationMilliseconds)
          && check.durationMilliseconds >= 0)));
}

export function readCheckReceipt(root: string, expected: {
  taskId: string;
  headCommit: string;
  subjectFingerprint: string;
  provenance: CheckReceiptProvenance;
}): CheckReceiptReadResult {
  const receiptPath = checkReceiptPath(root, expected.taskId);
  if (!existsSync(receiptPath)) return { reason: "receipt-missing" };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    return { reason: "receipt-invalid" };
  }
  if (!isCheckReceipt(value)) return { reason: "receipt-invalid" };
  if (value.taskId !== expected.taskId) return { reason: "task-mismatch" };
  if (value.headCommit !== expected.headCommit) return { reason: "head-mismatch" };
  if (value.subjectFingerprint !== expected.subjectFingerprint) return { reason: "subject-mismatch" };
  if (JSON.stringify(value.provenance) !== JSON.stringify(expected.provenance)) return { reason: "provenance-mismatch" };
  return { receipt: value, reason: "receipt-valid" };
}

export function writeCheckReceipt(root: string, receipt: CheckReceipt): string {
  const receiptPath = checkReceiptPath(root, receipt.taskId);
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, receiptPath);
  return receiptPath;
}

export function removeCheckReceipt(root: string, taskId: string): void {
  rmSync(checkReceiptPath(root, taskId), { force: true });
}
