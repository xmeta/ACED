import { describe, expect, test } from "vitest";
import { runCheck, collectCheckIssues } from "../../src/commands/check.js";
import { makeTempRepo, sampleApproval, sampleEvidence, sampleTask, writeScwbsProject, writeText, writeYaml } from "../helpers.js";
import { readTask } from "../../src/core/contracts.js";
import { runApprovalApprove } from "../../src/commands/approval-request.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, approvalDelegationTokenSha256 } from "../../src/core/human-gate.js";

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
    const issues = JSON.parse(output.join("\n")).issues;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkCoverage.rules" })
    ]));
    expect(issues.filter((issue: { code: string }) => issue.code === "checkCoverage.rules")).toHaveLength(1);
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

  test("check --json enumerates unclassified implementation paths", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/core/classified.ts", "export const classified = true;\n");
    writeText(root, "src/core/new-module.ts", "export const unclassified = true;\n");
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core"],
      rules: [{
        id: "classified-core",
        classification: "behavior-critical",
        rationale: "The existing module affects the workflow.",
        paths: ["src/core/classified.ts"],
        requires: ["test:integration"]
      }]
    });

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheck(root, { json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n")).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkCoverage.unclassified", message: expect.stringContaining("src/core/new-module.ts") })
    ]));
  });

  test("implementation inventory policies require classifications and rationales", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core"],
      rules: [{ id: "missing-metadata", paths: ["src/core/types.ts"], requires: ["test"] }]
    });
    expect(collectCheckIssues(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkCoverage.rule.classification" })
    ]));
  });

  test("implementation inventory roots must be repository-relative directories", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core/git.ts"],
      rules: [{
        id: "core-git",
        classification: "behavior-critical",
        rationale: "Git behavior requires integration coverage.",
        paths: ["src/core/git.ts"],
        requires: ["test:integration"]
      }]
    });
    expect(collectCheckIssues(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "checkCoverage.implementationRoot" })
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

  test("Human Gate rejects a post-finish delegated approval", () => {
    const root = makeTempRepo();
    const token = "0123456789abcdef0123456789abcdef";
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ approvalPolicy: {
      mode: "delegated",
      delegatedBy: "xmeta",
      delegatedTo: "ai-agent",
      scopes: ["human-gate", "post-finish"],
      source: "https://github.com/xmeta/ACED/issues/222",
      reason: "Authorized unattended execution",
      expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(token)
    } }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/security/key.ts"],
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    process.env[APPROVAL_DELEGATION_TOKEN_ENV] = token;
    try {
      expect(runApprovalApprove(root, "WBS-001-004", { actor: "delegated-ai", scope: "post-finish", force: false })).toBe(0);
      expect(collectCheckIssues(root)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "approval.delegation.scope", severity: "error" })
      ]));
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
  });

  test("non-existent task ID in completionTaskIds is detected", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionTaskIds: ["NONEXISTENT-TASK"]
    });

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.completionTaskIds.missing")).toBe(true);
  });

  test("check rejects managedContractPaths outside known contract paths", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      managedContractPaths: ["package.json"]
    });

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.schema" && issue.severity === "error")).toBe(true);
  });

  test("check rejects broad managedContractPaths globs", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      managedContractPaths: ["contracts/**"]
    });

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.schema" && issue.severity === "error")).toBe(true);
  });

  test("valid completion task with real second task produces no completion-related errors", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", {
      ...sampleTask(),
      id: "WBS-001-005",
      branchName: "task/WBS-001-005-second-task"
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionScope: "node",
      completionTaskIds: ["WBS-001-005"]
    });
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "SPEC-F001-API",
          type: "spec",
          path: "contracts/specs/SPEC-F001-API.yaml",
          status: "approved",
          version: "1.0.0",
          featureId: "F001",
          relatedTask: "WBS-001-004"
        },
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        },
        {
          id: "TASK-WBS-001-005",
          type: "task",
          path: "contracts/tasks/WBS-001-005.yaml",
          featureId: "F001"
        }
      ]
    });

    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code.startsWith("task.completionTaskIds") || issue.code === "task.managedContractPaths.forbiddenConflict")).toBe(false);
  });
});
