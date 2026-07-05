import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEvidence, readTask } from "../core/contracts.js";
import { matchesAny } from "../core/glob.js";
import { evidencePath, resolveFrom, reviewPath, taskPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Evidence, ReviewRecord, TaskContract } from "../core/types.js";

type RequestedReviewer = NonNullable<ReviewRecord["requestedReviewers"]>[number];

function addReviewer(reviewers: RequestedReviewer[], role: string, reason: string): void {
  if (reviewers.some((reviewer) => reviewer.role === role)) return;
  reviewers.push({ role, user: "unassigned", reason });
}

export function routeReviewers(task: TaskContract, evidence: Evidence | undefined): RequestedReviewer[] {
  const reviewers: RequestedReviewer[] = [];
  const changedFiles = evidence?.changedFiles ?? [];
  if (changedFiles.some((file) => matchesAny(file, ["contracts/**", "docs/scwbs/**", "docs/sc-wbs-development.md"]))) {
    addReviewer(reviewers, "methodology-owner", "SC-WBS contracts or methodology documents changed");
  }
  if (changedFiles.some((file) => matchesAny(file, ["src/**", "tests/**"]))) {
    addReviewer(reviewers, "code-owner", "source or test files changed");
  }
  if (changedFiles.some((file) => matchesAny(file, ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"]))) {
    addReviewer(reviewers, "maintainer", "project configuration or CI files changed");
  }
  if (changedFiles.some((file) => matchesAny(file, task.humanGateRequiredPaths))) {
    addReviewer(reviewers, "human-gate-owner", "Human Gate required path changed");
  }
  if (reviewers.length === 0) {
    addReviewer(reviewers, "maintainer", "no specific routing rule matched");
  }
  return reviewers;
}

export function buildReviewRouteReport(root: string, taskId: string): string {
  const { task, issues: taskIssues } = readTask(root, taskId);
  if (!task) return taskIssues.map((issue) => issue.message).join("\n");
  const { evidence } = readEvidence(root, taskId);
  const reviewers = routeReviewers(task, evidence);
  const lines = [`Review Route ${taskId}`];
  if (!evidence) lines.push("warning: evidence missing; routing used fallback rules only");
  for (const reviewer of reviewers) {
    lines.push(`- ${reviewer.role}: ${reviewer.user ?? "unassigned"} (${reviewer.reason})`);
  }
  return lines.join("\n");
}

function evidenceSubject(evidence: Evidence | undefined): { headCommit?: string; diffHash?: string } {
  const headCommit = evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit;
  const diffHash = evidence?.diffHash ?? evidence?.git?.diffHash;
  return {
    ...(headCommit ? { headCommit } : {}),
    ...(diffHash ? { diffHash } : {})
  };
}

export function buildReviewRequest(taskId: string, options: { pullRequest?: string; requestedReviewers?: RequestedReviewer[]; evidence?: Evidence }): ReviewRecord {
  const subject = evidenceSubject(options.evidence);
  return {
    id: `RVW-${taskId}`,
    type: "review",
    taskId,
    status: "requested",
    reviewProfile: "independent-ai-review",
    ...subject,
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    groundTruth: [
      taskPath(taskId),
      evidencePath(taskId)
    ],
    ...(options.requestedReviewers && options.requestedReviewers.length > 0 ? { requestedReviewers: options.requestedReviewers } : {})
  };
}

export function buildReviewRequestYaml(taskId: string, options: { pullRequest?: string; requestedReviewers?: RequestedReviewer[]; evidence?: Evidence }): string {
  return stringifySimpleYaml(buildReviewRequest(taskId, options) as unknown as Record<string, unknown>);
}

export function runReviewRoute(root: string, taskId: string): number {
  try {
    console.log(buildReviewRouteReport(root, taskId));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runReviewRequest(root: string, taskId: string, options: { pullRequest?: string; force: boolean }): number {
  try {
    const { task, issues } = readTask(root, taskId);
    if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
    const { evidence } = readEvidence(root, taskId);
    const relativePath = reviewPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const yaml = buildReviewRequestYaml(taskId, {
      ...options,
      evidence,
      requestedReviewers: routeReviewers(task, evidence)
    });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
