import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildGovernanceCostSummary, runMetricsGovernance } from "../../src/commands/metrics.js";
import { main } from "../../src/cli.js";
import { checkReceiptPath } from "../../src/core/check-receipt.js";
import { summarizeGithubActionsRuns } from "../../src/core/github-actions.js";
import { makeTempRepo, sampleWbs, writeJson, writeText, writeYaml } from "../helpers.js";

function captureStdout(action: () => number): { result: number; stdout: string } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: action(), stdout: output.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function writeReceipt(root: string, taskId: string, createdAt: string, durations: Array<number | undefined>): void {
  writeText(root, path.relative(root, checkReceiptPath(root, taskId)), JSON.stringify({
    schemaVersion: "1.0.0",
    taskId,
    createdAt,
    headCommit: `head-${taskId}`,
    subjectFingerprint: `subject-${taskId}`,
    provenance: { nodeVersion: "v22", platform: "linux-x64", lockfiles: [], submoduleStatus: [] },
    checks: durations.map((durationMilliseconds, index) => ({
      name: `check-${index}`,
      status: "passed",
      source: "local",
      command: `command-${index}`,
      cacheKey: `cache-${index}`,
      executedAt: createdAt,
      ...(durationMilliseconds === undefined ? {} : { durationMilliseconds })
    }))
  }));
}

describe("governance metrics", () => {
  test("reports profile buckets and separates archived artifacts without writing", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", {
      ...sampleWbs(),
      extensions: { scwbs: { profile: "Strict" } }
    });
    writeYaml(root, "contracts/tasks/ACTIVE.yaml", { id: "ACTIVE", status: "planned" });
    writeYaml(root, "contracts/tasks/archive/OLD.yaml", { id: "OLD", status: "archived" });
    writeText(root, "contracts/specs/STRICT-ONLY.yaml", "status: approved\n");
    writeText(root, "contracts/registry.yaml", "projectId: metrics\ncontracts: []\n");
    writeText(root, "src/example.ts", "export const example = true;\n");
    writeText(root, "tests/example.test.ts", "test('example', () => undefined);\n");
    const before = readdirSync(root, { recursive: true }).sort();

    const summary = buildGovernanceCostSummary(root, new Date("2026-07-16T00:00:00.000Z"));

    expect(summary.profile).toBe("Strict");
    expect(summary.generatedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(summary.categories["contracts/tasks"]).toMatchObject({
      files: 2,
      activeFiles: 1,
      archivedFiles: 1
    });
    expect(summary.profiles.Strict.files).toBeGreaterThan(summary.profiles.Lean.files);
    expect(summary.definitions.hardLimitEnforced).toBe(false);
    expect(summary.localRequiredChecks).toMatchObject({ status: "available", receiptCount: 0, observedCheckCount: 0 });
    if (summary.localRequiredChecks.status !== "available") throw new Error(summary.localRequiredChecks.reason);
    expect(summary.localRequiredChecks.durationMilliseconds).toEqual({ total: null, average: null, minimum: null, maximum: null });
    expect(summary.unmeasured).toEqual(["warning budgets and hard enforcement"]);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  test("summarizes only observed receipt durations and bounds the task trend", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    writeReceipt(root, "legacy", "2026-07-16T00:00:00Z", [undefined, undefined]);
    writeReceipt(root, "partial", "2026-07-16T01:00:00Z", [100, undefined]);
    writeReceipt(root, "observed", "2026-07-16T02:00:00Z", [200, 300]);
    for (let index = 0; index < 19; index += 1) {
      writeReceipt(root, `trend-${index.toString().padStart(2, "0")}`, `2026-07-15T${index.toString().padStart(2, "0")}:00:00Z`, [10]);
    }
    writeText(root, path.relative(root, checkReceiptPath(root, "malformed")), "{not-json\n");
    writeText(root, path.join(path.dirname(path.relative(root, checkReceiptPath(root, "observed"))), "copied.json"), readFileSync(checkReceiptPath(root, "observed"), "utf8"));

    const summary = buildGovernanceCostSummary(root).localRequiredChecks;
    if (summary.status !== "available") throw new Error(summary.reason);

    expect(summary).toMatchObject({
      receiptCount: 22,
      invalidReceiptCount: 2,
      checkCount: 25,
      observedReceiptCount: 20,
      partiallyObservedReceiptCount: 1,
      unobservedReceiptCount: 1,
      observedCheckCount: 22,
      unobservedCheckCount: 3
    });
    expect(summary.durationMilliseconds).toEqual({ total: 790, average: 36, minimum: 10, maximum: 300 });
    expect(summary.taskTrend).toMatchObject({ limit: 20, totalCount: 22, truncated: true });
    expect(summary.taskTrend.items).toHaveLength(20);
    expect(summary.taskTrend.items[0]).toMatchObject({ taskId: "observed", durationMilliseconds: 500 });
    expect(summary.taskTrend.items[1]).toMatchObject({ taskId: "partial", durationMilliseconds: null });
    expect(summary.taskTrend.items[2]).toMatchObject({ taskId: "legacy", durationMilliseconds: null });
  });

  test("reports local receipt metrics as unavailable outside a git repository", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scwbs-metrics-no-git-"));
    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    expect(buildGovernanceCostSummary(root).localRequiredChecks).toMatchObject({
      status: "unavailable",
      source: "git-common-dir-check-receipts"
    });
  });

  test("summarizes completed GitHub Actions durations without treating incomplete runs as zero duration", () => {
    const summary = summarizeGithubActionsRuns("xmeta/ACED", [
      { id: 1, name: "SC-WBS", event: "pull_request", headBranch: "task/SCWBS-DRAFT-ABC123-fix", status: "completed", conclusion: "success", createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:10Z" },
      { id: 2, name: "SC-WBS", event: "push", headBranch: "main", status: "completed", conclusion: "failure", createdAt: "2026-07-16T01:00:00Z", updatedAt: "2026-07-16T01:00:30Z" },
      { id: 3, name: "Other", event: "push", headBranch: "main", status: "in_progress", conclusion: null, createdAt: "2026-07-16T02:00:00Z", updatedAt: "2026-07-16T02:00:05Z" },
      { id: 4, name: "SC-WBS", event: "pull_request", headBranch: "task/SCWBS-DRAFT-ABC123-fix", status: "completed", conclusion: "failure", createdAt: "2026-07-16T03:00:00Z", updatedAt: "2026-07-16T03:00:20Z" },
      { id: 5, name: "SC-WBS", event: "pull_request", headBranch: "task/SCWBS-DRAFT-ABC123-retry", status: "completed", conclusion: "cancelled", createdAt: "2026-07-16T04:00:00Z", updatedAt: "2026-07-16T04:00:30Z" },
      { id: 6, name: "SC-WBS", event: "pull_request", headBranch: "task/SCWBS-DRAFT-ABC123-retry", status: "in_progress", conclusion: null, createdAt: "2026-07-16T05:00:00Z", updatedAt: "2026-07-16T05:00:05Z" },
      { id: 7, name: "SC-WBS", event: "pull_request", headBranch: "feature/not-a-task", status: "completed", conclusion: "failure", createdAt: "2026-07-16T06:00:00Z", updatedAt: "2026-07-16T06:00:40Z" }
    ], 100);
    expect(summary).toMatchObject({ matchingRunCount: 7, completedRunCount: 5, incompleteRunCount: 2 });
    expect(summary.durationMilliseconds).toMatchObject({ total: 130000, average: 26000, minimum: 10000, maximum: 40000 });
    expect(summary.workflows["SC-WBS"]).toEqual({ runCount: 6, completedRunCount: 5, durationMilliseconds: 130000 });
    expect(summary.workflows.Other).toEqual({ runCount: 1, completedRunCount: 0, durationMilliseconds: 0 });
    expect(summary.events).toEqual({ pull_request: { runCount: 5, completedRunCount: 4 }, push: { runCount: 2, completedRunCount: 1 } });
    expect(summary.branches.main).toEqual({ runCount: 2, completedRunCount: 1 });
    expect(summary.taskPullRequests).toEqual({
      limit: 20,
      totalCount: 1,
      truncated: false,
      items: [{
        taskId: "SCWBS-DRAFT-ABC123",
        headBranches: ["task/SCWBS-DRAFT-ABC123-fix", "task/SCWBS-DRAFT-ABC123-retry"],
        runCount: 4,
        completedRunCount: 3,
        successfulRunCount: 1,
        failedRunCount: 1,
        otherCompletedRunCount: 1,
        incompleteRunCount: 1,
        durationMilliseconds: 60000,
        latestUpdatedAt: "2026-07-16T05:00:05Z"
      }]
    });
  });

  test("bounds Task pull request CI trends in latest-update order", () => {
    const runs = Array.from({ length: 22 }, (_, index) => ({
      id: index,
      name: "SC-WBS",
      event: "pull_request",
      headBranch: `task/SCWBS-${index.toString().padStart(3, "0")}-change`,
      status: "completed",
      conclusion: "success",
      createdAt: `2026-07-${(index + 1).toString().padStart(2, "0")}T00:00:00Z`,
      updatedAt: `2026-07-${(index + 1).toString().padStart(2, "0")}T00:00:01Z`
    }));

    const tasks = summarizeGithubActionsRuns("xmeta/ACED", runs, 100).taskPullRequests;

    expect(tasks).toMatchObject({ limit: 20, totalCount: 22, truncated: true });
    expect(tasks.items).toHaveLength(20);
    expect(tasks.items[0].taskId).toBe("SCWBS-021");
    expect(tasks.items.at(-1)?.taskId).toBe("SCWBS-002");
  });

  test("wires the bounded JSON summary through the CLI", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    const output = captureStdout(() => main(["metrics", "governance", "--json"], root));
    expect(output.result).toBe(0);
    const summary = JSON.parse(output.stdout);
    expect(summary).toMatchObject({
      schemaVersion: "1.1.0",
      metric: "governance-cost",
      definitions: { hardLimitEnforced: false }
    });
  });

  test("plain output stays bounded and does not claim unmeasured timing", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      expect(runMetricsGovernance(root)).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("hard limit: not enforced");
  });
});
