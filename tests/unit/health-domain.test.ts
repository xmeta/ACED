import { describe, expect, test } from "vitest";
import { sortHealthIssues, summarizeHealthIssues } from "../../src/core/health-domain.js";

describe("health domain", () => {
  test("sorts errors and human-gate warnings before fixable and ordinary warnings", () => {
    const issues = [
      { severity: "warn" as const, code: "z-last", message: "last" },
      { severity: "warn" as const, code: "health.approval.pending", message: "approval" },
      { severity: "error" as const, code: "a-error", message: "error" },
      { severity: "warn" as const, code: "health.fix", message: "fix", fixCommand: "fix" }
    ];
    expect(sortHealthIssues(issues).map((issue) => issue.code)).toEqual([
      "a-error", "health.approval.pending", "health.fix", "z-last"
    ]);
  });

  test("summarizes empty and repeated issue codes deterministically", () => {
    expect(summarizeHealthIssues([])).toEqual({
      status: "pass",
      summary: { total: 0, errors: 0, warnings: 0, byCode: [] },
      issues: []
    });
    const summary = summarizeHealthIssues([
      { severity: "warn", code: "same", message: "one" },
      { severity: "warn", code: "same", message: "two" },
      { severity: "error", code: "bad", message: "bad" }
    ]);
    expect(summary).toMatchObject({ status: "fail", summary: { total: 3, errors: 1, warnings: 2 } });
    expect(summary.summary.byCode).toEqual([
      { code: "bad", severity: "error", count: 1 },
      { code: "same", severity: "warn", count: 2 }
    ]);
  });
});
