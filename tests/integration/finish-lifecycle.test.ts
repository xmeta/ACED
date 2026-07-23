import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runFinish } from "../../src/commands/finish.js";
import { buildLocalLifecycleSummary } from "../../src/commands/metrics.js";
import { runTaskLock } from "../../src/commands/task-lock.js";
import {
  finishLifecycleDirectory,
  finishLifecycleEventLimit,
  finishLifecycleTaskLimit,
  isFinishLifecycleReceipt,
  recordFinishLifecycleEvent,
  verifiedMetadataAncestryCount,
  type FinishLifecycleEvent
} from "../../src/core/finish-lifecycle.js";
import { makeTempRepo, sampleTask, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

function event(overrides: Partial<FinishLifecycleEvent> = {}): FinishLifecycleEvent {
  return {
    runMode: "full",
    startedAt: "2026-07-23T00:00:00.000Z",
    endedAt: "2026-07-23T00:00:01.000Z",
    durationMilliseconds: 1000,
    phase: "required-checks",
    outcome: "required-check-failed",
    exitCode: 1,
    mutatedFileCount: 0,
    subjectHeadCommit: null,
    headCommit: null,
    verifiedMetadataAncestryCount: null,
    ...overrides
  };
}

function readReceipt(root: string, taskId: string): unknown {
  return JSON.parse(readFileSync(path.join(finishLifecycleDirectory(root), `${encodeURIComponent(taskId)}.json`), "utf8"));
}

describe("finish lifecycle receipts", () => {
  test("finish preflight records one Task-local event without changing the worktree", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(runTaskLock(root, "WBS-001-004")).toBe(0);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "HEAD", preflight: true, json: true })).toBe(0);
    } finally {
      log.mockRestore();
    }
    const receipt = readReceipt(root, "WBS-001-004");
    expect(isFinishLifecycleReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({
      taskId: "WBS-001-004",
      historyTruncated: false,
      events: [{
        runMode: "preflight",
        phase: "preflight",
        outcome: "ready",
        exitCode: 0,
        mutatedFileCount: 0
      }]
    });
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(before);
  });

  test("finish full records its completed terminal outcome", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "master",
      allowedPaths: ["contracts/**"],
      humanGateRequiredPaths: [],
      requiredChecks: []
    }) as unknown as Record<string, unknown>);
    expect(runTaskLock(root, "WBS-001-004")).toBe(0);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "HEAD", json: true })).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(readReceipt(root, "WBS-001-004")).toMatchObject({
      events: [{
        runMode: "full",
        phase: "complete",
        outcome: "completed",
        exitCode: 0
      }]
    });
  });

  test("bounds events per Task and receipts per repository", () => {
    const root = makeTempRepo();
    for (let index = 0; index < finishLifecycleEventLimit + 5; index += 1) {
      recordFinishLifecycleEvent(root, "TASK-EVENTS", event({
        endedAt: `2026-07-23T00:00:${String(index).padStart(2, "0")}.000Z`
      }));
    }
    const bounded = readReceipt(root, "TASK-EVENTS");
    expect(isFinishLifecycleReceipt(bounded)).toBe(true);
    if (!isFinishLifecycleReceipt(bounded)) throw new Error("invalid receipt");
    expect(bounded.historyTruncated).toBe(true);
    expect(bounded.events).toHaveLength(finishLifecycleEventLimit);

    for (let index = 0; index < finishLifecycleTaskLimit + 1; index += 1) {
      recordFinishLifecycleEvent(root, `TASK-${String(index).padStart(3, "0")}`, event({
        endedAt: `2026-07-24T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`
      }));
    }
    expect(readdirSync(finishLifecycleDirectory(root)).filter((file) => file.endsWith(".json"))).toHaveLength(finishLifecycleTaskLimit);
    expect(readdirSync(finishLifecycleDirectory(root))).not.toContain("TASK-EVENTS.json");
  });

  test("summarizes outcomes, convergence, corruption, and a bounded Task trend", () => {
    const root = makeTempRepo();
    recordFinishLifecycleEvent(root, "TASK-CONVERGED", event());
    recordFinishLifecycleEvent(root, "TASK-CONVERGED", event({
      runMode: "preflight",
      startedAt: "2026-07-23T00:00:02.000Z",
      endedAt: "2026-07-23T00:00:03.000Z",
      phase: "preflight",
      outcome: "ready",
      exitCode: 0
    }));
    recordFinishLifecycleEvent(root, "TASK-CONVERGED", event({
      startedAt: "2026-07-23T00:00:04.000Z",
      endedAt: "2026-07-23T00:00:05.000Z",
      phase: "complete",
      outcome: "completed",
      exitCode: 0,
      verifiedMetadataAncestryCount: 2
    }));
    recordFinishLifecycleEvent(root, "TASK-BLOCKED", event({
      endedAt: "2026-07-23T00:00:06.000Z",
      phase: "readiness",
      outcome: "readiness-blocked"
    }));
    for (let index = 0; index < 20; index += 1) {
      recordFinishLifecycleEvent(root, `TASK-TREND-${index}`, event({
        endedAt: `2026-07-22T${String(index).padStart(2, "0")}:00:00.000Z`
      }));
    }
    writeText(root, path.relative(root, path.join(finishLifecycleDirectory(root), "corrupt.json")), "{not-json\n");

    const summary = buildLocalLifecycleSummary(root);
    if (summary.status !== "available") throw new Error(summary.reason);
    expect(summary).toMatchObject({ receiptCount: 22, invalidReceiptCount: 1, eventCount: 24 });
    expect(summary.taskTrend).toMatchObject({ limit: 20, totalCount: 22, truncated: true });
    expect(summary.taskTrend.items).toHaveLength(20);
    expect(summary.taskTrend.items[0]).toMatchObject({
      taskId: "TASK-BLOCKED",
      finishAttemptCount: 1,
      successfulCount: 0,
      blockedCount: 1,
      failedCount: 0,
      convergenceMilliseconds: null
    });
    expect(summary.taskTrend.items[1]).toMatchObject({
      taskId: "TASK-CONVERGED",
      finishAttemptCount: 3,
      preflightAttemptCount: 1,
      fullAttemptCount: 2,
      successfulCount: 2,
      blockedCount: 0,
      failedCount: 1,
      convergenceMilliseconds: 5000,
      verifiedMetadataAncestryCount: 2
    });
  });

  test("verifies metadata-only ancestry and returns null for source changes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const subject = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeText(root, "contracts/evidence/WBS-001-004.yaml", "id: EVD-WBS-001-004\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "metadata"], { cwd: root, stdio: "ignore" });
    const metadataHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(verifiedMetadataAncestryCount(root, "WBS-001-004", subject, metadataHead)).toBe(1);

    writeText(root, "src/change.ts", "export const changed = true;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "source"], { cwd: root, stdio: "ignore" });
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(verifiedMetadataAncestryCount(root, "WBS-001-004", subject, sourceHead)).toBeNull();
    expect(verifiedMetadataAncestryCount(root, "WBS-001-004", null, sourceHead)).toBeNull();
  });

  test("reports the source as unavailable outside a git repository", () => {
    const root = path.join("/tmp", `scwbs-no-git-${process.pid}-${Date.now()}`);
    expect(buildLocalLifecycleSummary(root)).toMatchObject({
      status: "unavailable",
      source: "git-common-dir-finish-lifecycle"
    });
  });
});
