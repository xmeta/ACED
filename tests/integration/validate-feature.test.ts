import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { runValidateFeature } from "../../src/commands/validate-feature.js";
import { makeTempRepo, sampleEvidence, sampleSpec, sampleTask, writeYaml } from "../helpers.js";

function capture(root: string, specId: string, baseRef = "HEAD"): { exitCode: number; report: Record<string, unknown> } {
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

function writeStructuredFixture(root: string, options: { mode?: "automated" | "manual" | "hybrid"; coverage?: Record<string, unknown> } = {}): string {
  const spec = sampleSpec({
    requirementsVersion: "1.0.0",
    requirements: [{
      id: "REQ-API-001",
      statement: "The API is traceable.",
      acceptanceScenarios: ["A passing feature check covers the requirement."],
      verificationMode: options.mode ?? "automated",
      source: "issue:457"
    }]
  });
  const task = sampleTask({ requirementIds: ["REQ-API-001"] });
  writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", spec as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", task as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/tasks/index.yaml", {
    tasks: [{ id: task.id, path: "contracts/tasks/WBS-001-004.yaml", branchName: task.branchName, wbsNodeId: task.wbsNodeId, status: "completed", dependsOn: [] }]
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
    expect(result.report.warnings).toEqual(expect.arrayContaining([expect.stringContaining("legacy acceptanceCriteria")]));
  });

  test("rejects duplicate ownership and unassigned requirements", () => {
    const root = makeTempRepo();
    const spec = sampleSpec({
      requirementsVersion: "1.0.0",
      requirements: [
        { id: "REQ-API-001", statement: "One", acceptanceScenarios: ["One"], verificationMode: "automated", source: "issue:457" },
        { id: "REQ-API-002", statement: "Two", acceptanceScenarios: ["Two"], verificationMode: "automated", source: "issue:457" }
      ]
    });
    writeYaml(root, "contracts/specs/SPEC-F001-API.yaml", spec as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requirementIds: ["REQ-API-001"] }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({ id: "WBS-001-005", requirementIds: ["REQ-API-001"] }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({ id: "WBS-001-006", requirementIds: ["REQ-API-999"] }) as unknown as Record<string, unknown>);
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
        requirementId: "REQ-API-001", status: "covered", references: ["test:feature"], checkNames: ["test"], subjectHeadCommit: "deadbeef", diffHash: "sha256:fixture"
      }
    });
    const evidence = sampleEvidence({
      subjectHeadCommit: "deadbeef",
      diffHash: "sha256:fixture",
      requirementEvidence: [{ requirementId: "REQ-API-001", status: "covered", references: ["test:feature"], checkNames: ["test"], subjectHeadCommit: "deadbeef", diffHash: "sha256:fixture" }]
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
        requirementId: "REQ-API-001", status: "covered", references: ["check:test"], subjectHeadCommit: "pending", diffHash: "sha256:fixture"
      }
    });
    const evidence = sampleEvidence({
      subjectHeadCommit: subject,
      diffHash: "sha256:fixture",
      requirementEvidence: [{ requirementId: "REQ-API-001", status: "covered", references: ["check:test"], subjectHeadCommit: subject, diffHash: "sha256:fixture" }]
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
        requirementId: "REQ-API-001", status: "covered", references: ["test:feature"], checkNames: ["test"], subjectHeadCommit: "pending", diffHash: "sha256:fixture"
      }
    });
    const evidence = sampleEvidence({
      subjectHeadCommit: subject,
      diffHash: "sha256:fixture",
      checks: [{ name: "test", status: "passed" }],
      requirementEvidence: [{ requirementId: "REQ-API-001", status: "covered", references: ["test:feature"], checkNames: ["test"], subjectHeadCommit: subject, diffHash: "sha256:fixture" }]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
    const current = commitRepo(root);
    const result = capture(root, "SPEC-F001-API", current);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({ status: "GO", summary: { covered: 1, notCovered: 0, manualVerifyRequired: 0 } });
  });
});
