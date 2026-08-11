import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";

export const GITHUB_ISSUE_INTAKE_VERSION = "scwbs.github-issue-intake.v1" as const;
export const GITHUB_DISCOVERY_VERSION = "scwbs.discovery-from-github-issue.v1" as const;
const MAX_BODY_LENGTH = 32_000;
const MAX_LABELS = 50;
const MAX_OUTPUT = 256 * 1024;

type RawIssue = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  author?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  url?: unknown;
  state?: unknown;
};

export type GithubIssueSnapshot = {
  repository: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourceUrl: string;
  state: "open" | "closed" | "unknown";
};

export type GithubIssueIntake = {
  version: typeof GITHUB_ISSUE_INTAKE_VERSION;
  status: "available" | "unavailable" | "invalid" | "stale";
  authority: "discovery-only";
  repository: string | null;
  issueNumber: number;
  observedAt: string;
  sourceUrl: string | null;
  digest: string | null;
  snapshot: GithubIssueSnapshot | null;
  reason: string | null;
};

function digest(snapshot: GithubIssueSnapshot): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

function repositoryFromOrigin(root: string): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = remote.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function normalizeSnapshot(repository: string, issueNumber: number, value: RawIssue): GithubIssueSnapshot {
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => typeof label === "object" && label !== null && "name" in label && typeof label.name === "string" ? [label.name.slice(0, 128)] : []).slice(0, MAX_LABELS).sort()
    : [];
  const state = value.state === "OPEN" || value.state === "open" ? "open" : value.state === "CLOSED" || value.state === "closed" ? "closed" : "unknown";
  return {
    repository,
    number: issueNumber,
    title: boundedString(value.title, 512),
    body: boundedString(value.body, MAX_BODY_LENGTH),
    labels,
    author: typeof value.author === "object" && value.author !== null && "login" in value.author && typeof value.author.login === "string" ? value.author.login.slice(0, 128) : null,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    sourceUrl: boundedString(value.url, 1024),
    state
  };
}

export function normalizeGithubIssue(repository: string, issueNumber: number, value: unknown): GithubIssueSnapshot {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("github-issue.number.invalid");
  if (typeof value !== "object" || value === null) throw new Error("github-issue.payload.invalid");
  const snapshot = normalizeSnapshot(repository, issueNumber, value as RawIssue);
  if (snapshot.title.length === 0 || snapshot.sourceUrl.length === 0) throw new Error("github-issue.payload.required");
  return snapshot;
}

export function buildGithubIssueIntake(root: string, issueNumber: number, options: { repository?: string; expectedDigest?: string; run?: (args: string[]) => { status: number | null; stdout: string } } = {}): GithubIssueIntake {
  const observedAt = new Date().toISOString();
  const repository = options.repository ?? repositoryFromOrigin(root);
  const base = { version: GITHUB_ISSUE_INTAKE_VERSION, authority: "discovery-only" as const, repository, issueNumber, observedAt, sourceUrl: null, digest: null, snapshot: null, reason: null };
  if (!repository) return { ...base, status: "unavailable", reason: "github.repository.unavailable" };
  const run = options.run ?? ((args: string[]) => {
    const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", shell: false, maxBuffer: MAX_OUTPUT });
    return { status: result.status, stdout: (result.stdout ?? "").trim() };
  });
  const result = run(["issue", "view", String(issueNumber), "--repo", repository, "--json", "number,title,body,labels,author,createdAt,updatedAt,url,state"]);
  if (result.status !== 0) return { ...base, status: "unavailable", reason: "github.issue.unavailable" };
  try {
    const snapshot = normalizeGithubIssue(repository, issueNumber, JSON.parse(result.stdout));
    const snapshotDigest = digest(snapshot);
    return {
      ...base,
      status: options.expectedDigest && options.expectedDigest !== snapshotDigest ? "stale" : "available",
      sourceUrl: snapshot.sourceUrl,
      digest: snapshotDigest,
      snapshot,
      reason: options.expectedDigest && options.expectedDigest !== snapshotDigest ? "github.issue.stale" : null
    };
  } catch {
    return { ...base, status: "invalid", reason: "github.issue.payload.invalid" };
  }
}

export function buildDiscoveryFromGithubIssue(intake: GithubIssueIntake): Record<string, unknown> {
  if (intake.status !== "available" && intake.status !== "stale") {
    return { version: GITHUB_DISCOVERY_VERSION, status: intake.status, authority: "discovery-only", source: { kind: "github-issue", repository: intake.repository, number: intake.issueNumber, digest: intake.digest, observedAt: intake.observedAt }, reason: intake.reason, createsTaskContract: false };
  }
  return {
    version: GITHUB_DISCOVERY_VERSION,
    status: intake.status === "stale" ? "stale" : "candidate",
    authority: "discovery-only",
    createsTaskContract: false,
    approvesTaskContract: false,
    source: { kind: "github-issue", repository: intake.repository, number: intake.issueNumber, sourceUrl: intake.sourceUrl, digest: intake.digest, observedAt: intake.observedAt, freshness: intake.status === "stale" ? "stale" : "current" },
    untrustedInput: { title: intake.snapshot?.title ?? "", body: intake.snapshot?.body ?? "", labels: intake.snapshot?.labels ?? [], author: intake.snapshot?.author ?? null },
    nextAction: "Review the Discovery candidate and create a Spec/Task through the normal human-gated workflow."
  };
}
