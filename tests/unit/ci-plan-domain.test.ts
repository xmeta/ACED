import { describe, expect, test } from "vitest";
import { classifyCiPlanFiles, uniqueCiPlanReasons } from "../../src/core/ci-plan-domain.js";

describe("ci-plan domain", () => {
  test("deduplicates identical reasons while retaining distinct messages", () => {
    const reasons = uniqueCiPlanReasons([
      { code: "same", message: "one" },
      { code: "same", message: "one" },
      { code: "same", message: "two" }
    ]);
    expect(reasons).toEqual([{ code: "same", message: "one" }, { code: "same", message: "two" }]);
  });

  test("classifies implementation files as standard and excludes bootstrap files", () => {
    const result = classifyCiPlanFiles(["contracts/tasks/T.yaml", "src/example.ts"], ["contracts/tasks/T.yaml"], [".github/**"], [], []);
    expect(result).toMatchObject({
      consideredFiles: ["src/example.ts"],
      excludedBootstrapFiles: ["contracts/tasks/T.yaml"],
      executionClass: "standard"
    });
    expect(result.reasons[0]?.code).toBe("classification.standard");
  });

  test("fails closed for human gate, high-risk, and provenance reasons", () => {
    const result = classifyCiPlanFiles(
      [".github/workflows/check.yml", "package.json", "src/security/secret.ts"],
      [],
      ["src/security/**"],
      [],
      [{ code: "git.shallow", message: "history unavailable" }]
    );
    expect(result.executionClass).toBe("high-risk");
    expect(result.reasons.map((item) => item.code)).toEqual(expect.arrayContaining([
      "classification.provenance.unverified",
      "classification.path.humanGate",
      "classification.path.highRisk"
    ]));
  });
});
