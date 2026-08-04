import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test, vi } from "vitest";
import { main } from "../../src/cli.js";
import { collectCheckIssues } from "../../src/commands/check.js";
import { discoveryStateFromProbe } from "../../src/core/discovery.js";
import { parseSimpleYaml } from "../../src/core/yaml.js";
import { makeTempRepo, writeScwbsProject, writeYaml } from "../helpers.js";

function newArgs(probe = "PROBE-cache"): string[] {
  return [
    "discovery", "new",
    "--probe", probe,
    "--question", "Can the existing cache meet the target?",
    "--hypotheses", "Existing cache is enough,Cold starts dominate",
    "--activities", "Measure representative load",
    "--evidence-expected", "p95 latency",
    "--unknowns", "Peak degradation",
    "--timebox", "4h",
    "--cost-limit", "one engineer-day",
    "--exit-conditions", "Representative run complete",
    "--next-decision", "Choose the delivery design",
    "--delivery-task", "WBS-001-004"
  ];
}

function readProbe(root: string, id = "PROBE-cache"): Record<string, unknown> {
  return parseSimpleYaml(readFileSync(path.join(root, "contracts/discovery", `${id}.yaml`), "utf8"));
}

describe("Discovery Probe lifecycle", () => {
  test("derives readiness from explicit exit conditions and preserves unknowns", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(newArgs(), root)).toBe(0);
    expect(discoveryStateFromProbe({
      ...readProbe(root) as unknown as Parameters<typeof discoveryStateFromProbe>[0],
      status: "active"
    })).toMatchObject({
      decisionReadiness: "notReady",
      openUnknowns: ["Peak degradation"],
      blockingUnknowns: ["Peak degradation"],
      nextDecision: "Choose the delivery design"
    });
    expect(discoveryStateFromProbe({
      ...readProbe(root) as unknown as Parameters<typeof discoveryStateFromProbe>[0],
      status: "concluded",
      exitConditionsMet: true,
      remainingUnknowns: []
    })).toMatchObject({ decisionReadiness: "ready", openUnknowns: [], blockingUnknowns: [] });
  });

  test("CLI creates a schema-conformant proposed Probe without implicit overwrite", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const output: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const error = vi.spyOn(console, "error").mockImplementation((value) => errors.push(String(value)));
    try {
      expect(main([...newArgs(), "--json"], root)).toBe(0);
      const report = JSON.parse(output.join(""));
      expect(report).toMatchObject({
        version: "scwbs.discovery.v1",
        status: "created",
        probeId: "PROBE-cache"
      });
      const probe = readProbe(root);
      const schema = JSON.parse(readFileSync(
        path.join(process.cwd(), "docs/scwbs/schemas/discovery-probe.schema.json"),
        "utf8"
      ));
      expect(new Ajv2020({ strict: false }).compile(schema)(probe)).toBe(true);
      expect(probe).toMatchObject({
        schemaVersion: "1.0.0",
        type: "discovery-probe",
        status: "proposed",
        deliveryTaskId: "WBS-001-004",
        hypotheses: ["Existing cache is enough", "Cold starts dominate"]
      });

      output.length = 0;
      expect(main(newArgs(), root)).toBe(1);
      expect(errors.join("\n")).toContain("already exists");
      expect(readProbe(root).status).toBe("proposed");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("goal-form Discovery start creates an active Probe without a delivery Task", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["discovery", "start", "Choose a bounded cache strategy"], root)).toBe(0);
    const probeFile = readdirSync(path.join(root, "contracts/discovery")).find((file) => file.startsWith("PROBE-choose-a-bounded-cache-strategy-"));
    expect(probeFile).toBeTruthy();
    const probe = parseSimpleYaml(readFileSync(path.join(root, "contracts/discovery", probeFile!), "utf8"));
    expect(probe).toMatchObject({ type: "discovery-probe", status: "active" });
    expect(probe).not.toHaveProperty("deliveryTaskId");
    expect(readdirSync(path.join(root, "contracts/tasks")).filter((file) => /^SCWBS-DRAFT-/.test(file))).toEqual([]);
  });

  test("rejects unsafe ids, invalid transitions, and incomplete conclusions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(main(newArgs("../escape"), root)).toBe(1);
      expect(main(newArgs(), root)).toBe(0);
      expect(main(["discovery", "conclude", "--probe", "PROBE-cache", "--outcome", "concluded"], root)).toBe(1);
      expect(main(["discovery", "start", "--probe", "PROBE-cache"], root)).toBe(0);
      expect(main(["discovery", "start", "--probe", "PROBE-cache"], root)).toBe(1);
      expect(main([
        "discovery", "conclude", "--probe", "PROBE-cache",
        "--outcome", "concluded",
        "--facts", "p95 met the target",
        "--rejected", "A new store is required",
        "--exit-conditions-met", "false"
      ], root)).toBe(1);
      expect(readProbe(root).status).toBe("active");
    } finally {
      error.mockRestore();
    }
  });

  test("aggregate check blocks delivery until a valid conclusion", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(newArgs(), root)).toBe(0);
    expect(collectCheckIssues(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "discovery.delivery.blocked" })
    ]));
    expect(main(["discovery", "start", "--probe", "PROBE-cache"], root)).toBe(0);
    expect(main([
      "discovery", "conclude", "--probe", "PROBE-cache",
      "--outcome", "concluded",
      "--facts", "p95 met the target",
      "--rejected", "A new store is required",
      "--exit-conditions-met", "true"
    ], root)).toBe(0);
    expect(readProbe(root)).toMatchObject({
      status: "concluded",
      exitConditionsMet: true,
      factsLearned: ["p95 met the target"],
      hypothesesRejected: ["A new store is required"]
    });
    expect(collectCheckIssues(root).some((issue) => issue.code === "discovery.delivery.blocked")).toBe(false);
  });

  test("inconclusive is terminal with follow-up guidance and keeps delivery blocked", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const output: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      expect(main(newArgs(), root)).toBe(0);
      expect(main(["discovery", "start", "--probe", "PROBE-cache"], root)).toBe(0);
      output.length = 0;
      expect(main([
        "discovery", "conclude", "--probe", "PROBE-cache",
        "--outcome", "inconclusive",
        "--remaining", "Peak load cannot be reproduced",
        "--next-decision", "Decide whether another Probe is worth the cost",
        "--json"
      ], root)).toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        version: "scwbs.discovery.v1",
        status: "inconclusive"
      });
      expect(readProbe(root)).toMatchObject({
        status: "inconclusive",
        remainingUnknowns: ["Peak load cannot be reproduced"],
        nextDecision: "Decide whether another Probe is worth the cost"
      });
      expect(collectCheckIssues(root).some((issue) => issue.code === "discovery.delivery.blocked")).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("help exposes the lifecycle commands", () => {
    const root = makeTempRepo();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(main(["discovery", "--help"], root)).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(chunks.join("")).toContain("new");
    expect(chunks.join("")).toContain("start");
    expect(chunks.join("")).toContain("conclude");
  });

  test("runtime and published schemas reject a false concluded exit state", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/discovery/PROBE-invalid.yaml", {
      schemaVersion: "1.0.0",
      id: "PROBE-invalid",
      type: "discovery-probe",
      status: "concluded",
      question: "Is it safe?",
      hypotheses: [],
      activities: [],
      evidenceExpected: [],
      unknowns: [],
      timebox: "1h",
      costLimit: "low",
      exitConditions: ["Evidence exists"],
      nextDecision: "Proceed",
      concludedAt: "2026-07-26T00:00:00.000Z",
      exitConditionsMet: false,
      factsLearned: [],
      hypothesesRejected: []
    });
    expect(collectCheckIssues(root).some((issue) => issue.code === "discovery.schema")).toBe(true);

    const schema = JSON.parse(readFileSync(
      path.join(process.cwd(), "docs/scwbs/schemas/discovery-probe.schema.json"),
      "utf8"
    ));
    expect(new Ajv2020({ strict: false }).compile(schema)(readProbe(root, "PROBE-invalid"))).toBe(false);
  });
});
