import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { summarizeGithubPullRequests } from "../../src/core/github-pull-requests.js";
import { buildHealthLifecycleEvent, healthLifecycleDirectory, recordHealthLifecycleEvent } from "../../src/core/health-lifecycle.js";
import { buildHealthLifecycleSummary, buildHumanGateSummary } from "../../src/commands/metrics.js";
import { makeTempRepo, sampleApproval, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

describe("issue 179 gate, publish, and health observability", () => {
  test("summarizes bounded Task pull request publish loops and leaves unmerged duration null", () => {
    const pullRequests = Array.from({ length: 22 }, (_, index) => ({
      number: index + 1,
      headBranch: `codex/SCWBS-DRAFT-${index.toString().padStart(3, "0")}-change`,
      createdAt: `2026-07-${(index + 1).toString().padStart(2, "0")}T00:00:00Z`,
      updatedAt: `2026-07-${(index + 1).toString().padStart(2, "0")}T00:00:20Z`,
      mergedAt: index === 0 ? null : `2026-07-${(index + 1).toString().padStart(2, "0")}T00:00:10Z`
    }));
    const summary = summarizeGithubPullRequests("xmeta/ACED", pullRequests);
    if (summary.status !== "available") throw new Error(summary.reason);
    expect(summary.taskTrend).toMatchObject({ limit: 20, totalCount: 22, truncated: true });
    expect(summary.taskTrend.items).toHaveLength(20);
    expect(summary.taskTrend.items[0]).toMatchObject({ taskId: "SCWBS-DRAFT-021", publishLoopMilliseconds: 10_000 });
    expect(summary.unmergedPullRequestCount).toBe(1);
  });

  test("reports Approval wait only when requestedAt and approvedAt are both observed", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/OBSERVED.yaml", sampleApproval({
      taskId: "OBSERVED",
      requestedAt: "2026-07-23T00:00:00Z",
      approvedAt: "2026-07-23T00:01:00Z"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/LEGACY.yaml", sampleApproval({
      taskId: "LEGACY",
      approvedAt: "2026-07-23T00:01:00Z"
    }) as unknown as Record<string, unknown>);
    const summary = buildHumanGateSummary(root);
    expect(summary).toMatchObject({ observedCompletedCount: 1, legacyUnobservedCount: 1 });
    expect(summary.taskTrend.items.find((item) => item.taskId === "OBSERVED")?.waitingMilliseconds).toBe(60_000);
    expect(summary.taskTrend.items.find((item) => item.taskId === "LEGACY")?.waitingMilliseconds).toBeNull();
  });

  test("health receipt is local, bounded, corrupt-aware, and only returns comparable delta", () => {
    const root = makeTempRepo();
    recordHealthLifecycleEvent(root, "TASK-A", buildHealthLifecycleEvent([
      { severity: "warn", code: "health.a", message: "a" },
      { severity: "warn", code: "health.b", message: "b" }
    ], new Date("2026-07-23T00:00:00Z")));
    recordHealthLifecycleEvent(root, "TASK-A", buildHealthLifecycleEvent([
      { severity: "warn", code: "health.a", message: "a" }
    ], new Date("2026-07-23T00:01:00Z")));
    recordHealthLifecycleEvent(root, "TASK-B", buildHealthLifecycleEvent([], new Date("2026-07-23T00:02:00Z")));
    mkdirSync(healthLifecycleDirectory(root), { recursive: true });
    writeText(root, path.relative(root, path.join(healthLifecycleDirectory(root), "corrupt.json")), "{broken\n");
    const summary = buildHealthLifecycleSummary(root);
    if (summary.status !== "available") throw new Error(summary.reason);
    expect(summary).toMatchObject({ receiptCount: 2, invalidReceiptCount: 1, eventCount: 3 });
    expect(summary.taskTrend.items.find((item) => item.taskId === "TASK-A")?.warningDelta).toBe(-1);
    expect(summary.taskTrend.items.find((item) => item.taskId === "TASK-B")?.warningDelta).toBeNull();
    expect(readFileSync(path.join(healthLifecycleDirectory(root), "TASK-A.json"), "utf8")).toContain("\"events\"");
  });

  test("health receipts retain at most 50 events for at most 100 Tasks", () => {
    const root = makeTempRepo();
    for (let index = 0; index < 51; index += 1) {
      recordHealthLifecycleEvent(root, "EVENTS", buildHealthLifecycleEvent([], new Date(1_000 + index)));
    }
    for (let index = 0; index < 100; index += 1) {
      recordHealthLifecycleEvent(root, `TASK-${index.toString().padStart(3, "0")}`, buildHealthLifecycleEvent([], new Date(10_000 + index)));
    }
    const summary = buildHealthLifecycleSummary(root);
    if (summary.status !== "available") throw new Error(summary.reason);
    expect(summary.receiptCount).toBe(100);
    expect(summary.eventCount).toBe(100);
    expect(summary.taskTrend).toMatchObject({ limit: 20, totalCount: 100, truncated: true });
    expect(summary.taskTrend.items).toHaveLength(20);
  });
});
