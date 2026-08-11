import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const runner = join(root, "benchmarks/sdd/runner.mjs");
const manifest = join(root, "benchmarks/sdd/manifest.json");

describe("SDD benchmark runner", () => {
  test("plan-only mode creates bounded JSON and Markdown with N/A observations", () => {
    const output = mkdtempSync(join(tmpdir(), "aced-sdd-benchmark-unit-"));
    const stdout = execFileSync(process.execPath, [runner, "--manifest", manifest, "--out-dir", output], { encoding: "utf8" });
    const result = JSON.parse(stdout);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(result.status).toBe("pass");
    expect(result.executionMode).toBe("plan-only");
    expect(report.results).toHaveLength(12);
    expect(new Set(report.results.map((entry: { status: string }) => entry.status))).toEqual(new Set(["N/A"]));
    expect(report.roadmap.generated).toBe(false);
    expect(readFileSync(join(output, "report.md"), "utf8")).toContain("Automatic roadmap generation: false.");
  });

  test("rejects a safety violation that is not classified FAIL", () => {
    const output = mkdtempSync(join(tmpdir(), "aced-sdd-benchmark-invalid-"));
    const observations = join(output, "observations.json");
    writeFileSync(observations, JSON.stringify({
      schemaVersion: "scwbs.sdd-benchmark.observation.v1",
      entries: [{ toolId: "aced", scenarioId: "dangerous-auth-config", status: "PASS", safetyViolation: true, commandLog: [] }]
    }));
    expect(() => execFileSync(process.execPath, [runner, "--manifest", manifest, "--out-dir", output, "--observations", observations], { encoding: "utf8", stdio: "pipe" })).toThrow();
  });
});
