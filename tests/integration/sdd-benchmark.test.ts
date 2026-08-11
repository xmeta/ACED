import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const runner = join(root, "benchmarks/sdd/runner.mjs");
const manifest = join(root, "benchmarks/sdd/manifest.json");

describe("SDD benchmark replay report", () => {
  test("records raw command argv and separates safety failure from subjective score", () => {
    const output = mkdtempSync(join(tmpdir(), "aced-sdd-benchmark-integration-"));
    const observations = join(output, "observations.json");
    writeFileSync(observations, JSON.stringify({
      schemaVersion: "scwbs.sdd-benchmark.observation.v1",
      entries: [
        {
          toolId: "aced",
          scenarioId: "ordinary-feature",
          status: "PASS",
          setupStatus: "PASS",
          safetyViolation: false,
          rawMetrics: { friction: { commandsToCompletion: 4 }, safety: { staleEvidenceDetected: true }, agentEfficiency: { retries: 1 } },
          subjectiveScore: { usability: 4 },
          commandLog: [{ argv: ["npm", "run", "scwbs", "--", "check"], shell: false, exitCode: 0, durationMs: 42, stdout: "PASS", stderr: "" }]
        },
        {
          toolId: "spec-kit",
          scenarioId: "dangerous-auth-config",
          status: "FAIL",
          setupStatus: "PASS",
          safetyViolation: true,
          rawMetrics: { safety: { outOfScopeEditBlocked: false } },
          commandLog: []
        }
      ]
    }));
    const result = JSON.parse(execFileSync(process.execPath, [runner, "--manifest", manifest, "--out-dir", output, "--observations", observations], { encoding: "utf8" }));
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(result.status).toBe("pass");
    expect(existsSync(join(output, "report.md"))).toBe(true);
    const aced = report.results.find((entry: { toolId: string; scenarioId: string }) => entry.toolId === "aced" && entry.scenarioId === "ordinary-feature");
    const specKit = report.results.find((entry: { toolId: string; scenarioId: string }) => entry.toolId === "spec-kit" && entry.scenarioId === "dangerous-auth-config");
    expect(aced.status).toBe("PASS");
    expect(aced.commandLog[0].argv).toEqual(["npm", "run", "scwbs", "--", "check"]);
    expect(aced.subjectiveScore).toEqual({ usability: 4 });
    expect(specKit.status).toBe("FAIL");
    expect(specKit.safetyStatus).toBe("FAIL");
    expect(report.roadmap.generated).toBe(false);
  });
});
