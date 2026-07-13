import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { buildHumanApprovalCommand, runFinish } from "../../src/commands/finish.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeYaml, writeText, writeJson } from "../helpers.js";

function prepareFinishRepo(requestedApproval = false): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: "master",
    allowedPaths: ["src/**", "contracts/**"],
    humanGateRequiredPaths: [],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
  writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "base"], { cwd: root });
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
  if (requestedApproval) {
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004",
      type: "approval",
      taskId: "WBS-001-004",
      status: "requested"
    });
  }
  writeYaml(root, "contracts/registry.yaml", {
    projectId: "test-wbs",
    contracts: [
      ...(requestedApproval ? [{
        id: "APR-WBS-001-004",
        type: "approval",
        path: "contracts/approvals/WBS-001-004.yaml",
        status: "requested",
        relatedTask: "WBS-001-004"
      }] : []),
      {
        id: "EVD-WBS-001-004",
        type: "evidence",
        path: "contracts/evidence/WBS-001-004.yaml",
        relatedTask: "WBS-001-004"
      },
      {
        id: "SPEC-F001-API",
        type: "spec",
        path: "contracts/specs/SPEC-F001-API.yaml",
        status: "approved",
        version: "1.0.0",
        featureId: "F001"
      },
      {
        id: "TASK-WBS-001-004",
        type: "task",
        path: "contracts/tasks/WBS-001-004.yaml",
        featureId: "F001"
      }
    ]
  });
  writeText(root, "src/feature.ts", "export const value = 1;\n");
  return root;
}

describe("finish", () => {
  test("finish --json outputs summary JSON with all required fields", () => {
    const root = prepareFinishRepo(true);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output[output.length - 1])).toMatchObject({
      status: "pass",
      taskId: "WBS-001-004",
      requiresHumanApproval: expect.any(Boolean),
      changedFiles: expect.any(Array),
      violations: expect.any(Array),
      requiredChecks: expect.any(Array),
      evidencePath: expect.any(String),
      approvalStatus: expect.any(String),
      nextAction: buildHumanApprovalCommand("WBS-001-004")
    });
  }, 30000);

  test("finish prints an approval command accepted by the current CLI parser", () => {
    const root = prepareFinishRepo(true);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    } finally {
      console.log = originalLog;
    }

    const command = buildHumanApprovalCommand("WBS-001-004");
    expect(output).toContain(`  ${command}`);
    expect(command).not.toContain("--approved-by");
    expect(command).not.toContain("--human-confirm");

    const previousAgentMode = process.env.SCWBS_AGENT_MODE;
    process.env.SCWBS_AGENT_MODE = "ai";
    try {
      expect(main(["approval", "approve", "--task", "WBS-001-004", "--reason", "Evidence and diff reviewed"], root)).toBe(1);
    } finally {
      if (previousAgentMode === undefined) delete process.env.SCWBS_AGENT_MODE;
      else process.env.SCWBS_AGENT_MODE = previousAgentMode;
    }
  }, 30000);
});
