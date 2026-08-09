import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { main } from "../../src/cli.js";
import { buildNextJsonOutput } from "../../src/commands/next.js";
import { sampleEvidence, sampleTask, makeTempRepo, writeScwbsProject, writeYaml } from "../helpers.js";

function captureStdout(run: () => number): { code: number; output: string } {
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    output += `${args.map(String).join(" ")}\n`;
  };
  try {
    return { code: run(), output };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

function validateSchema(file: string, value: unknown): void {
  const schema = JSON.parse(readFileSync(path.join(process.cwd(), file), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  if (file.endsWith("ui.schema.json")) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/next.schema.json"), "utf8")));
  }
  const valid = ajv.compile(schema)(value);
  expect(valid, JSON.stringify(value)).toBe(true);
}

describe("versioned navigation JSON", () => {
  test("next --json returns a machine-readable action and reason code", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureStdout(() => main(["next", "--json"], root));
    expect(result.code).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({
      version: "scwbs.next.v1",
      status: "actionable",
      action: { kind: "collect-evidence", owner: "ai", taskId: "WBS-001-004" },
      reasons: [{ code: "evidence.missing" }]
    });
    validateSchema("docs/scwbs/schemas/next.schema.json", output);
  });

  test("next --json makes Human Gate ownership and AI stop explicit", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    const task = sampleTask({ humanGateRequiredPaths: ["src/security/**"] });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", task as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/security/policy.ts"],
      git: { ...sampleEvidence().git, pullRequest: "#42" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested"
    });

    const output = buildNextJsonOutput(root);
    expect(output).toMatchObject({
      version: "scwbs.next.v1",
      status: "waiting",
      action: { owner: "human", aiStop: true, taskId: "WBS-001-004" },
      reasons: [{ code: "review.human_decision_required" }]
    });
  });

  test("ui --json aggregates versioned status, next, review, and doctor sections", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureStdout(() => main(["ui", "--json"], root));
    expect(result.code).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({
      version: "scwbs.ui.v1",
      statusReport: { version: "scwbs.status.v1" },
      next: { version: "scwbs.next.v1" },
      review: { schemaVersion: "1.0.0" },
      doctor: { status: expect.any(String) }
    });
    validateSchema("docs/scwbs/schemas/ui.schema.json", output);
  });

  test("trace --json returns stable graph nodes and edges", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    const result = captureStdout(() => main(["trace", "--task", "WBS-001-004", "--json"], root));
    expect(result.code).toBe(0);
    const output = JSON.parse(result.output);
    expect(output).toMatchObject({ version: "scwbs.trace.v1", taskId: "WBS-001-004" });
    expect(output.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "spec" }),
      expect.objectContaining({ kind: "wbs" }),
      expect.objectContaining({ kind: "task" })
    ]));
    expect(output.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "specifies" }),
      expect.objectContaining({ kind: "assigns" })
    ]));
    validateSchema("docs/scwbs/schemas/trace.schema.json", output);
  });
});
