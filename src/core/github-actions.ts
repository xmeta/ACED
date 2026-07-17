import { spawnSync } from "node:child_process";

export type GithubActionsRun = {
  id: number;
  name: string;
  event: string;
  headBranch: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GithubActionsDurationSummary = {
  status: "available";
  source: "github-actions";
  repository: string;
  retrievedRunLimit: number;
  matchingRunCount: number;
  completedRunCount: number;
  incompleteRunCount: number;
  earliestCreatedAt: string | null;
  latestUpdatedAt: string | null;
  durationMilliseconds: { total: number; average: number | null; minimum: number | null; maximum: number | null };
  workflows: Record<string, { runCount: number; completedRunCount: number; durationMilliseconds: number }>;
  events: Record<string, { runCount: number; completedRunCount: number }>;
  branches: Record<string, { runCount: number; completedRunCount: number }>;
  taskPullRequests: {
    limit: 20;
    totalCount: number;
    truncated: boolean;
    items: Array<{
      taskId: string;
      headBranches: string[];
      runCount: number;
      completedRunCount: number;
      successfulRunCount: number;
      failedRunCount: number;
      otherCompletedRunCount: number;
      incompleteRunCount: number;
      durationMilliseconds: number;
      latestUpdatedAt: string;
    }>;
  };
};

export type GithubActionsUnavailable = {
  status: "unavailable";
  source: "github-actions";
  reason: string;
};

export type GithubActionsHistory = GithubActionsDurationSummary | GithubActionsUnavailable;

function taskIdFromBranch(branch: string): string | undefined {
  return branch.match(/^task\/(SCWBS-(?:DRAFT-)?[A-Z0-9]+(?:-[A-Z0-9]+)*)/)?.[1];
}

function githubRepository(remote: string): string | undefined {
  const match = remote.trim().match(/(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1];
}

function toRun(value: Record<string, unknown>): GithubActionsRun | undefined {
  if (typeof value.id !== "number" || typeof value.name !== "string" || typeof value.event !== "string" ||
    typeof value.head_branch !== "string" || typeof value.status !== "string" ||
    typeof value.created_at !== "string" || typeof value.updated_at !== "string") return undefined;
  return {
    id: value.id,
    name: value.name,
    event: value.event,
    headBranch: value.head_branch,
    status: value.status,
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
    createdAt: value.created_at,
    updatedAt: value.updated_at
  };
}

export function summarizeGithubActionsRuns(repository: string, runs: GithubActionsRun[], retrievedRunLimit: number): GithubActionsDurationSummary {
  const completed = runs.filter((run) => run.status === "completed" && !Number.isNaN(Date.parse(run.createdAt)) && !Number.isNaN(Date.parse(run.updatedAt)));
  const durations = completed.map((run) => Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)));
  const workflows: GithubActionsDurationSummary["workflows"] = {};
  const events: GithubActionsDurationSummary["events"] = {};
  const branches: GithubActionsDurationSummary["branches"] = {};
  const taskPullRequests = new Map<string, GithubActionsDurationSummary["taskPullRequests"]["items"][number]>();
  for (const run of runs) {
    const existing = workflows[run.name] ?? { runCount: 0, completedRunCount: 0, durationMilliseconds: 0 };
    existing.runCount += 1;
    const duration = completed.indexOf(run);
    if (duration >= 0) {
      existing.completedRunCount += 1;
      existing.durationMilliseconds += durations[duration];
    }
    workflows[run.name] = existing;
    const event = events[run.event] ?? { runCount: 0, completedRunCount: 0 };
    event.runCount += 1;
    if (duration >= 0) event.completedRunCount += 1;
    events[run.event] = event;
    const branch = branches[run.headBranch] ?? { runCount: 0, completedRunCount: 0 };
    branch.runCount += 1;
    if (duration >= 0) branch.completedRunCount += 1;
    branches[run.headBranch] = branch;
    const taskId = run.event === "pull_request" ? taskIdFromBranch(run.headBranch) : undefined;
    if (taskId) {
      const item = taskPullRequests.get(taskId) ?? {
        taskId,
        headBranches: [],
        runCount: 0,
        completedRunCount: 0,
        successfulRunCount: 0,
        failedRunCount: 0,
        otherCompletedRunCount: 0,
        incompleteRunCount: 0,
        durationMilliseconds: 0,
        latestUpdatedAt: run.updatedAt
      };
      item.runCount += 1;
      if (!item.headBranches.includes(run.headBranch)) item.headBranches.push(run.headBranch);
      if (duration >= 0) {
        item.completedRunCount += 1;
        item.durationMilliseconds += durations[duration];
        if (run.conclusion === "success") item.successfulRunCount += 1;
        else if (run.conclusion === "failure") item.failedRunCount += 1;
        else item.otherCompletedRunCount += 1;
      } else {
        item.incompleteRunCount += 1;
      }
      if (run.updatedAt > item.latestUpdatedAt) item.latestUpdatedAt = run.updatedAt;
      taskPullRequests.set(taskId, item);
    }
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  const taskItems = [...taskPullRequests.values()]
    .map((item) => ({ ...item, headBranches: item.headBranches.sort() }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) || left.taskId.localeCompare(right.taskId));
  return {
    status: "available",
    source: "github-actions",
    repository,
    retrievedRunLimit,
    matchingRunCount: runs.length,
    completedRunCount: completed.length,
    incompleteRunCount: runs.length - completed.length,
    earliestCreatedAt: runs.map((run) => run.createdAt).sort()[0] ?? null,
    latestUpdatedAt: runs.map((run) => run.updatedAt).sort().at(-1) ?? null,
    durationMilliseconds: {
      total,
      average: durations.length === 0 ? null : Math.round(total / durations.length),
      minimum: durations.length === 0 ? null : Math.min(...durations),
      maximum: durations.length === 0 ? null : Math.max(...durations)
    },
    workflows,
    events,
    branches,
    taskPullRequests: {
      limit: 20,
      totalCount: taskItems.length,
      truncated: taskItems.length > 20,
      items: taskItems.slice(0, 20)
    }
  };
}

export function readGithubActionsHistory(root: string, limit = 100): GithubActionsHistory {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  const repository = remote.status === 0 ? githubRepository(remote.stdout) : undefined;
  if (!repository) return { status: "unavailable", source: "github-actions", reason: "origin is not a GitHub repository" };
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/runs?per_page=${limit}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) return { status: "unavailable", source: "github-actions", reason: (result.stderr || "GitHub Actions history could not be retrieved").trim() };
  try {
    const payload = JSON.parse(result.stdout) as { workflow_runs?: unknown[] };
    if (!Array.isArray(payload.workflow_runs)) throw new Error("GitHub Actions response has no workflow_runs array");
    const runs = payload.workflow_runs.map((value) => toRun(value as Record<string, unknown>)).filter((value): value is GithubActionsRun => Boolean(value));
    return summarizeGithubActionsRuns(repository, runs, limit);
  } catch (error) {
    return { status: "unavailable", source: "github-actions", reason: error instanceof Error ? error.message : String(error) };
  }
}
