import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectCheckIssues } from "../../src/commands/check.js";
import { listSpecChanges, listSpecs, readApproval, readEvidence, readRegistry, readReview, readSpec, readSpecChange, readTask } from "../../src/core/contracts.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleSpec, sampleSpecChange, sampleEvidence, sampleApproval, writeScwbsProject, writeJson, writeYaml } from "../helpers.js";
import type { WbsDocument } from "../../src/core/types.js";

describe("contracts / schema", () => {
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
});
