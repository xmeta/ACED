import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildGovernanceCostSummary, runMetricsGovernance } from "../../src/commands/metrics.js";
import { main } from "../../src/cli.js";
import { makeTempRepo, sampleWbs, writeJson, writeText, writeYaml } from "../helpers.js";

function captureStdout(action: () => number): { result: number; stdout: string } {
  const output: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: action(), stdout: output.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("governance metrics", () => {
  test("reports profile buckets and separates archived artifacts without writing", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", {
      ...sampleWbs(),
      extensions: { scwbs: { profile: "Strict" } }
    });
    writeYaml(root, "contracts/tasks/ACTIVE.yaml", { id: "ACTIVE", status: "planned" });
    writeYaml(root, "contracts/tasks/archive/OLD.yaml", { id: "OLD", status: "archived" });
    writeText(root, "contracts/specs/STRICT-ONLY.yaml", "status: approved\n");
    writeText(root, "contracts/registry.yaml", "projectId: metrics\ncontracts: []\n");
    writeText(root, "src/example.ts", "export const example = true;\n");
    writeText(root, "tests/example.test.ts", "test('example', () => undefined);\n");
    const before = readdirSync(root, { recursive: true }).sort();

    const summary = buildGovernanceCostSummary(root, new Date("2026-07-16T00:00:00.000Z"));

    expect(summary.profile).toBe("Strict");
    expect(summary.generatedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(summary.categories["contracts/tasks"]).toMatchObject({
      files: 2,
      activeFiles: 1,
      archivedFiles: 1
    });
    expect(summary.profiles.Strict.files).toBeGreaterThan(summary.profiles.Lean.files);
    expect(summary.definitions.hardLimitEnforced).toBe(false);
    expect(summary.unmeasured).toContain("historical CI and local check duration");
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  test("wires the bounded JSON summary through the CLI", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    const output = captureStdout(() => main(["metrics", "governance", "--json"], root));
    expect(output.result).toBe(0);
    const summary = JSON.parse(output.stdout);
    expect(summary).toMatchObject({
      schemaVersion: "1.0.0",
      metric: "governance-cost",
      definitions: { hardLimitEnforced: false }
    });
  });

  test("plain output stays bounded and does not claim unmeasured timing", () => {
    const root = makeTempRepo();
    writeJson(root, "contracts/wbs/project.wbs.json", sampleWbs());
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      expect(runMetricsGovernance(root)).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("hard limit: not enforced");
  });
});
