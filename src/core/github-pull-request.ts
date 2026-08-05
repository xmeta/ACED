import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export type CurrentPullRequest = {
  number: number;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  baseRefName?: string;
};

type GithubPullRequestView = {
  number?: unknown;
  state?: unknown;
  isDraft?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
};

export function normalizePullRequestNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(?:#|.*\/pull\/)?([1-9]\d*)\/?$/);
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Read the PR associated with the current branch without mutating repository state.
 * A missing gh executable, unauthenticated checkout, no PR, or malformed response
 * all degrade to undefined so callers can retain their existing local-only behavior.
 */
export function detectCurrentPullRequest(root: string): CurrentPullRequest | undefined {
  try {
    const gitConfig = readFileSync(path.join(root, ".git", "config"), "utf8");
    if (!/\[remote "origin"\]/.test(gitConfig)) return undefined;
    const output = execFileSync(
      "gh",
      ["pr", "view", "--json", "number,state,isDraft,headRefName,baseRefName"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const view = JSON.parse(output) as GithubPullRequestView;
    if (typeof view.number !== "number" || !Number.isInteger(view.number) || view.number < 1) return undefined;
    return {
      number: view.number,
      ...(typeof view.state === "string" ? { state: view.state } : {}),
      ...(typeof view.isDraft === "boolean" ? { isDraft: view.isDraft } : {}),
      ...(typeof view.headRefName === "string" ? { headRefName: view.headRefName } : {}),
      ...(typeof view.baseRefName === "string" ? { baseRefName: view.baseRefName } : {})
    };
  } catch {
    return undefined;
  }
}

export function pullRequestEvidenceCommand(taskId: string, pullRequest: number): string {
  return `npm run scwbs -- evidence collect --task ${taskId} --pull-request ${pullRequest} --force`;
}
