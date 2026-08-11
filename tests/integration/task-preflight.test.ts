import { describe, expect, test } from "vitest";
import { buildPolicyExplainOutput, buildTaskPreflightOutput } from "../../src/commands/task-new.js";
import { makeTempRepo, writeScwbsProject, writeYaml } from "../helpers.js";

function writeCoveragePolicy(root: string): void {
  writeYaml(root, "contracts/check-coverage.yaml", {
    implementationRoots: ["src"],
    rules: [{
      id: "command",
      classification: "behavior-critical",
      rationale: "CLI paths require integration coverage.",
      paths: ["src/commands/**"],
      requires: ["test:integration"]
    }]
  });
}

describe("task preflight and policy explain", () => {
  test("derives checks and Evidence without creating a Task", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeCoveragePolicy(root);

    const result = buildTaskPreflightOutput(root, {
      title: "Add a command",
      paths: ["src/commands/example.ts"]
    });

    expect(result).toMatchObject({
      version: "scwbs.task-preflight.v1",
      status: "pass",
      derived: {
        requiredChecks: ["test:integration"],
        evidence: ["test-result"],
        humanGatePaths: []
      },
      reasons: []
    });
  });

  test("reports Human Gate policy as review-required and remains read-only", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const result = buildTaskPreflightOutput(root, {
      title: "Change policy",
      paths: ["contracts/check-coverage.yaml"]
    });

    expect(result.status).toBe("review-required");
    expect(result.derived.humanGatePaths).toEqual(["contracts/check-coverage.yaml"]);
    expect(result.policy.reasons[0]).toMatchObject({
      reasonCode: "governance.schema.check-coverage",
      source: "src/core/governance-path-policy.ts"
    });
  });

  test("fails closed for an unclassified implementation path", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeCoveragePolicy(root);
    const result = buildTaskPreflightOutput(root, {
      title: "Unknown implementation",
      paths: ["src/unknown.ts"]
    });

    expect(result.status).toBe("fail");
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "checkCoverage.unclassified" }));
  });

  test("policy explain exposes forbidden path and stable policy metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const result = buildPolicyExplainOutput(root, "wjs/runtime.ts");

    expect(result).toMatchObject({
      version: "scwbs.policy-explain.v1",
      status: "fail",
      path: "wjs/runtime.ts",
      policyVersion: "1.0.0"
    });
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "policy.path.forbidden" }));
  });
});
