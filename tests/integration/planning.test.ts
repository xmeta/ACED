import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";
import { parseSimpleYaml } from "../../src/core/yaml.js";
import { makeTempRepo, sampleSpec, writeScwbsProject, writeYaml } from "../helpers.js";

function planningSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...sampleSpec({
      id: "SPEC-CACHE",
      featureId: "F-CACHE",
      title: "Cache delivery",
      status: "approved",
      version: "1.0.0",
      acceptanceCriteria: ["p95 meets the target"]
    }),
    planning: {
      unresolvedDecisions: [],
      dependencies: ["API contract approved"],
      gates: ["No database migration"],
      uncertainty: "low",
      probeIds: [],
      readyWindow: [
        {
          id: "adapter",
          title: "Implement bounded cache adapter",
          paths: ["src/cache/**", "tests/cache/**"],
          requiredChecks: ["test", "typecheck"],
          doneCriteria: ["Adapter behavior is verified"]
        },
        {
          id: "metrics",
          title: "Add cache metrics",
          paths: ["src/metrics/cache.ts", "tests/metrics/cache.test.ts"]
        }
      ],
      approachCandidates: [
        "Evaluate distributed invalidation after usage data exists",
        "Consider regional caches"
      ]
    },
    ...overrides
  } as unknown as Record<string, unknown>;
}

function planPath(root: string): string {
  return path.join(root, "contracts/plans/PLAN-CACHE.json");
}

function readPlan(root: string): Record<string, any> {
  return JSON.parse(readFileSync(planPath(root), "utf8")) as Record<string, any>;
}

describe("Rolling Wave Planning", () => {
  test("rejects an unapproved Spec without creating planning artifacts", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({ status: "draft" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(1);
    } finally {
      error.mockRestore();
    }
    expect(existsSync(planPath(root))).toBe(false);
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-adapter.yaml"))).toBe(false);
    expect(existsSync(path.join(root, "contracts/discovery/PROBE-CACHE.yaml"))).toBe(false);
  });

  test("open unknowns generate a Probe instead of delivery Tasks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({
      planning: {
        unresolvedDecisions: ["Choose invalidation semantics"],
        dependencies: ["API contract approved"],
        gates: ["No database migration"],
        uncertainty: "high",
        probeIds: [],
        readyWindow: [{
          id: "adapter",
          title: "Implement bounded cache adapter",
          paths: ["src/cache/**"]
        }],
        approachCandidates: ["Evaluate distributed invalidation"]
      }
    }));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["plan", "--spec", "SPEC-CACHE", "--json"], root)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(output.join(""))).toMatchObject({
      version: "scwbs.plan.v1",
      planningMode: "probe",
      tasks: [],
      probe: "contracts/discovery/PROBE-CACHE.yaml"
    });
    expect(readPlan(root)).toMatchObject({
      planningMode: "probe",
      readyWindow: [],
      inputs: {
        unresolvedDecisions: ["Choose invalidation semantics"],
        uncertainty: "high"
      }
    });
    const probe = parseSimpleYaml(readFileSync(
      path.join(root, "contracts/discovery/PROBE-CACHE.yaml"),
      "utf8"
    ));
    expect(probe).toMatchObject({
      status: "proposed",
      unknowns: ["Choose invalidation semantics"]
    });
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-adapter.yaml"))).toBe(false);
  });

  test("creates only the 1-3 scoped Ready Window Tasks and a schema-conformant Approach Map", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec());
    expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(0);

    const plan = readPlan(root);
    const schema = JSON.parse(readFileSync(
      path.join(process.cwd(), "docs/scwbs/schemas/rolling-wave-plan.schema.json"),
      "utf8"
    ));
    expect(new Ajv2020({ strict: false }).compile(schema)(plan)).toBe(true);
    expect(plan.planningMode).toBe("delivery");
    expect(plan.readyWindow).toHaveLength(2);
    expect(plan.approachMap).toEqual([
      { title: "Evaluate distributed invalidation after usage data exists", status: "candidate" },
      { title: "Consider regional caches", status: "candidate" }
    ]);

    const adapter = parseSimpleYaml(readFileSync(
      path.join(root, "contracts/tasks/WBS-CACHE-adapter.yaml"),
      "utf8"
    ));
    expect(adapter).toMatchObject({
      wbsNodeId: "wbs-less",
      allowedPaths: ["src/cache/**", "tests/cache/**"],
      requiredChecks: ["test", "typecheck"],
      doneCriteria: ["Adapter behavior is verified"],
      stopIf: ["No database migration"]
    });
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-metrics.yaml"))).toBe(true);
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-distributed-invalidation.yaml"))).toBe(false);
    expect(existsSync(path.join(root, "contracts/changesets/plan-SPEC-CACHE.json"))).toBe(false);
  });

  test("rejects broad scopes and more than three Ready Window items", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({
        planning: {
          uncertainty: "low",
          readyWindow: [{ id: "wide", title: "Wide task", paths: ["src/**"] }]
        }
      }));
      expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(1);
      expect(existsSync(planPath(root))).toBe(false);

      writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({
        planning: {
          uncertainty: "low",
          readyWindow: [1, 2, 3, 4].map((id) => ({
            id: String(id),
            title: `Task ${id}`,
            paths: [`src/feature/${id}.ts`]
          }))
        }
      }));
      expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(1);
      expect(existsSync(planPath(root))).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  test("a concluded referenced Probe permits delivery planning", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/discovery/PROBE-CACHE.yaml", {
      schemaVersion: "1.0.0",
      id: "PROBE-CACHE",
      type: "discovery-probe",
      status: "concluded",
      question: "Which cache strategy works?",
      hypotheses: [],
      activities: ["Measure representative load"],
      evidenceExpected: ["p95 latency"],
      unknowns: ["Choose invalidation semantics"],
      timebox: "4h",
      costLimit: "one engineer-day",
      exitConditions: ["Representative run complete"],
      nextDecision: "Choose implementation",
      concludedAt: "2026-07-26T00:00:00.000Z",
      exitConditionsMet: true,
      factsLearned: ["Local invalidation meets the target"],
      hypothesesRejected: ["A distributed store is required"]
    });
    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({
      planning: {
        unresolvedDecisions: ["Choose invalidation semantics"],
        uncertainty: "high",
        probeIds: ["PROBE-CACHE"],
        readyWindow: [{
          id: "adapter",
          title: "Implement bounded cache adapter",
          paths: ["src/cache/**"]
        }],
        approachCandidates: ["Revisit distributed invalidation later"]
      }
    }));
    expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(0);
    expect(readPlan(root)).toMatchObject({
      planningMode: "delivery",
      inputs: { probeResults: [{ id: "PROBE-CACHE", status: "concluded" }] }
    });
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-adapter.yaml"))).toBe(true);
  });

  test("an inconclusive referenced Probe remains a normal delivery stop", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/discovery/PROBE-CACHE.yaml", {
      schemaVersion: "1.0.0",
      id: "PROBE-CACHE",
      type: "discovery-probe",
      status: "inconclusive",
      question: "Which cache strategy works?",
      hypotheses: [],
      activities: ["Measure representative load"],
      evidenceExpected: ["p95 latency"],
      unknowns: ["Choose invalidation semantics"],
      timebox: "4h",
      costLimit: "one engineer-day",
      exitConditions: ["Representative run complete"],
      nextDecision: "Decide whether another Probe is worth the cost",
      concludedAt: "2026-07-26T00:00:00.000Z",
      exitConditionsMet: false,
      factsLearned: [],
      hypothesesRejected: [],
      remainingUnknowns: ["Peak load cannot be reproduced"]
    });
    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({
      planning: {
        unresolvedDecisions: [],
        uncertainty: "low",
        probeIds: ["PROBE-CACHE"],
        readyWindow: [{
          id: "adapter",
          title: "Implement bounded cache adapter",
          paths: ["src/cache/**"]
        }]
      }
    }));
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(["plan", "--spec", "SPEC-CACHE", "--json"], root)).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(output.join(""))).toMatchObject({
      planningMode: "probe",
      nextAction: "Create a follow-up Discovery Probe, then replan before delivery"
    });
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-adapter.yaml"))).toBe(false);
  });

  test("replanning requires a reason and records the previous hash and Task diff", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec());
    expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(0);
    const first = readPlan(root);

    writeYaml(root, "contracts/specs/SPEC-CACHE.yaml", planningSpec({
      planning: {
        uncertainty: "low",
        readyWindow: [
          {
            id: "adapter",
            title: "Implement bounded cache adapter",
            paths: ["src/cache/**", "tests/cache/**"],
            requiredChecks: ["test", "typecheck"],
            doneCriteria: ["Adapter behavior is verified"]
          },
          {
            id: "eviction",
            title: "Add eviction policy",
            paths: ["src/cache/eviction.ts", "tests/cache/eviction.test.ts"]
          }
        ],
        approachCandidates: ["Consider regional caches"]
      }
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(["plan", "--spec", "SPEC-CACHE"], root)).toBe(1);
    } finally {
      error.mockRestore();
    }
    expect(readPlan(root).generatedAt).toBe(first.generatedAt);

    expect(main([
      "plan", "--spec", "SPEC-CACHE",
      "--replan-reason", "Probe evidence changed the delivery order"
    ], root)).toBe(0);
    expect(readPlan(root).replan).toMatchObject({
      reason: "Probe evidence changed the delivery order",
      previousHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      changes: {
        added: ["WBS-CACHE-eviction"],
        removed: ["WBS-CACHE-metrics"],
        retained: ["WBS-CACHE-adapter"]
      }
    });
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-metrics.yaml"))).toBe(true);
    expect(existsSync(path.join(root, "contracts/tasks/WBS-CACHE-eviction.yaml"))).toBe(true);
  });
});
