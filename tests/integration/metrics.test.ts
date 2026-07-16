import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildGovernanceCostSummary, runMetricsGovernance } from "../../src/commands/metrics.js";
import { main } from "../../src/cli.js";
import { summarizeGithubActionsRuns } from "../../src/core/github-actions.js";
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
    expect(summary.unmeasured).toContain("historical local check duration");
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  test("summarizes completed GitHub Actions durations without treating incomplete runs as zero duration", () => {
    const summary = summarizeGithubActionsRuns("xmeta/ACED", [
      { id: 1, name: "SC-WBS", event: "pull_request", headBranch: "task/a", status: "completed", conclusion: "success", createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:10Z" },
      { id: 2, name: "SC-WBS", event: "push", headBranch: "main", status: "completed", conclusion: "failure", createdAt: "2026-07-16T01:00:00Z", updatedAt: "2026-07-16T01:00:30Z" },
      { id: 3, name: "Other", event: "push", headBranch: "main", status: "in_progress", conclusion: null, createdAt: "2026-07-16T02:00:00Z", updatedAt: "2026-07-16T02:00:05Z" }
    ], 100);
    expect(summary).toMatchObject({ matchingRunCount: 3, completedRunCount: 2, incompleteRunCount: 1 });
    expect(summary.durationMilliseconds).toMatchObject({ total: 40000, average: 20000, minimum: 10000, maximum: 30000 });
    expect(summary.workflows["SC-WBS"]).toEqual({ runCount: 2, completedRunCount: 2, durationMilliseconds: 40000 });
    expect(summary.workflows.Other).toEqual({ runCount: 1, completedRunCount: 0, durationMilliseconds: 0 });
    expect(summary.events).toEqual({ pull_request: { runCount: 1, completedRunCount: 1 }, push: { runCount: 2, completedRunCount: 1 } });
    expect(summary.branches.main).toEqual({ runCount: 2, completedRunCount: 1 });
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
