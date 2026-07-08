import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { runFinish } from "../../src/commands/finish.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeYaml, writeText, writeJson } from "../helpers.js";

describe("finish", () => {
  test("finish --json outputs summary JSON with all required fields", () => {
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
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
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
      nextAction: expect.any(String)
    });
  }, 30000);
});
