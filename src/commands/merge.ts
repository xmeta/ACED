import { spawnSync } from "node:child_process";
import {
  evaluateMergePreflight,
  unavailableMergeReport,
  type MergePreflightReport,
  type MergePullRequestView
} from "../core/merge-preflight.js";

const VIEW_FIELDS = "number,state,isDraft,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup";

function githubRepository(root: string): string | undefined {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

function emit(report: MergePreflightReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`${report.status === "pass" ? "PASS" : "BLOCKED"} merge preflight PR #${report.pullRequest}`);
  console.log(`repository: ${report.repository ?? "unknown"}`);
  console.log(`base: ${report.base ?? "unknown"}`);
  console.log(`head: ${report.headCommit ?? "unknown"}`);
  console.log(`mergeState: ${report.mergeState ?? "unknown"}`);
  console.log(`validate: ${report.validate.status}`);
  for (const violation of report.violations) console.log(`- ${violation.code}: ${violation.message}`);
  if (report.execution.executed) console.log(`merged: PR #${report.pullRequest}`);
}

function readPullRequest(root: string, repository: string, pullRequest: number): {
  view?: MergePullRequestView;
  report?: MergePreflightReport;
} {
  const result = spawnSync(
    "gh",
    ["pr", "view", String(pullRequest), "--repo", repository, "--json", VIEW_FIELDS],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) {
    return {
      report: unavailableMergeReport(
        pullRequest,
        (result.stderr || "gh pr view failed").trim(),
        repository
      )
    };
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("expected an object");
    }
    return { view: value as MergePullRequestView };
  } catch (error) {
    return {
      report: unavailableMergeReport(
        pullRequest,
        `gh pr view returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        repository
      )
    };
  }
}

export function runMerge(root: string, pullRequest: number, options: {
  preflightOnly?: boolean;
  json?: boolean;
} = {}): number {
  const repository = githubRepository(root);
  if (!repository) {
    const report = unavailableMergeReport(pullRequest, "origin is not a GitHub repository");
    report.execution.requested = options.preflightOnly !== true;
    emit(report, options.json ?? false);
    return 1;
  }
  const lookup = readPullRequest(root, repository, pullRequest);
  const report = lookup.report ?? evaluateMergePreflight(pullRequest, lookup.view!, repository);
  report.execution.requested = options.preflightOnly !== true;
  if (report.status === "blocked") {
    emit(report, options.json ?? false);
    return 1;
  }
  if (options.preflightOnly) {
    emit(report, options.json ?? false);
    return 0;
  }

  const command = [
    "gh", "pr", "merge", String(pullRequest), "--squash", "--delete-branch",
    "--match-head-commit", report.headCommit!, "--repo", repository
  ];
  report.execution.command = command.join(" ");
  const mergeResult = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: "utf8" });
  if (mergeResult.status !== 0) {
    report.status = "blocked";
    report.violations.push({
      code: "merge.command.failed",
      message: (mergeResult.stderr || "gh pr merge failed").trim()
    });
    emit(report, options.json ?? false);
    return 1;
  }
  report.execution.executed = true;
  emit(report, options.json ?? false);
  return 0;
}
