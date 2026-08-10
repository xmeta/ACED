import type { Issue } from "./types.js";

export type HealthIssueSummary = {
  status: "pass" | "warn" | "fail";
  summary: {
    total: number;
    errors: number;
    warnings: number;
    byCode: Array<{ code: string; severity: Issue["severity"]; count: number }>;
  };
  issues: Issue[];
};

function issuePriority(issue: Issue): number {
  if (issue.severity === "error") return 0;
  if (/humanGate|approval/i.test(issue.code)) return 1;
  if (issue.fixCommand || issue.remediation) return 2;
  return 3;
}

export function sortHealthIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) =>
    issuePriority(left) - issuePriority(right)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  );
}

export function summarizeHealthIssues(issues: Issue[]): HealthIssueSummary {
  const sorted = sortHealthIssues(issues);
  const byCode = new Map<string, { code: string; severity: Issue["severity"]; count: number }>();
  for (const issue of sorted) {
    const existing = byCode.get(issue.code);
    if (existing) existing.count += 1;
    else byCode.set(issue.code, { code: issue.code, severity: issue.severity, count: 1 });
  }
  const errors = sorted.filter((issue) => issue.severity === "error").length;
  return {
    status: errors > 0 ? "fail" : sorted.length > 0 ? "warn" : "pass",
    summary: { total: sorted.length, errors, warnings: sorted.length - errors, byCode: [...byCode.values()] },
    issues: sorted
  };
}
