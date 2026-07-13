import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readEvidence, readReview, readTask } from "../core/contracts.js";
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

function readExistingReview(root: string, taskId: string): ReviewRecord {
  const { review, issues } = readReview(root, taskId);
  const missingReviewOnly = issues.length === 1 && issues[0]?.code === "review.missing";
  if (!missingReviewOnly && !review) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }
  if (!review) {
    throw new Error(`contracts/reviews/${taskId}.yaml does not exist; request a review first`);
  }
  return review;
}

function reviewSubject(review: ReviewRecord): { headCommit?: string; diffHash?: string; pullRequest?: string } {
  return {
    ...(review.headCommit ? { headCommit: review.headCommit } : {}),
    ...(review.diffHash ? { diffHash: review.diffHash } : {}),
    ...(review.pullRequest ? { pullRequest: review.pullRequest } : {})
  };
}

function parseFindings(findings: string | undefined): string[] | undefined {
  if (!findings) return undefined;
  const split = findings.split(",").map((item) => item.trim()).filter(Boolean);
  return split.length > 0 ? split : [findings.trim()];
}

export function buildReviewApprove(taskId: string, options: { reviewedBy?: string; reviewedAt?: string; findings?: string[]; review?: ReviewRecord }): ReviewRecord {
  const review = options.review;
  return {
    id: `RVW-${taskId}`,
    type: "review",
    taskId,
    status: "approved",
    reviewProfile: review?.reviewProfile ?? "independent-ai-review",
    ...(review ? reviewSubject(review) : {}),
    groundTruth: review?.groundTruth ?? [taskPath(taskId), evidencePath(taskId)],
    ...(review?.requestedReviewers && review.requestedReviewers.length > 0 ? { requestedReviewers: review.requestedReviewers } : {}),
    ...(review?.notes && review.notes.length > 0 ? { notes: review.notes } : {}),
    reviewedBy: options.reviewedBy ?? "human",
    reviewedAt: options.reviewedAt ?? new Date().toISOString(),
    ...(options.findings && options.findings.length > 0 ? { findings: options.findings } : {})
  };
}

export function buildReviewApproveYaml(taskId: string, options: { reviewedBy?: string; reviewedAt?: string; findings?: string[]; review?: ReviewRecord }): string {
  return stringifySimpleYaml(buildReviewApprove(taskId, options) as unknown as Record<string, unknown>);
}

export function buildReviewChangesRequested(taskId: string, options: { reviewedBy?: string; reviewedAt?: string; findings?: string[]; review?: ReviewRecord }): ReviewRecord {
  const review = options.review;
  return {
    id: `RVW-${taskId}`,
    type: "review",
    taskId,
    status: "changes-requested",
    reviewProfile: review?.reviewProfile ?? "independent-ai-review",
    ...(review ? reviewSubject(review) : {}),
    groundTruth: review?.groundTruth ?? [taskPath(taskId), evidencePath(taskId)],
    ...(review?.requestedReviewers && review.requestedReviewers.length > 0 ? { requestedReviewers: review.requestedReviewers } : {}),
    ...(review?.notes && review.notes.length > 0 ? { notes: review.notes } : {}),
    reviewedBy: options.reviewedBy ?? "human",
    reviewedAt: options.reviewedAt ?? new Date().toISOString(),
    ...(options.findings && options.findings.length > 0 ? { findings: options.findings } : {})
  };
}

export function buildReviewChangesRequestedYaml(taskId: string, options: { reviewedBy?: string; reviewedAt?: string; findings?: string[]; review?: ReviewRecord }): string {
  return stringifySimpleYaml(buildReviewChangesRequested(taskId, options) as unknown as Record<string, unknown>);
}

export function buildReviewClose(taskId: string, options: { reviewedBy?: string; reviewedAt?: string; findings?: string[]; review?: ReviewRecord }): ReviewRecord {
  const review = options.review;
  return {
    id: `RVW-${taskId}`,
    type: "review",
    taskId,
    status: "closed",
    reviewProfile: review?.reviewProfile ?? "independent-ai-review",
    ...(review ? reviewSubject(review) : {}),
    groundTruth: review?.groundTruth ?? [taskPath(taskId), evidencePath(taskId)],
    ...(review?.requestedReviewers && review.requestedReviewers.length > 0 ? { requestedReviewers: review.requestedReviewers } : {}),
    ...(review?.notes && review.notes.length > 0 ? { notes: review.notes } : {}),
    reviewedBy: options.reviewedBy ?? "human",
    reviewedAt: options.reviewedAt ?? new Date().toISOString(),
    ...(options.findings && options.findings.length > 0 ? { findings: options.findings } : {})
  };
}

export function buildReviewCloseYaml(taskId: string, options: { reviewedBy?: string; reviewedAt?: string; findings?: string[]; review?: ReviewRecord }): string {
  return stringifySimpleYaml(buildReviewClose(taskId, options) as unknown as Record<string, unknown>);
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

function resolveReviewActor(options: { reviewedBy?: string; actor?: string }): { actor?: string; error?: string } {
  const resolvedActor = options.actor ?? options.reviewedBy ?? process.env.SCWBS_AGENT_MODE;
  if (resolvedActor === "ai") {
    return { error: "AI execution mode cannot approve human gates; request human review instead" };
  }
  if (resolvedActor !== "human") {
    return { error: "review transition requires explicit human confirmation; pass --actor human" };
  }
  return { actor: resolvedActor };
}

export function runReviewApprove(root: string, taskId: string, options: { reviewedBy?: string; findings?: string; force: boolean; actor?: string }): number {
  try {
    const { error: actorError } = resolveReviewActor(options);
    if (actorError) {
      console.error(actorError);
      return 1;
    }
    const relativePath = reviewPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const review = readExistingReview(root, taskId);
    if (review.status === "approved" && !options.force) {
      console.error(`${relativePath} is already approved; rerun with --force to overwrite`);
      return 1;
    }
    if (review.status === "closed" && !options.force) {
      console.error(`${relativePath} is closed; rerun with --force to approve anyway`);
      return 1;
    }

    const yaml = buildReviewApproveYaml(taskId, {
      review,
      reviewedBy: options.reviewedBy,
      findings: parseFindings(options.findings)
    });
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runReviewChangesRequested(root: string, taskId: string, options: { reviewedBy?: string; findings?: string; force: boolean; actor?: string }): number {
  try {
    const { error: actorError } = resolveReviewActor(options);
    if (actorError) {
      console.error(actorError);
      return 1;
    }
    const relativePath = reviewPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const review = readExistingReview(root, taskId);
    if ((review.status === "approved" || review.status === "closed") && !options.force) {
      console.error(`${relativePath} is ${review.status}; rerun with --force to request changes anyway`);
      return 1;
    }

    const yaml = buildReviewChangesRequestedYaml(taskId, {
      review,
      reviewedBy: options.reviewedBy,
      findings: parseFindings(options.findings)
    });
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runReviewClose(root: string, taskId: string, options: { reviewedBy?: string; force: boolean; actor?: string }): number {
  try {
    const { error: actorError } = resolveReviewActor(options);
    if (actorError) {
      console.error(actorError);
      return 1;
    }
    const relativePath = reviewPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const review = readExistingReview(root, taskId);
    if ((review.status === "approved" || review.status === "changes-requested") && !options.force) {
      console.error(`${relativePath} is ${review.status}; rerun with --force to close anyway`);
      return 1;
    }

    const yaml = buildReviewCloseYaml(taskId, {
      review,
      reviewedBy: options.reviewedBy
    });
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
