import { collectCheckIssues } from "./check.js";
import { collectHealthIssues } from "./health.js";
import type { Issue } from "../core/types.js";

function suggestedFix(issue: Issue): string {
  if (issue.code.startsWith("task.contractLock")) return "scwbs task refresh --task <task-id>";
  if (issue.code === "health.task.contractLock.missing") return "scwbs task lock --task <task-id>";
  if (issue.code === "evidence.missing") return "scwbs evidence collect --task <task-id>";
  if (issue.code.startsWith("registry.") || issue.code === "spec.registry.missing") return "scwbs registry rebuild --check";
  if (issue.code.includes("approval") || issue.code.includes("humanGate")) return "scwbs approval request --task <task-id>";
  if (issue.code.startsWith("health.evidence.git")) return "scwbs evidence collect --task <task-id> --force";
  return "Inspect the reported contract and rerun scwbs check";
}

export function buildDoctorReport(root: string): string {
  const issues = [
    ...collectCheckIssues(root).map((issue) => ({ source: "check", issue })),
    ...collectHealthIssues(root).map((issue) => ({ source: "health", issue }))
  ];

  const lines = ["SC-WBS Doctor", ""];
  if (issues.length === 0) {
    lines.push("No issues found.");
    return `${lines.join("\n")}\n`;
  }

  for (const { source, issue } of issues) {
    const level = issue.severity === "error" ? "High" : "Medium";
    lines.push(`[${level}] ${issue.code} (${source})`);
    lines.push(`Reason: ${issue.message}`);
    lines.push("Suggested fix:");
    lines.push(`  ${suggestedFix(issue)}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function runDoctor(root: string): number {
  try {
    process.stdout.write(buildDoctorReport(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
