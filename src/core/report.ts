import type { Issue } from "./types.js";

export function printIssues(issues: Issue[]): void {
  for (const item of issues) {
    const prefix = item.severity === "error" ? "ERROR" : "WARN";
    console.log(`${prefix} ${item.code}: ${item.message}`);
  }
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((item) => item.severity === "error");
}
