import { describe, expect, test } from "vitest";
import { collectRiskIssues, riskAcceptanceStatus, riskLevel, riskScore } from "../../src/core/risk.js";
import { listRisks } from "../../src/core/contracts.js";
import { writeYaml, makeTempRepo, sampleEvidence } from "../helpers.js";

function risk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "scwbs.risk.v1",
    id: "RISK-AUTH",
    type: "risk",
    title: "Authentication risk",
    status: "open",
    scope: { tasks: ["TASK-001"], specs: ["SPEC-001"], requirements: ["REQ-001"] },
    assessment: { likelihood: 4, impact: 4, score: 16, level: "high" },
    treatment: { strategy: "mitigate", owner: "security", actions: ["Add control"], verification: ["Run check"] },
    residualRisk: { likelihood: 4, impact: 4, score: 16, level: "high" },
    createdAt: "2026-08-12T00:00:00+09:00",
    ...overrides
  };
}

describe("Risk Register v1", () => {
  test("uses the non-configurable product score and level boundaries", () => {
    expect(riskScore(1, 1)).toBe(1);
    expect(riskScore(2, 2)).toBe(4);
    expect(riskScore(3, 3)).toBe(9);
    expect(riskScore(4, 4)).toBe(16);
    expect(riskScore(5, 5)).toBe(25);
    expect(riskLevel(4)).toBe("low");
    expect(riskLevel(5)).toBe("medium");
    expect(riskLevel(10)).toBe("high");
    expect(riskLevel(17)).toBe("critical");
  });

  test("fails Strict high risk without treatment and acceptance, but leaves Standard unchanged", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/risks/RISK-AUTH.yaml", risk({ treatment: { strategy: "mitigate", owner: "security", actions: [], verification: [] } }));
    const strict = collectRiskIssues(root, "Strict");
    expect(strict.map((item) => item.code)).toEqual(expect.arrayContaining(["risk.treatment.required", "risk.acceptance.required"]));
    expect(collectRiskIssues(root, "Standard")).toEqual([]);
    expect(collectRiskIssues(root, "Lean")).toEqual([]);
  });

  test("marks acceptance stale when the linked Evidence subject changes", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/TASK-001.yaml", sampleEvidence({ taskId: "TASK-001", subjectHeadCommit: "head-1", diffHash: "sha256:one" }));
    writeYaml(root, "contracts/risks/RISK-AUTH.yaml", risk({ acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", subjectHeadCommit: "head-1", diffHash: "sha256:one", reason: "reviewed" } }));
    const entry = listRisks(root)[0];
    expect(entry?.risk).toBeDefined();
    expect(riskAcceptanceStatus(root, entry!.risk!)).toBe("valid");
    writeYaml(root, "contracts/evidence/TASK-001.yaml", sampleEvidence({ taskId: "TASK-001", subjectHeadCommit: "head-2", diffHash: "sha256:two" }));
    expect(riskAcceptanceStatus(root, entry!.risk!)).toBe("stale");
  });
});
