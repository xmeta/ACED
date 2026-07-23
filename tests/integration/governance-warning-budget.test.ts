import { describe, expect, test } from "vitest";
import { configuredWarningBudget, evaluateGovernanceWarningBudgets, type GovernanceBaseline } from "../../src/core/governance-warning-budget.js";
import { main } from "../../src/cli.js";
import { makeTempRepo, sampleWbs, writeScwbsProject } from "../helpers.js";

const readyBaseline: GovernanceBaseline = {
  completedTaskCount: 10,
  minimumCompletedTaskCount: 10,
  observedHumanGateCount: 2,
  minimumObservedHumanGateCount: 2,
  executionClasses: { full: 2, metadataDescendant: 2, minimumEach: 2 }
};

function configuredWbs() {
  return {
    ...sampleWbs(),
    extensions: {
      scwbs: {
        profile: "Standard",
        governanceCost: {
          warningBudgets: {
            Lean: { governanceFiles: 10 },
            Standard: { governanceLines: 20 },
            Strict: { governanceToSourceLineRatio: 3 }
          }
        }
      }
    }
  };
}

describe("governance warning budgets", () => {
  test("selects Lean, Standard, and Strict independently", () => {
    const wbs = configuredWbs();
    expect(configuredWarningBudget(wbs, "Lean")).toEqual({ governanceFiles: 10, governanceLines: undefined, governanceToSourceLineRatio: undefined });
    expect(configuredWarningBudget(wbs, "Standard")?.governanceLines).toBe(20);
    expect(configuredWarningBudget(wbs, "Strict")?.governanceToSourceLineRatio).toBe(3);
  });

  test("reports not-configured and insufficient-baseline without inventing thresholds", () => {
    const unconfigured = evaluateGovernanceWarningBudgets(sampleWbs(), "Standard", readyBaseline, {
      governanceFiles: 100, governanceLines: 100, governanceToSourceLineRatio: 1
    });
    expect(unconfigured).toMatchObject({ status: "not-configured", thresholds: null, warnings: [] });
    const insufficient = evaluateGovernanceWarningBudgets(configuredWbs(), "Standard", {
      ...readyBaseline,
      completedTaskCount: 9
    }, { governanceFiles: 100, governanceLines: 100, governanceToSourceLineRatio: 1 });
    expect(insufficient).toMatchObject({ status: "insufficient-baseline", warnings: [] });
  });

  test("returns bounded warnings only after the baseline is sufficient", () => {
    const result = evaluateGovernanceWarningBudgets(configuredWbs(), "Standard", readyBaseline, {
      governanceFiles: 100, governanceLines: 21, governanceToSourceLineRatio: 4
    });
    expect(result).toMatchObject({ status: "available", warnings: ["governance lines 21 exceed 20"] });
  });

  test("health governance-cost is explicit and budget status never changes a clean exit code", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    expect(main(["health", "--governance-cost", "--json"], root)).toBe(0);
  });
});
