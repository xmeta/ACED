import { describe, expect, test } from "vitest";
import { runCheck } from "../../src/commands/check.js";
import { makeTempRepo, sampleApproval, sampleEvidence, writeScwbsProject, writeYaml } from "../helpers.js";

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
});
