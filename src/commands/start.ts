import { readTask } from "../core/contracts.js";
import { currentBranch } from "../core/git.js";
import { checkCoveragePreflightIssues } from "../core/check-coverage.js";

/** Run the pre-flight view for an existing Task Contract only. */
export function runStart(root: string, taskId: string): number {
  try {
    const { task, issues } = readTask(root, taskId);
    if (!task) {
      const detail = issues.map((issue) => issue.message).join("\n");
      throw new Error(
        `Unknown Task ID: ${taskId}. Task pre-flight accepts existing Task Contracts only. `
        + `Create a bounded Discovery Probe with 'scwbs discovery new' or 'scwbs project bootstrap'.`
        + (detail ? `\n${detail}` : "")
      );
    }

    const coverageIssues = checkCoveragePreflightIssues(root, task);
    if (coverageIssues.length > 0) {
      for (const issue of coverageIssues) console.error(`${issue.code}: ${issue.message}${issue.fixCommand ? `\nFix: ${issue.fixCommand}` : ""}`);
      return 1;
    }

    const branch = currentBranch(root) ?? "(unknown)";
    const branchStatus = task.branchName === branch ? "ok" : "mismatch";
    const lines = [
      `Task: ${task.id}`,
      `Branch: ${branch}`,
      `Expected branch: ${task.branchName ?? "(none)"}`,
      `Branch status: ${branchStatus}`,
      `WBS node: ${task.wbsNodeId}`,
      `Contract lock: ${task.contractLock?.wbsScopeRevision ?? task.contractLock?.wbsRevision ?? "(none)"}`,
      `Global contract lock: ${task.contractLock?.wbsGlobalRevision ?? "(legacy or none)"}`,
      "Allowed paths:",
      ...task.allowedPaths.map((item) => `- ${item}`),
      "Forbidden paths:",
      ...task.forbiddenPaths.map((item) => `- ${item}`),
      "Human gate paths:",
      ...task.humanGateRequiredPaths.map((item) => `- ${item}`),
      "Stop if:",
      ...((task.stopIf ?? []).length > 0 ? (task.stopIf ?? []).map((item) => `- ${item}`) : ["- (none)"]),
      "Checks:",
      ...task.requiredChecks.map((item) => `- ${item}`)
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return branchStatus === "ok" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
