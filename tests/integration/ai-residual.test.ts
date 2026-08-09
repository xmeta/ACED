import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { buildAiExecution } from "../../src/commands/ai-run.js";
import type { ChecksRunSummary } from "../../src/commands/checks-run.js";
import { buildLocalAiExecutionSummary } from "../../src/commands/metrics.js";
import { makeTempRepo, sampleTask, writeJson, writeScwbsProject, writeYaml } from "../helpers.js";

const TASK_ID = "WBS-001-004";
const BRANCH = "task/WBS-001-004-ai-residual";

function prepareRepo(): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: BRANCH,
    allowedPaths: ["src/features/api/**"],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", BRANCH], { cwd: root });
  return root;
}

function adapter(role: "implementer" | "reviewer", body: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "scwbs-ai-residual-adapter-"));
  const file = path.join(directory, `${role}.mjs`);
  writeFileSync(file, `import { readFileSync, writeFileSync } from "node:fs";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
${body}
writeFileSync(process.argv[3], JSON.stringify({ schemaVersion: "scwbs.ai-execution-result.v1", role: input.role, contextId: input.contextId, status: ${JSON.stringify(role === "implementer" ? "completed" : "approved")}, summary: "accepted", findings: [], changedFiles: [] }));
`);
  return file;
}

function passingChecks(root: string): ChecksRunSummary {
  return {
    schemaVersion: "1.0.0",
    status: "pass",
    taskId: TASK_ID,
    headCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    subjectFingerprint: "residual-test",
    receiptPath: null,
    receiptReason: "test-injected",
    checks: [{ name: "test", status: "passed", disposition: "reused", reason: "test-injected", command: "npm test", cacheKey: "test" }]
  };
}

describe("AI residual contracts", () => {
  test("fails closed before spawning an adapter when provider capabilities are unsupported", () => {
    const root = prepareRepo();
    const receipt = buildAiExecution(root, {
      taskId: TASK_ID,
      implementerCommand: JSON.stringify([process.execPath, "missing-adapter.mjs"]),
      reviewerCommand: JSON.stringify([process.execPath, "missing-reviewer.mjs"]),
      implementerProvider: JSON.stringify({ id: "review-only", capabilities: ["review", "fresh-context", "json-io"] })
    }, { now: () => "2026-08-10T01:00:00.000Z" });

    expect(receipt.status).toBe("blocked");
    expect(receipt.failure?.code).toBe("adapter.provider.unsupported");
    expect(receipt.cost?.agentTurns).toBe(0);
  });

  test("passes bounded learned note and records execution cost for governance metrics", () => {
    const root = prepareRepo();
    const implementer = adapter("implementer", `
if (input.provider.id !== "bounded-local" || !input.provider.capabilities.includes("implement")) process.exit(2);
if (input.learnedNotes.length !== 1 || input.learnedNotes[0].sourceTaskId !== "SCWBS-SOURCE-001" || input.learnedNotes[0].scope.length !== 1) process.exit(3);
`);
    const reviewer = adapter("reviewer", `
if (input.provider.id !== "bounded-review" || input.learnedNotes[0].note !== "reuse only test naming guidance") process.exit(4);
`);
    const receipt = buildAiExecution(root, {
      taskId: TASK_ID,
      implementerCommand: JSON.stringify([process.execPath, implementer]),
      reviewerCommand: JSON.stringify([process.execPath, reviewer]),
      implementerProvider: JSON.stringify({ id: "bounded-local", capabilities: ["implement", "fresh-context", "json-io"] }),
      reviewerProvider: JSON.stringify({ id: "bounded-review", capabilities: ["review", "fresh-context", "json-io"] }),
      learnedNote: JSON.stringify({ sourceTaskId: "SCWBS-SOURCE-001", sourceHeadCommit: "a".repeat(40), scope: ["tests/integration/**"], note: "reuse only test naming guidance" })
    }, { now: () => "2026-08-10T01:01:00.000Z", runChecks: passingChecks });

    expect(receipt.status).toBe("completed");
    expect(receipt.plan.learnedNotes?.[0]).toMatchObject({ sourceTaskId: "SCWBS-SOURCE-001", sourceHeadCommit: "a".repeat(40) });
    expect(receipt.startedAt).toBe("2026-08-10T01:01:00.000Z");
    expect(receipt.cost).toMatchObject({ agentTurns: 2, remediationRounds: 0, requiredChecksObserved: 1, requiredChecksReused: 1, requiredCheckReuseRate: 1 });
    expect(existsSync(receipt.receiptPath ?? "")).toBe(true);

    const summary = buildLocalAiExecutionSummary(root);
    expect(summary.status).toBe("available");
    if (summary.status !== "available") throw new Error(summary.reason);
    expect(summary).toMatchObject({ receiptCount: 1, observedReceiptCount: 1, unobservedReceiptCount: 0 });
    expect(summary.totals.requiredCheckReuseRate).toEqual({ observedCheckCount: 1, reusedCheckCount: 1, rate: 1 });
    expect(summary.taskTrend.items[0]).toMatchObject({ taskId: TASK_ID, agentTurns: 2, requiredCheckReuseRate: 1 });
    expect(JSON.parse(readFileSync(receipt.receiptPath!, "utf8")).cost.requiredChecksReused).toBe(1);
  });

  test("reports legacy AI receipt cost as unobserved instead of zero", () => {
    const root = prepareRepo();
    const receiptPath = path.join(root, ".git", "scwbs-ai-execution", `${encodeURIComponent(TASK_ID)}.json`);
    writeJson(root, path.relative(root, receiptPath), {
      schemaVersion: "scwbs.ai-run-receipt.v1",
      executionId: "AIR-LEGACY",
      taskId: TASK_ID,
      status: "blocked"
    });
    const summary = buildLocalAiExecutionSummary(root);
    expect(summary.status).toBe("available");
    if (summary.status !== "available") throw new Error(summary.reason);
    expect(summary).toMatchObject({ receiptCount: 1, observedReceiptCount: 0, unobservedReceiptCount: 1 });
    expect(summary.totals.wallTimeMilliseconds).toEqual({ total: null, average: null, minimum: null, maximum: null });
  });
});
