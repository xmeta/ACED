import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  buildArtifactWorkflowStatus,
  readArtifactWorkflow,
  runArtifactWorkflowInstructions,
  runArtifactWorkflowStatus,
  runValidateFeature
} from "../../src/core/contracts.js";
import { makeTempRepo, sampleEvidence, sampleSpec, sampleTask, writeJson, writeText, writeYaml } from "../helpers.js";

function capture(
  root: string,
  specId: string,
  baseRef = "HEAD"
): { exitCode: number; report: Record<string, unknown> } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const exitCode = runValidateFeature(root, specId, { baseRef, json: true });
    return { exitCode, report: JSON.parse(output.join("")) as Record<string, unknown> };
  } finally {
    process.stdout.write = originalWrite;
  }
}

function commitRepo(root: string): string {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "test fixture"], { cwd: root, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function writeStructuredFixture(
  root: string,
  options: { mode?: "automated" | "manual" | "hybrid"; coverage?: Record<string, unknown> } = {}
): string {
  const spec = sampleSpec({
    requirementsVersion: "1.0.0",
    requirements: [
      {
        id: "REQ-API-001",
        statement: "The API is traceable.",
        acceptanceScenarios: ["A passing feature check covers the requirement."],
        verificationMode: options.mode ?? "automated",
        source: "issue:457"
      }
    ]
  });
  const task = sampleTask({ requirementIds: ["REQ-API-001"] });
  writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", spec as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", task as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/tasks/index.yaml", {
    tasks: [
      {
        id: task.id,
        path: "contracts/tasks/WBS-001-004.yaml",
        branchName: task.branchName,
        wbsNodeId: task.wbsNodeId,
        status: "completed",
        dependsOn: []
      }
    ]
  });
  if (options.coverage) {
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", {
      ...sampleEvidence({ taskId: task.id }),
      subjectHeadCommit: "pending",
      diffHash: "sha256:fixture",
      requirementEvidence: [options.coverage]
    } as unknown as Record<string, unknown>);
  }
  return commitRepo(root);
}

describe("validate feature", () => {
  test("reports machine-readable legacy migration warning and NO-GO", () => {
    const root = makeTempRepo();
    const spec = sampleSpec();
    writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", spec as unknown as Record<string, unknown>);
    commitRepo(root);

    const result = capture(root, spec.id);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ version: "scwbs.feature-validation.v1", status: "NO-GO" });
    expect(result.report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("legacy acceptanceCriteria")])
    );
  });

  test("rejects duplicate ownership and unassigned requirements", () => {
    const root = makeTempRepo();
    const spec = sampleSpec({
      requirementsVersion: "1.0.0",
      requirements: [
        {
          id: "REQ-API-001",
          statement: "One",
          acceptanceScenarios: ["One"],
          verificationMode: "automated",
          source: "issue:457"
        },
        {
          id: "REQ-API-002",
          statement: "Two",
          acceptanceScenarios: ["Two"],
          verificationMode: "automated",
          source: "issue:457"
        }
      ]
    });
    writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", spec as unknown as Record<string, unknown>);
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({ requirementIds: ["REQ-API-001"] }) as unknown as Record<string, unknown>
    );
    writeYaml(
      root,
      "contracts/tasks/WBS-001-005.yaml",
      sampleTask({ id: "WBS-001-005", requirementIds: ["REQ-API-001"] }) as unknown as Record<string, unknown>
    );
    writeYaml(
      root,
      "contracts/tasks/WBS-001-006.yaml",
      sampleTask({ id: "WBS-001-006", requirementIds: ["REQ-API-999"] }) as unknown as Record<string, unknown>
    );
    commitRepo(root);

    const result = capture(root, spec.id);
    expect(result.exitCode).toBe(1);
    const requirements = result.report.requirements as Array<{ requirementId: string; issues: string[] }>;
    expect(requirements[0]?.issues.join(" ")).toContain("Duplicate ownership");
    expect(requirements[1]?.issues.join(" ")).toContain("No Task declares ownership");
    expect(result.report.unknownRequirementDeclarations).toEqual([
      { taskId: "WBS-001-006", requirementIds: ["REQ-API-999"] }
    ]);
  });

  test("does not treat stale Evidence as covered", () => {
    const root = makeTempRepo();
    const head = writeStructuredFixture(root, {
      coverage: {
        requirementId: "REQ-API-001",
        status: "covered",
        references: ["test:feature"],
        checkNames: ["test"],
        subjectHeadCommit: "deadbeef",
        diffHash: "sha256:fixture"
      }
    });
    const evidence = sampleEvidence({
      subjectHeadCommit: "deadbeef",
      diffHash: "sha256:fixture",
      requirementEvidence: [
        {
          requirementId: "REQ-API-001",
          status: "covered",
          references: ["test:feature"],
          checkNames: ["test"],
          subjectHeadCommit: "deadbeef",
          diffHash: "sha256:fixture"
        }
      ]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
    const current = commitRepo(root);
    expect(current).not.toBe(head);
    const result = capture(root, "SPEC-F001-API");
    expect(result.exitCode).toBe(1);
    expect((result.report.requirements as Array<{ evidenceStatus: string }>)[0]?.evidenceStatus).toBe("stale");
  });

  test("returns MANUAL_VERIFY_REQUIRED without human evidence", () => {
    const root = makeTempRepo();
    const subject = writeStructuredFixture(root, {
      mode: "manual",
      coverage: {
        requirementId: "REQ-API-001",
        status: "covered",
        references: ["check:test"],
        subjectHeadCommit: "pending",
        diffHash: "sha256:fixture"
      }
    });
    const evidence = sampleEvidence({
      subjectHeadCommit: subject,
      diffHash: "sha256:fixture",
      requirementEvidence: [
        {
          requirementId: "REQ-API-001",
          status: "covered",
          references: ["check:test"],
          subjectHeadCommit: subject,
          diffHash: "sha256:fixture"
        }
      ]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
    const current = commitRepo(root);
    const result = capture(root, "SPEC-F001-API", current);
    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe("MANUAL_VERIFY_REQUIRED");
  });

  test("returns GO only for current automated Evidence", () => {
    const root = makeTempRepo();
    const subject = writeStructuredFixture(root, {
      coverage: {
        requirementId: "REQ-API-001",
        status: "covered",
        references: ["test:feature"],
        checkNames: ["test"],
        subjectHeadCommit: "pending",
        diffHash: "sha256:fixture"
      }
    });
    const evidence = sampleEvidence({
      subjectHeadCommit: subject,
      diffHash: "sha256:fixture",
      checks: [{ name: "test", status: "passed" }],
      requirementEvidence: [
        {
          requirementId: "REQ-API-001",
          status: "covered",
          references: ["test:feature"],
          checkNames: ["test"],
          subjectHeadCommit: subject,
          diffHash: "sha256:fixture"
        }
      ]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
    const current = commitRepo(root);
    const result = capture(root, "SPEC-F001-API", current);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      status: "GO",
      summary: { covered: 1, notCovered: 0, manualVerifyRequired: 0 }
    });
  });
});

describe("artifact workflow", () => {
  const workflow = {
    version: "1.0.0",
    id: "fixture-workflow",
    artifacts: [
      {
        id: "source",
        path: "src/*.ts",
        description: "Source implementation",
        dependencies: [],
        instruction: "Implement the source.",
        completion: { mode: "path-exists" }
      },
      {
        id: "test",
        path: "tests/source.test.ts",
        description: "Source test",
        dependencies: ["source"],
        completion: { mode: "path-exists" }
      },
      {
        id: "report",
        path: "docs/report.md",
        description: "Validation report",
        dependencies: ["test"],
        completion: { mode: "path-exists" }
      },
      {
        id: "ready",
        path: "docs/ready.md",
        description: "Independent ready artifact",
        dependencies: [],
        completion: { mode: "path-exists" }
      }
    ],
    profiles: { Standard: ["source", "test", "report"] }
  };

  test("returns versioned status with blocked, ready, done, missing dependencies, and unlocks", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/workflow.json", workflow);
    writeText(root, "src/source.ts", "export const source = true;\n");
    commitRepo(root);

    const result = readArtifactWorkflow(root, "contracts/workflow.json");
    expect(result.issues).toEqual([]);
    expect(result.workflow).toBeDefined();
    const status = buildArtifactWorkflowStatus(root, result.workflow!);
    expect(status).toMatchObject({
      version: "scwbs.artifact-workflow-status.v1",
      workflowId: "fixture-workflow",
      artifacts: [
        { id: "source", state: "done", missingDependencies: [], unlocks: ["test"] },
        { id: "test", state: "ready", missingDependencies: [], unlocks: ["report"] },
        { id: "report", state: "blocked", missingDependencies: ["test"], unlocks: [] },
        { id: "ready", state: "ready", missingDependencies: [], unlocks: [] }
      ]
    });
  });

  test("prints read-only instructions with dependency snapshot and advisory authority", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/workflow.json", workflow);
    commitRepo(root);
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runArtifactWorkflowInstructions(root, "contracts/workflow.json", "test", { json: true })).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(output.join(""))).toMatchObject({
      version: "scwbs.artifact-workflow-instructions.v1",
      workflowId: "fixture-workflow",
      artifact: { id: "test" },
      dependencySnapshot: [{ id: "source" }],
      authority: expect.stringContaining("advisory-only")
    });
  });

  test("rejects duplicate IDs, missing dependencies, cycles, path escapes, and unknown fields", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/workflow.json", {
      version: "1.0.0",
      id: "invalid-workflow",
      artifacts: [
        {
          id: "same",
          path: "src/a.ts",
          description: "A",
          dependencies: ["missing"],
          completion: { mode: "path-exists", extra: true }
        },
        {
          id: "same",
          path: "../outside.ts",
          description: "B",
          dependencies: ["same"],
          authority: "allow",
          completion: { mode: "path-exists" }
        }
      ]
    });
    const result = readArtifactWorkflow(root, "contracts/workflow.json");
    expect(result.workflow).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "workflow.duplicateId",
        "workflow.missingDependency",
        "workflow.pathEscape",
        "workflow.unknownField",
        "workflow.cycle"
      ])
    );
  });

  test("rejects schema drift and malformed optional fields without migration", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/workflow.yaml", {
      version: "2.0.0",
      id: "drifted-workflow",
      artifacts: [
        {
          id: "source",
          path: "src/source.ts",
          description: "Source",
          dependencies: [],
          context: [42],
          completion: { mode: "path-exists" }
        }
      ]
    });
    const result = readArtifactWorkflow(root, "contracts/workflow.yaml");
    expect(result.workflow).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["workflow.version", "workflow.context"])
    );
  });

  test("status command emits a versioned JSON report", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/workflow.json", workflow);
    commitRepo(root);
    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runArtifactWorkflowStatus(root, "contracts/workflow.json", { json: true })).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(output.join(""))).toMatchObject({
      version: "scwbs.artifact-workflow-status.v1",
      workflowId: "fixture-workflow"
    });
  });
});
