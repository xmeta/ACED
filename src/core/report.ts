import type { Issue } from "./types.js";

export function printIssues(issues: Issue[]): void {
  for (const item of issues) {
    const prefix = item.severity === "error" ? "ERROR" : "WARN";
    console.log(`${prefix} ${item.code}: ${item.message}`);
    if (item.severity === "error" && item.fixCommand) {
      console.log(`  fixCommand: ${item.fixCommand}`);
    }
  }
}

/**
 * M2-022: every Error must show a fixCommand. Call sites are encouraged to
 * set a specific fixCommand, but this backstop guarantees one is always
 * present so a caller never sees an Error with no next action.
 */
export function withDefaultFixCommand(issues: Issue[], defaultFixCommand: string): Issue[] {
  return issues.map((issue) =>
    issue.severity === "error" && !issue.fixCommand
      ? { ...issue, fixCommand: defaultFixCommand }
      : issue
  );
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((item) => item.severity === "error");
}
