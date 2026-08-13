import { describe, expect, test } from "vitest";
import { collectRiskIssues, riskAcceptanceStatus, riskCurrentScope, riskLevel, riskScore } from "../../src/core/risk.js";
import { listRisks } from "../../src/core/contracts.js";
import type { RiskRecord } from "../../src/core/types.js";
import { writeYaml, makeTempRepo, sampleEvidence } from "../helpers.js";

function risk(overrides: Partial<RiskRecord> = {}): RiskRecord {
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

function spec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "SPEC-001",
    type: "spec-contract",
    featureId: "F-001",
    title: "Risk scope fixture",
    status: "approved",
    version: "1.0.0",
    acceptanceCriteria: ["Requirement is covered"],
    requirementsVersion: "1.0.0",
    approvedBy: "risk-test",
    approvedAt: "2026-08-12T00:00:00+09:00",
    requirements: [{
      id: "REQ-001",
      statement: "Requirement is covered",
      acceptanceScenarios: ["Given evidence, then covered"],
      verificationMode: "automated",
      source: "tests/unit/risk.test.ts"
    }],
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
    writeYaml(root, "contracts/risks/RISK-AUTH.yaml", risk({ scope: { tasks: ["TASK-001"], specs: [], requirements: [] }, acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", subjectHeadCommit: "head-1", diffHash: "sha256:one", reason: "reviewed" } }));
    const entry = listRisks(root)[0];
    expect(entry?.risk).toBeDefined();
    expect(riskAcceptanceStatus(root, entry!.risk!)).toBe("valid");
    writeYaml(root, "contracts/evidence/TASK-001.yaml", sampleEvidence({ taskId: "TASK-001", subjectHeadCommit: "head-2", diffHash: "sha256:two" }));
    expect(riskAcceptanceStatus(root, entry!.risk!)).toBe("stale");
  });

  test("builds an order-independent aggregate fingerprint across Tasks, Specs, and Requirements", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/TASK-A.yaml", sampleEvidence({ taskId: "TASK-A", subjectHeadCommit: "head-a", diffHash: "sha256:a" }));
    writeYaml(root, "contracts/evidence/TASK-B.yaml", sampleEvidence({ taskId: "TASK-B", subjectHeadCommit: "head-b", diffHash: "sha256:b" }));
    writeYaml(root, "contracts/specs/SPEC-001.yaml", spec());
    const first = risk({ scope: { tasks: ["TASK-B", "TASK-A"], specs: ["SPEC-001"], requirements: ["REQ-001"] } });
    const second = { ...first, scope: { tasks: ["TASK-A", "TASK-B"], specs: ["SPEC-001"], requirements: ["REQ-001"] } };
    const firstScope = riskCurrentScope(root, first);
    const secondScope = riskCurrentScope(root, second);
    expect(firstScope.complete).toBe(true);
    expect(firstScope.scopeFingerprint).toBe(secondScope.scopeFingerprint);
    expect(firstScope.constituents).toHaveLength(4);
  });

  test("marks acceptance stale when a non-first Task Evidence changes", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/TASK-A.yaml", sampleEvidence({ taskId: "TASK-A", subjectHeadCommit: "head-a", diffHash: "sha256:a" }));
    writeYaml(root, "contracts/evidence/TASK-B.yaml", sampleEvidence({ taskId: "TASK-B", subjectHeadCommit: "head-b", diffHash: "sha256:b" }));
    const current = riskCurrentScope(root, risk({ scope: { tasks: ["TASK-A", "TASK-B"], specs: [], requirements: [] } }));
    writeYaml(root, "contracts/risks/RISK-AUTH.yaml", risk({
      scope: { tasks: ["TASK-A", "TASK-B"], specs: [], requirements: [] },
      acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", scopeFingerprint: current.scopeFingerprint, reason: "reviewed" }
    }));
    const acceptedEntry = listRisks(root)[0];
    if (!acceptedEntry?.risk) throw new Error("risk fixture was not readable");
    const accepted = acceptedEntry.risk;
    expect(riskAcceptanceStatus(root, accepted)).toBe("valid");
    writeYaml(root, "contracts/evidence/TASK-B.yaml", sampleEvidence({ taskId: "TASK-B", subjectHeadCommit: "head-b2", diffHash: "sha256:b2" }));
    expect(riskAcceptanceStatus(root, accepted)).toBe("stale");
  });

  test("detects Task scope changes, Spec/Requirement changes, and missing scope identities", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/TASK-A.yaml", sampleEvidence({ taskId: "TASK-A", subjectHeadCommit: "head-a", diffHash: "sha256:a" }));
    writeYaml(root, "contracts/evidence/TASK-B.yaml", sampleEvidence({ taskId: "TASK-B", subjectHeadCommit: "head-b", diffHash: "sha256:b" }));
    writeYaml(root, "contracts/specs/SPEC-001.yaml", spec());
    const base = risk({ scope: { tasks: ["TASK-A"], specs: ["SPEC-001"], requirements: ["REQ-001"] } });
    const acceptedScope = riskCurrentScope(root, base);
    const accepted: RiskRecord = { ...base, acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", scopeFingerprint: acceptedScope.scopeFingerprint, reason: "reviewed" } };
    expect(riskAcceptanceStatus(root, accepted)).toBe("valid");
    expect(riskAcceptanceStatus(root, { ...accepted, scope: { tasks: ["TASK-A", "TASK-B"], specs: ["SPEC-001"], requirements: ["REQ-001"] } })).toBe("stale");
    writeYaml(root, "contracts/specs/SPEC-001.yaml", spec({ version: "1.0.1" }));
    expect(riskAcceptanceStatus(root, accepted)).toBe("stale");
    expect(riskAcceptanceStatus(root, { ...accepted, scope: { tasks: ["TASK-A"], specs: ["SPEC-MISSING"], requirements: ["REQ-001"] } })).toBe("stale");
  });

  test("supports complete Spec-only acceptance and rejects legacy multi-scope acceptance", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/specs/SPEC-001.yaml", spec());
    const specOnly = risk({ scope: { tasks: [], specs: ["SPEC-001"], requirements: [] } });
    const current = riskCurrentScope(root, specOnly);
    expect(current.complete).toBe(true);
    expect(riskAcceptanceStatus(root, { ...specOnly, acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", scopeFingerprint: current.scopeFingerprint, reason: "reviewed" } })).toBe("valid");
    expect(riskAcceptanceStatus(root, { ...specOnly, acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", subjectHeadCommit: "old", diffHash: "sha256:old", reason: "reviewed" } })).toBe("stale");
  });

  test("does not treat incomplete scope as valid even when the fingerprint is present", () => {
    const root = makeTempRepo();
    const value = risk({ scope: { tasks: ["TASK-MISSING"], specs: [], requirements: [] }, acceptance: { acceptedBy: "human", acceptedAt: "2026-08-12T00:00:00+09:00", scopeFingerprint: "sha256:" + "a".repeat(64), reason: "reviewed" } });
    const current = riskCurrentScope(root, value);
    expect(current.complete).toBe(false);
    expect(riskAcceptanceStatus(root, value)).toBe("stale");
  });
});
