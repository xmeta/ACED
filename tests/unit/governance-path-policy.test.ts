import { describe, expect, test } from "vitest";
import {
  GOVERNANCE_PATH_POLICY,
  GOVERNANCE_PATH_POLICY_VERSION,
  governancePathImpact,
  requiredNewTaskHumanGatePaths,
  sensitiveMetaPaths,
  standardHumanGatePaths
} from "../../src/core/governance-path-policy.js";

describe("governance path policy", () => {
  test("keeps the baseline Human Gate and sensitive metadata consumers on one source", () => {
    expect(GOVERNANCE_PATH_POLICY_VERSION).toBe("1.0.0");
    expect(GOVERNANCE_PATH_POLICY.length).toBeGreaterThan(standardHumanGatePaths().length);
    expect(standardHumanGatePaths()).toEqual([
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      ".github/**"
    ]);
    expect(requiredNewTaskHumanGatePaths()).toEqual(standardHumanGatePaths());
    expect(sensitiveMetaPaths()).toEqual(expect.arrayContaining([
      ...standardHumanGatePaths(),
      ".gitignore",
      "eslint.config.js",
      "tsconfig.*.json",
      "scripts/tsconfig.json",
      "contracts/check-coverage.yaml"
    ]));
  });

  test("classifies critical paths with machine-readable reasons", () => {
    expect(governancePathImpact("eslint.config.js")).toMatchObject({
      classification: "quality-gate",
      reasonCode: "governance.quality.eslint",
      critical: true
    });
    expect(governancePathImpact("scripts/tsconfig.json")).toMatchObject({
      classification: "build",
      reasonCode: "governance.build.scripts-typescript"
    });
    expect(governancePathImpact("contracts/check-coverage.yaml")).toMatchObject({
      classification: "governance-schema",
      reasonCode: "governance.schema.check-coverage"
    });
  });
});
