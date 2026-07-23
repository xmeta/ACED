import { spawnSync } from "node:child_process";

export const historicalPullRequestLimit = 100;
export const historicalPullRequestTrendLimit = 20;

export type GithubPullRequest = {
  number: number;
  headBranch: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
};

export type HistoricalPullRequests = {
  status: "available";
  source: "github-pull-requests";
  repository: string;
  retrievedPullRequestLimit: 100;
  matchingPullRequestCount: number;
  mergedPullRequestCount: number;
  unmergedPullRequestCount: number;
  taskTrend: {
    limit: 20;
    totalCount: number;
    truncated: boolean;
    items: Array<{
      taskId: string;
      pullRequestCount: number;
      mergedPullRequestCount: number;
      createdAt: string;
      mergedAt: string | null;
      publishLoopMilliseconds: number | null;
      latestUpdatedAt: string;
    }>;
  };
} | {
  status: "unavailable";
  source: "github-pull-requests";
  reason: string;
};

function taskIdFromBranch(branch: string): string | undefined {
  return branch.match(/^(?:task|codex)\/(SCWBS-(?:DRAFT-)?[A-Z0-9]+(?:-[A-Z0-9]+)*)/)?.[1];
}

function githubRepository(remote: string): string | undefined {
  return remote.trim().match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
}

function toPullRequest(value: unknown): GithubPullRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const head = record.head;
  if (typeof record.number !== "number" || typeof record.created_at !== "string"
    || typeof record.updated_at !== "string" || typeof head !== "object" || head === null
    || Array.isArray(head) || typeof (head as Record<string, unknown>).ref !== "string") return undefined;
  return {
    number: record.number,
    headBranch: (head as Record<string, unknown>).ref as string,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    mergedAt: typeof record.merged_at === "string" ? record.merged_at : null
  };
}

export function summarizeGithubPullRequests(repository: string, pullRequests: GithubPullRequest[]): HistoricalPullRequests {
  const tasks = new Map<string, Extract<HistoricalPullRequests, { status: "available" }>["taskTrend"]["items"][number]>();
  let matchingPullRequestCount = 0;
  let mergedPullRequestCount = 0;
  for (const pullRequest of pullRequests) {
    const taskId = taskIdFromBranch(pullRequest.headBranch);
    if (!taskId) continue;
    matchingPullRequestCount += 1;
    if (pullRequest.mergedAt) mergedPullRequestCount += 1;
    const item = tasks.get(taskId) ?? {
      taskId,
      pullRequestCount: 0,
      mergedPullRequestCount: 0,
      createdAt: pullRequest.createdAt,
      mergedAt: null,
      publishLoopMilliseconds: null,
      latestUpdatedAt: pullRequest.updatedAt
    };
    item.pullRequestCount += 1;
    if (pullRequest.mergedAt) item.mergedPullRequestCount += 1;
    if (pullRequest.createdAt < item.createdAt) item.createdAt = pullRequest.createdAt;
    if (pullRequest.mergedAt && (!item.mergedAt || pullRequest.mergedAt > item.mergedAt)) item.mergedAt = pullRequest.mergedAt;
    if (pullRequest.updatedAt > item.latestUpdatedAt) item.latestUpdatedAt = pullRequest.updatedAt;
    tasks.set(taskId, item);
  }
  const items = [...tasks.values()]
    .map((item) => {
      const started = Date.parse(item.createdAt);
      const ended = item.mergedAt ? Date.parse(item.mergedAt) : Number.NaN;
      return { ...item, publishLoopMilliseconds: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null };
    })
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) || left.taskId.localeCompare(right.taskId));
  return {
    status: "available",
    source: "github-pull-requests",
    repository,
    retrievedPullRequestLimit: historicalPullRequestLimit,
    matchingPullRequestCount,
    mergedPullRequestCount,
    unmergedPullRequestCount: matchingPullRequestCount - mergedPullRequestCount,
    taskTrend: {
      limit: historicalPullRequestTrendLimit,
      totalCount: items.length,
      truncated: items.length > historicalPullRequestTrendLimit,
      items: items.slice(0, historicalPullRequestTrendLimit)
    }
  };
}

export function readHistoricalPullRequests(root: string): HistoricalPullRequests {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  const repository = remote.status === 0 ? githubRepository(remote.stdout) : undefined;
  if (!repository) return { status: "unavailable", source: "github-pull-requests", reason: "origin is not a GitHub repository" };
  const result = spawnSync("gh", ["api", `repos/${repository}/pulls?state=all&per_page=${historicalPullRequestLimit}&sort=updated&direction=desc`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) return { status: "unavailable", source: "github-pull-requests", reason: (result.stderr || "GitHub pull requests could not be retrieved").trim() };
  try {
    const payload: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(payload)) throw new Error("GitHub pull request response is not an array");
    return summarizeGithubPullRequests(repository, payload.map(toPullRequest).filter((value): value is GithubPullRequest => Boolean(value)));
  } catch (error) {
    return { status: "unavailable", source: "github-pull-requests", reason: error instanceof Error ? error.message : String(error) };
  }
}
