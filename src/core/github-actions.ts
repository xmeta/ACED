import { spawnSync } from "node:child_process";
import { readTaskIndex } from "./task-index.js";

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

export type GithubActionsTaskIndex = {
  status: "available";
  entries: Array<{ id: string; branchName: string }>;
} | {
  status: "unavailable";
};

type GithubActionsTaskResolutionSource = "task-index" | "scwbs-regex";

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
    completeness: {
      attributionPercentage: number | null;
      taskIndex: "available" | "unavailable";
    };
    unmatched: { count: number; items: Array<{ headBranch: string; runCount: number }> };
    items: Array<{
      taskId: string;
      headBranches: string[];
      resolutionSource: GithubActionsTaskResolutionSource;
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

export type GithubCapabilityStatus = "ready" | "partial" | "unavailable" | "not-evaluated";

export type GithubCapabilityReport = {
  schemaVersion: "1.0.0";
  status: "ready" | "partial" | "unavailable";
  repository: string | null;
  capabilities: {
    gh: GithubCapabilityStatus;
    auth: GithubCapabilityStatus;
    origin: GithubCapabilityStatus;
    repositoryRead: GithubCapabilityStatus;
    prRead: GithubCapabilityStatus;
    actionsRead: GithubCapabilityStatus;
    mergeReadiness: GithubCapabilityStatus;
  };
  messages: Record<string, string>;
};

type GithubProbeResult = { status: number | null; stdout: string; stderr: string };

function runGithubProbe(command: string, args: string[], cwd: string): GithubProbeResult {
  try {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return {
      status: result.status,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim()
    };
  } catch {
    return { status: null, stdout: "", stderr: "" };
  }
}

function boundedGithubFailure(result: GithubProbeResult, fallback: string): string {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.status === null || /enoent|not found|is not recognized/.test(output)) return "gh CLI is not installed or unavailable in PATH";
  if (/not logged in|authentication|unauthenticated|auth login/.test(output)) return "GitHub authentication is unavailable";
  if (/forbidden|permission|status 403|http 403/.test(output)) return "GitHub capability permission was denied";
  if (/not found|status 404|http 404|does not exist/.test(output)) return "GitHub repository or capability was not found";
  return fallback;
}

function parseJsonObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray(stdout: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function doctorGithubHint(reason: string): string {
  return `${reason}. Run: scwbs doctor --github`;
}

export function probeGithubCapabilities(root: string): GithubCapabilityReport {
  const remote = runGithubProbe("git", ["remote", "get-url", "origin"], root);
  const repository = remote.status === 0 ? githubRepository(remote.stdout) ?? null : null;
  const messages: Record<string, string> = {};
  const capabilities: GithubCapabilityReport["capabilities"] = {
    gh: "unavailable",
    auth: "not-evaluated",
    origin: repository ? "ready" : "unavailable",
    repositoryRead: "not-evaluated",
    prRead: "not-evaluated",
    actionsRead: "not-evaluated",
    mergeReadiness: "not-evaluated"
  };
  messages.origin = repository
    ? "origin resolves to a GitHub repository"
    : remote.status === 0
      ? "origin is not a GitHub repository"
      : "origin could not be resolved";

  const ghVersion = runGithubProbe("gh", ["--version"], root);
  if (ghVersion.status !== 0) {
    messages.gh = boundedGithubFailure(ghVersion, "gh CLI version check failed");
    messages.auth = "not evaluated because gh CLI is unavailable";
    messages.repositoryRead = "not evaluated because gh CLI is unavailable";
    messages.prRead = "not evaluated because gh CLI is unavailable";
    messages.actionsRead = "not evaluated because gh CLI is unavailable";
    messages.mergeReadiness = "not evaluated because gh CLI is unavailable";
    return { schemaVersion: "1.0.0", status: "unavailable", repository, capabilities, messages };
  }
  capabilities.gh = "ready";
  messages.gh = "gh CLI is available";

  const auth = runGithubProbe("gh", ["auth", "status", "--hostname", "github.com"], root);
  if (auth.status !== 0) {
    capabilities.auth = "unavailable";
    messages.auth = boundedGithubFailure(auth, "GitHub authentication status could not be verified");
    for (const key of ["repositoryRead", "prRead", "actionsRead", "mergeReadiness"] as const) {
      messages[key] = "not evaluated because GitHub authentication is unavailable";
    }
    return { schemaVersion: "1.0.0", status: "unavailable", repository, capabilities, messages };
  }
  capabilities.auth = "ready";
  messages.auth = "GitHub authentication is available; credential details are suppressed";
  if (!repository) {
    for (const key of ["repositoryRead", "prRead", "actionsRead", "mergeReadiness"] as const) {
      messages[key] = "not evaluated because origin is not a GitHub repository";
    }
    return { schemaVersion: "1.0.0", status: "unavailable", repository, capabilities, messages };
  }

  const repositoryRead = runGithubProbe("gh", ["api", `repos/${repository}`], root);
  const repositoryPayload = parseJsonObject(repositoryRead.stdout);
  capabilities.repositoryRead = repositoryRead.status === 0 && typeof repositoryPayload?.full_name === "string" ? "ready" : "unavailable";
  messages.repositoryRead = capabilities.repositoryRead === "ready"
    ? "repository metadata is readable"
    : boundedGithubFailure(repositoryRead, "repository metadata could not be read");

  const prRead = runGithubProbe("gh", ["pr", "list", "--repo", repository, "--state", "all", "--limit", "1", "--json", "number"], root);
  capabilities.prRead = prRead.status === 0 && parseJsonArray(prRead.stdout) ? "ready" : "unavailable";
  messages.prRead = capabilities.prRead === "ready"
    ? "pull request metadata is readable"
    : boundedGithubFailure(prRead, "pull request metadata could not be read");

  const actionsRead = runGithubProbe("gh", ["api", `repos/${repository}/actions/runs?per_page=1`], root);
  const actionsPayload = parseJsonObject(actionsRead.stdout);
  capabilities.actionsRead = actionsRead.status === 0 && Array.isArray(actionsPayload?.workflow_runs) ? "ready" : "unavailable";
  messages.actionsRead = capabilities.actionsRead === "ready"
    ? "GitHub Actions history is readable"
    : boundedGithubFailure(actionsRead, "GitHub Actions history could not be read");

  capabilities.mergeReadiness = capabilities.repositoryRead === "ready" && capabilities.prRead === "ready" ? "ready" : "partial";
  messages.mergeReadiness = capabilities.mergeReadiness === "ready"
    ? "PR metadata prerequisites are readable; exact merge preflight still checks the selected PR and aggregate validate"
    : "merge readiness is unavailable until repository and pull request metadata are readable";
  const readyCount = Object.values(capabilities).filter((status) => status === "ready").length;
  const status = readyCount === Object.keys(capabilities).length ? "ready" : readyCount > 0 ? "partial" : "unavailable";
  return { schemaVersion: "1.0.0", status, repository, capabilities, messages };
}

export type GithubActionsHistory = GithubActionsDurationSummary | GithubActionsUnavailable;

function taskIdFromBranch(branch: string): string | undefined {
  return branch.match(/^task\/(SCWBS-(?:DRAFT-)?[A-Z0-9]+(?:-[A-Z0-9]+)*)/)?.[1];
}

function resolveTaskBranch(branch: string, taskIndex: GithubActionsTaskIndex): [string, GithubActionsTaskResolutionSource] | undefined {
  if (taskIndex.status === "available") {
    const indexed = taskIndex.entries.find((entry) => entry.branchName === branch);
    if (indexed) return [indexed.id, "task-index"];
  }
  const fallback = taskIdFromBranch(branch);
  return fallback ? [fallback, "scwbs-regex"] : undefined;
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

export function summarizeGithubActionsRuns(
  repository: string,
  runs: GithubActionsRun[],
  retrievedRunLimit: number,
  taskIndex: GithubActionsTaskIndex = { status: "unavailable" }
): GithubActionsDurationSummary {
  const completed = runs.filter((run) => run.status === "completed" && !Number.isNaN(Date.parse(run.createdAt)) && !Number.isNaN(Date.parse(run.updatedAt)));
  const durations = completed.map((run) => Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)));
  const workflows: GithubActionsDurationSummary["workflows"] = {};
  const events: GithubActionsDurationSummary["events"] = {};
  const branches: GithubActionsDurationSummary["branches"] = {};
  const taskPullRequests = new Map<string, GithubActionsDurationSummary["taskPullRequests"]["items"][number]>();
  const unmatched: Record<string, number> = {};
  let candidateRunCount = 0;
  let attributedRunCount = 0;
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
    if (run.event !== "pull_request" || !run.headBranch.startsWith("task/")) continue;
    candidateRunCount += 1;
    const resolution = resolveTaskBranch(run.headBranch, taskIndex);
    if (!resolution) {
      unmatched[run.headBranch] = (unmatched[run.headBranch] ?? 0) + 1;
      continue;
    }
    attributedRunCount += 1;
    const [taskId, resolutionSource] = resolution;
    const item = taskPullRequests.get(taskId) ?? {
      taskId,
      headBranches: [],
      resolutionSource,
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
  const total = durations.reduce((sum, value) => sum + value, 0);
  const taskItems = [...taskPullRequests.values()]
    .map((item) => ({ ...item, headBranches: item.headBranches.sort() }))
    .sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) || left.taskId.localeCompare(right.taskId));
  const unmatchedItems = Object.entries(unmatched)
    .map(([headBranch, runCount]) => ({ headBranch, runCount }));
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
      completeness: {
        attributionPercentage: candidateRunCount === 0 ? null : Math.round((attributedRunCount / candidateRunCount) * 10000) / 100,
        taskIndex: taskIndex.status
      },
      unmatched: {
        count: unmatchedItems.length,
        items: unmatchedItems.slice(0, 20)
      },
      items: taskItems.slice(0, 20)
    }
  };
}

export function readGithubActionsHistory(root: string, limit = 100): GithubActionsHistory {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" });
  const repository = remote.status === 0 ? githubRepository(remote.stdout) : undefined;
  if (!repository) return { status: "unavailable", source: "github-actions", reason: doctorGithubHint("origin is not a GitHub repository") };
  const result = spawnSync("gh", ["api", `repos/${repository}/actions/runs?per_page=${limit}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    const bounded = boundedGithubFailure({ status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }, "GitHub Actions history could not be retrieved");
    return { status: "unavailable", source: "github-actions", reason: doctorGithubHint(bounded) };
  }
  try {
    const payload = JSON.parse(result.stdout) as { workflow_runs?: unknown[] };
    if (!Array.isArray(payload.workflow_runs)) throw new Error("GitHub Actions response has no workflow_runs array");
    const runs = payload.workflow_runs.map((value) => toRun(value as Record<string, unknown>)).filter((value): value is GithubActionsRun => Boolean(value));
    const taskIndex = readTaskIndex(root);
    const indexResolution: GithubActionsTaskIndex = taskIndex.index && taskIndex.issues.length === 0
      ? { status: "available", entries: taskIndex.index.tasks.map((entry) => ({ id: entry.id, branchName: entry.branchName })) }
      : { status: "unavailable" };
    return summarizeGithubActionsRuns(repository, runs, limit, indexResolution);
  } catch {
    return { status: "unavailable", source: "github-actions", reason: doctorGithubHint("GitHub Actions response could not be parsed") };
  }
}
