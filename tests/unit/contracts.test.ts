import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectCheckIssues } from "../../src/commands/check.js";
import { listRisks, listSpecChanges, listSpecs, readApproval, readBlock, readEvidence, readRegistry, readReview, readSpec, readSpecChange, readTask } from "../../src/core/contracts.js";
import { approvalPath, blockPath, evidencePath, reviewPath, specChangePath, specPath, taskPath } from "../../src/core/paths.js";
import { makeTempRepo, sampleTask, sampleSpec, sampleSpecChange, sampleEvidence, sampleApproval, writeScwbsProject, writeYaml } from "../helpers.js";

describe("contracts / schema", () => {
  test.each([
    "WBS-001-004",
    "SCWBS-DRAFT-ABC123",
    "task.with_dots-and-hyphens"
  ])("task lifecycle paths accept compatible task id %s", (taskId) => {
    expect(taskPath(taskId)).toBe(`contracts/tasks/${taskId}.yaml`);
    expect(evidencePath(taskId)).toBe(`contracts/evidence/${taskId}.yaml`);
    expect(approvalPath(taskId)).toBe(`contracts/approvals/${taskId}.yaml`);
    expect(reviewPath(taskId)).toBe(`contracts/reviews/${taskId}.yaml`);
    expect(blockPath(taskId)).toBe(`contracts/blocks/${taskId}.yaml`);
  });

  test.each([
    "",
    ".",
    "..",
    "../../outside",
    "/tmp/outside",
    String.raw`..\..\outside`,
    "nested/task",
    "nested\\task",
    "%2e%2e%2foutside",
    "task id",
    "タスク"
  ])("task lifecycle paths reject unsafe task id without exposing it: %s", (taskId) => {
    for (const buildPath of [taskPath, evidencePath, approvalPath, reviewPath, blockPath]) {
      expect(() => buildPath(taskId)).toThrow("Invalid task id");
    }
  });

  test.each([
    "SPEC-F001-API",
    "SCP-F001-API-001",
    "spec.with_dots-and-hyphens"
  ])("spec paths accept compatible identifiers %s", (id) => {
    expect(specPath(id)).toBe(`contracts/specs/${id}.yaml`);
    expect(specChangePath(id)).toBe(`contracts/spec-changes/${id}.yaml`);
  });

  test.each([
    "",
    ".",
    "..",
    "../../outside",
    "/tmp/outside",
    String.raw`..\..\outside`,
    "nested/spec",
    "nested\\spec",
    "spec id",
    "仕様"
  ])("spec paths reject unsafe identifiers without exposing them: %s", (id) => {
    for (const buildPath of [specPath, specChangePath]) {
      expect(() => buildPath(id)).toThrow("Invalid task id");
    }
  });

  test("invalid task reads fail before inspecting an outside fixture", () => {
    const root = makeTempRepo();
    const outsideId = `outside-${path.basename(root)}`;
    const outside = path.resolve(root, `../${outsideId}.yaml`);
    writeYaml(root, `../${outsideId}.yaml`, { secret: "must-not-appear" });

    const result = readTask(root, `../${outsideId}`);

    expect(existsSync(outside)).toBe(true);
    expect(result.task).toBeUndefined();
    expect(result.issues).toEqual([{
      severity: "error",
      code: "task.id.invalid",
      message: "Invalid task id"
    }]);
    expect(JSON.stringify(result.issues)).not.toContain("must-not-appear");
  });

  test("Task Contract schema rejects an unsafe id", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ id: "../outside" }) as unknown as Record<string, unknown>);

    const result = readTask(root, "WBS-001-004");

    expect(result.task).toBeUndefined();
    expect(result.issues.some((issue) => issue.code === "task.schema")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "task.id.invalid")).toBe(true);
  });

  test("spec contracts are first-class files with required metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const { spec, issues } = readSpec(root, "contracts/specs/SPEC-F001-API.yaml");
    expect(issues).toEqual([]);
    expect(spec?.type).toBe("spec-contract");
    expect(spec?.status).toBe("approved");
    expect(spec?.approvedBy).toBe("Product Owner");
    expect(listSpecs(root).some((entry) => entry.path === "contracts/specs/SPEC-F001-API.yaml" && entry.issues.length === 0)).toBe(true);
  });

  test("spec change proposals are first-class files with required metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/spec-changes/SCP-F001-API-001.yaml", sampleSpecChange() as unknown as Record<string, unknown>);
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
          id: "SCP-F001-API-001",
          type: "spec-change",
          path: "contracts/spec-changes/SCP-F001-API-001.yaml",
          status: "proposed",
          version: "1.1.0",
          relatedTask: "WBS-001-004"
        },
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        }
      ]
    });

    const { specChange, issues } = readSpecChange(root, "contracts/spec-changes/SCP-F001-API-001.yaml");
    expect(issues).toEqual([]);
    expect(specChange?.type).toBe("spec-change-proposal");
    expect(specChange?.status).toBe("proposed");
    expect(listSpecChanges(root).some((entry) => entry.path === "contracts/spec-changes/SCP-F001-API-001.yaml" && entry.issues.length === 0)).toBe(true);
    expect(collectCheckIssues(root).some((issue) => issue.code.startsWith("specChange."))).toBe(false);
  });

  test("every lifecycle reader rejects a mismatched file stem without exposing artifact contents", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const secret = "fixture-secret-must-not-leak";
    writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", {
      ...sampleSpec({ id: "SPEC-WRONG" }),
      secret
    } as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/spec-changes/SCP-F001-API-001.yaml", {
      ...sampleSpecChange({ id: "SCP-WRONG" }),
      secret
    } as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask({ id: "WBS-WRONG" }),
      secret
    } as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", {
      ...sampleEvidence({ taskId: "OTHER-TASK" }),
      secret
    } as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      ...sampleApproval({ taskId: "OTHER-TASK" }),
      secret
    } as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "OTHER-TASK",
      status: "requested",
      reviewProfile: "self-review",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml"],
      secret
    });
    writeYaml(root, "contracts/blocks/WBS-001-004.yaml", {
      id: "BLK-WBS-001-004",
      type: "block",
      taskId: "OTHER-TASK",
      status: "blocked",
      level: 1,
      category: "human-gate",
      reason: "Fixture block",
      requiredHumanDecision: "Decide",
      createdAt: "2026-08-20T00:00:00.000Z",
      secret
    });
    writeYaml(root, "contracts/risks/RISK-F001.yaml", {
      schemaVersion: "scwbs.risk.v1",
      id: "RISK-WRONG",
      type: "risk",
      title: "Fixture risk",
      status: "open",
      scope: { tasks: [], specs: [], requirements: [] },
      assessment: { likelihood: 1, impact: 1, score: 1, level: "low" },
      treatment: { strategy: "mitigate", owner: "team", actions: ["Act"], verification: ["Verify"] },
      residualRisk: { likelihood: 1, impact: 1, score: 1, level: "low" },
      createdAt: "2026-08-20T00:00:00.000Z",
      secret
    });

    const results = [
      readSpec(root, "contracts/specs/SPEC-F001-API.yaml"),
      readSpecChange(root, "contracts/spec-changes/SCP-F001-API-001.yaml"),
      readTask(root, "WBS-001-004"),
      readEvidence(root, "WBS-001-004"),
      readApproval(root, "WBS-001-004"),
      readReview(root, "WBS-001-004"),
      readBlock(root, "WBS-001-004"),
      listRisks(root)[0]
    ];
    const codes = results.map((result) => result.issues.find((issue) => issue.code.endsWith(".identity.path-mismatch"))?.code);
    expect(codes).toEqual([
      "spec.identity.path-mismatch",
      "spec-change.identity.path-mismatch",
      "task.identity.path-mismatch",
      "evidence.identity.path-mismatch",
      "approval.identity.path-mismatch",
      "review.identity.path-mismatch",
      "block.identity.path-mismatch",
      "risk.identity.path-mismatch"
    ]);
    expect(JSON.stringify(results)).not.toContain(secret);
  });

  test("Registry rejects duplicate type-id and path entries", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        { id: "EVD-001", type: "evidence", path: "contracts/evidence/one.yaml" },
        { id: "EVD-001", type: "evidence", path: "contracts/evidence/two.yaml" },
        { id: "APR-001", type: "approval", path: "contracts/evidence/two.yaml" }
      ]
    });

    expect(readRegistry(root).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "registry.identity.duplicate" }),
      expect.objectContaining({ code: "registry.path.duplicate" })
    ]));
  });

  test("YAML contract reads run JSON Schema validation after parsing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      mode: "full"
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
  });

  test("JSON Schema validation applies to every YAML contract kind", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/registry.yaml", { projectId: "test-wbs", contracts: [{ id: "TASK-WBS-001-004", type: "bad", path: "contracts/tasks/WBS-001-004.yaml" }] });
    writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", { ...sampleSpec(), status: "archived" });
    writeYaml(root, "contracts/spec-changes/SCP-F001-API-001.yaml", { ...sampleSpecChange(), status: "waiting" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", { ...sampleEvidence(), checks: [{ name: "test", status: "unknown" }] });
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", { ...sampleApproval(), status: "waiting" });
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "pending",
      reviewProfile: "self-review",
      groundTruth: ["contracts/evidence/WBS-001-004.yaml"]
    });

    expect(readRegistry(root).issues.some((issue) => issue.code === "registry.schema")).toBe(true);
    expect(readSpec(root, "contracts/specs/SPEC-F001-API.yaml").issues.some((issue) => issue.code === "spec.schema")).toBe(true);
    expect(readSpecChange(root, "contracts/spec-changes/SCP-F001-API-001.yaml").issues.some((issue) => issue.code === "specChange.schema")).toBe(true);
    expect(readEvidence(root, "WBS-001-004").issues.some((issue) => issue.code === "evidence.schema")).toBe(true);
    expect(readApproval(root, "WBS-001-004").issues.some((issue) => issue.code === "approval.schema")).toBe(true);
    expect(readReview(root, "WBS-001-004").issues.some((issue) => issue.code === "review.schema")).toBe(true);
  });

  test("semantic validation still owns repository consistency after schema validation", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "missing-node" }) as unknown as Record<string, unknown>);

    const directRead = readTask(root, "WBS-001-004");
    expect(directRead.issues).toEqual([]);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.wbsNodeId")).toBe(true);
  });

  test.each([
    {
      name: "missing token hash",
      approvalPolicy: {
        mode: "delegated",
        delegatedBy: "owner",
        delegatedTo: "ai-agent",
        scopes: ["human-gate"],
        source: "issue-222",
        reason: "automation",
        expiresAt: "2099-01-01T00:00:00.000Z"
      },
      semanticCode: undefined
    },
    {
      name: "malformed expiry and plaintext token",
      approvalPolicy: {
        mode: "delegated",
        delegatedBy: "owner",
        delegatedTo: "ai-agent",
        scopes: ["human-gate"],
        source: "issue-222",
        reason: "automation",
        expiresAt: "not-a-date",
        tokenSha256: "plaintext-secret"
      },
      semanticCode: "task.approvalPolicy.expiresAt"
    }
  ])("task approvalPolicy rejects $name", ({ approvalPolicy, semanticCode }) => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      approvalPolicy
    });
    const result = readTask(root, "WBS-001-004");
    expect(result.task).toBeUndefined();
    expect(result.issues.some((issue) => issue.code === "task.schema")).toBe(true);
    if (semanticCode) {
      expect(result.issues.some((issue) => issue.code === semanticCode)).toBe(true);
    }
  });

  test("delegated approval records require complete provenance", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvalMode: "delegated"
    }) as unknown as Record<string, unknown>);

    const result = readApproval(root, "WBS-001-004");
    expect(result.approval).toBeUndefined();
    expect(result.issues.some((issue) => issue.code === "approval.delegation")).toBe(true);
  });

  test("missing wbsNodeId is an error", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "missing-node" }) as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "task.wbsNodeId")).toBe(true);
  });

  test("done node requires evidence", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "evidence.missing")).toBe(true);
  });

  test("evidence must include required checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ checks: [{ name: "test", status: "passed" }] }) as unknown as Record<string, unknown>);
    const issues = collectCheckIssues(root);
    expect(issues.some((issue) => issue.code === "evidence.check.missing")).toBe(true);
  });

  test("completionScope must be 'node' when present", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionScope: "full"
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
  });

  test("completionTaskIds must be a string array when present", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionTaskIds: "not-an-array"
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
  });

  test("managedContractPaths must be a string array when present", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      managedContractPaths: 123
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
  });

  test.each(["package.json", "package-lock.json", "tsconfig.json", ".github/**", "contracts/**"])(
    "managedContractPaths rejects unsafe path %s in JSON Schema",
    (managedPath) => {
      const root = makeTempRepo();
      writeScwbsProject(root);
      writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
        ...sampleTask(),
        managedContractPaths: [managedPath]
      });

      const { task, issues } = readTask(root, "WBS-001-004");
      expect(task).toBeUndefined();
      expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
    }
  );

  test("managedContractPaths semantic validation rejects another task's contract file", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      managedContractPaths: ["contracts/evidence/OTHER-TASK.yaml"]
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.managedContractPaths.scope")).toBe(true);
  });

  test("managedContractPaths semantic validation rejects another task's Evidence payload", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      managedContractPaths: ["contracts/evidence-payloads/OTHER-TASK.patch"]
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.managedContractPaths.scope")).toBe(true);
  });

  test("managedContractPaths accepts concrete known files for the same task", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      managedContractPaths: [
        "contracts/tasks/WBS-001-004.yaml",
        "contracts/evidence/WBS-001-004.yaml",
        "contracts/approvals/WBS-001-004.yaml",
        "contracts/reviews/WBS-001-004.yaml",
        "contracts/evidence-payloads/WBS-001-004.patch",
        "contracts/registry.yaml",
        "contracts/changesets/change-WBS-001-004.json"
      ]
    });

    expect(readTask(root, "WBS-001-004").issues).toEqual([]);
  });

  test("valid completionScope 'node' with completionTaskIds passes schema validation", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionScope: "node",
      completionTaskIds: ["WBS-001-005"]
    });

    const { issues } = readTask(root, "WBS-001-004");
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(false);
  });

  test("completionScope 'node' without completionTaskIds fails", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionScope: "node"
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.completionTaskIds.required")).toBe(true);
    expect(issues.some((issue) => issue.code === "task.schema")).toBe(true);
  });

  test("completionTaskIds with duplicates fails semantic validation", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionTaskIds: ["WBS-001-005", "WBS-001-005"]
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.completionTaskIds.duplicate")).toBe(true);
  });

  test("completionTaskIds with self-reference fails", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...sampleTask(),
      completionTaskIds: ["WBS-001-004"]
    });

    const { task, issues } = readTask(root, "WBS-001-004");
    expect(task).toBeUndefined();
    expect(issues.some((issue) => issue.code === "task.completionTaskIds.selfReference")).toBe(true);
  });
});
