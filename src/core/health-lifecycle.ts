import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Issue } from "./types.js";
import { gitCommonDir } from "./required-check-run.js";

export const healthLifecycleEventLimit = 50;
export const healthLifecycleTaskLimit = 100;

export type HealthLifecycleEvent = {
  observedAt: string;
  warningCount: number;
  errorCount: number;
  byCode: Array<{ code: string; warningCount: number; errorCount: number }>;
};

export type HealthLifecycleReceipt = {
  schemaVersion: "1.0.0";
  taskId: string;
  historyTruncated: boolean;
  events: HealthLifecycleEvent[];
};

export function healthLifecycleDirectory(root: string): string {
  return path.join(gitCommonDir(root), "scwbs-health-lifecycle");
}

function receiptPath(root: string, taskId: string): string {
  return path.join(healthLifecycleDirectory(root), `${encodeURIComponent(taskId)}.json`);
}

export function buildHealthLifecycleEvent(issues: Issue[], observedAt = new Date()): HealthLifecycleEvent {
  const grouped = new Map<string, { code: string; warningCount: number; errorCount: number }>();
  for (const issue of issues) {
    const item = grouped.get(issue.code) ?? { code: issue.code, warningCount: 0, errorCount: 0 };
    if (issue.severity === "error") item.errorCount += 1;
    else item.warningCount += 1;
    grouped.set(issue.code, item);
  }
  return {
    observedAt: observedAt.toISOString(),
    warningCount: issues.filter((issue) => issue.severity === "warn").length,
    errorCount: issues.filter((issue) => issue.severity === "error").length,
    byCode: [...grouped.values()].sort((left, right) => left.code.localeCompare(right.code))
  };
}

function isEvent(value: unknown): value is HealthLifecycleEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.observedAt === "string" && Number.isFinite(Date.parse(event.observedAt))
    && Number.isInteger(event.warningCount) && (event.warningCount as number) >= 0
    && Number.isInteger(event.errorCount) && (event.errorCount as number) >= 0
    && Array.isArray(event.byCode);
}

export function isHealthLifecycleReceipt(value: unknown): value is HealthLifecycleReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.schemaVersion === "1.0.0" && typeof receipt.taskId === "string"
    && typeof receipt.historyTruncated === "boolean" && Array.isArray(receipt.events)
    && receipt.events.length <= healthLifecycleEventLimit && receipt.events.every(isEvent);
}

function prune(root: string, protectedFile: string): void {
  const directory = healthLifecycleDirectory(root);
  const files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      let observedAt = statSync(file).mtime.toISOString();
      try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (isHealthLifecycleReceipt(value)) observedAt = value.events.at(-1)?.observedAt ?? observedAt;
      } catch {}
      return { file, observedAt, name: entry.name };
    }).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.name.localeCompare(right.name));
  while (files.length > healthLifecycleTaskLimit) {
    const index = files.findIndex((entry) => entry.file !== protectedFile);
    if (index < 0) break;
    const [removed] = files.splice(index, 1);
    if (removed) unlinkSync(removed.file);
  }
}

export function recordHealthLifecycleEvent(root: string, taskId: string, event: HealthLifecycleEvent): void {
  const directory = healthLifecycleDirectory(root);
  mkdirSync(directory, { recursive: true });
  const file = receiptPath(root, taskId);
  let existing: HealthLifecycleReceipt | undefined;
  if (existsSync(file)) {
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isHealthLifecycleReceipt(value) && value.taskId === taskId) existing = value;
    } catch {}
  }
  const events = [...(existing?.events ?? []), event];
  const receipt: HealthLifecycleReceipt = {
    schemaVersion: "1.0.0",
    taskId,
    historyTruncated: (existsSync(file) && !existing) || existing?.historyTruncated === true || events.length > healthLifecycleEventLimit,
    events: events.slice(-healthLifecycleEventLimit)
  };
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  prune(root, file);
}
