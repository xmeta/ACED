import { describe, expect, test } from "vitest";
import { runCheck } from "../../src/commands/check.js";
import { makeTempRepo, sampleApproval, sampleEvidence, writeScwbsProject, writeYaml } from "../helpers.js";
import { readTask } from "../../src/core/contracts.js";

describe("check", () => {
  test("check --json outputs pass status with empty issues for a healthy repo", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({ status: "approved", approvedBy: "Lead", approvedAt: "2026-06-27T10:00:00+09:00" }) as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runCheck(root, { json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "pass", issues: [] });
  });

  test("check --json outputs fail status with issues for an unhealthy repo", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      runCheck(root, { json: true });
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(output.join("\n"));
    expect(parsed).toMatchObject({ status: expect.stringMatching(/fail|warn/), issues: expect.any(Array) });
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  test("check rejects malformed repository check coverage policy", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", { rules: "invalid" } as unknown as Record<string, unknown>);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheck(root, { json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n")).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkCoverage.rules" })
    ]));
  });

  test("check coverage policy rejects blank path and check entries", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", { rules: [{ id: "blank", paths: ["   "], requires: [""] }] });
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheck(root, { json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n")).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkCoverage.rule.paths" }),
      expect.objectContaining({ code: "checkCoverage.rule.requires" })
    ]));
  });

  test("Task Contract rejects blank check coverage waiver reason", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const { task } = readTask(root, "WBS-001-004");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...task,
      checkCoverageWaivers: [{ check: "test:integration", reason: "   " }]
    } as unknown as Record<string, unknown>);
    const result = readTask(root, "WBS-001-004");
    expect(result.task).toBeUndefined();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "task.checkCoverageWaiver" })
    ]));
  });

  test("completed tasks without Human Gate file changes do not require Approval", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/feature.ts"]
    }) as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheck(root, { json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "pass", issues: [] });
  });

  test("completed tasks with Human Gate file changes reject requested Approval", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/security/key.ts"]
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({ status: "requested" }) as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheck(root, { json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n")).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "approval.status", severity: "error" })
    ]));
  });
});
