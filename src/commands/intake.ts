import { buildGithubIssueIntake } from "../core/github-issue.js";

export function runGithubIssueIntake(root: string, issueNumber: string, options: { repository?: string; expectedDigest?: string; json?: boolean }): number {
  const result = buildGithubIssueIntake(root, Number(issueNumber), options);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`GitHub Issue intake: ${result.status}\nRepository: ${result.repository ?? "unavailable"}\nIssue: ${result.issueNumber}\nDigest: ${result.digest ?? "unavailable"}\n`);
  return result.status === "available" || result.status === "stale" ? 0 : 1;
}
