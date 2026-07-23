import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { profileRequiredDirs, resolveFrom } from "../core/paths.js";
import type { Profile } from "../core/types.js";
import { parseSimpleYaml } from "../core/yaml.js";
import { readProfile } from "./profile.js";
import { readGithubActionsHistory, type GithubActionsHistory } from "../core/github-actions.js";
import { isCheckReceipt, type CheckReceipt } from "../core/check-receipt.js";
import { gitCommonDir } from "../core/required-check-run.js";
import { finishLifecycleDirectory, isFinishLifecycleReceipt, type FinishLifecycleEvent, type FinishLifecycleReceipt } from "../core/finish-lifecycle.js";
import { readHistoricalPullRequests, type HistoricalPullRequests } from "../core/github-pull-requests.js";
import { healthLifecycleDirectory, isHealthLifecycleReceipt, type HealthLifecycleReceipt } from "../core/health-lifecycle.js";
import { listApprovals } from "../core/contracts.js";

const GOVERNANCE_DIRS = [
  "contracts/tasks",
  "contracts/evidence",
  "contracts/approvals",
  "contracts/reviews",
  "contracts/blocks",
  "contracts/specs",
  "contracts/spec-changes",
  "contracts/changesets",
  "contracts/wbs"
] as const;

type Bucket = { files: number; bytes: number; lines: number };
type NullableDuration = { total: number | null; average: number | null; minimum: number | null; maximum: number | null };
type Period = { from: string | null; to: string | null };

export type LocalRequiredChecksSummary = {
  status: "available";
  source: "git-common-dir-check-receipts";
  observation: "latest successful canonical receipt per task; failed and superseded attempts are not retained";
  receiptCount: number;
  invalidReceiptCount: number;
  checkCount: number;
  observedReceiptCount: number;
  partiallyObservedReceiptCount: number;
  unobservedReceiptCount: number;
  observedCheckCount: number;
  unobservedCheckCount: number;
  receiptPeriod: Period;
  observedDurationPeriod: Period;
  durationMilliseconds: NullableDuration;
  taskTrend: {
    limit: 20;
    totalCount: number;
    truncated: boolean;
    items: Array<{
      taskId: string;
      createdAt: string;
      checkCount: number;
      observedCheckCount: number;
      durationMilliseconds: number | null;
    }>;
  };
} | {
  status: "unavailable";
  source: "git-common-dir-check-receipts";
  reason: string;
};

export type LocalLifecycleSummary = {
  status: "available";
  source: "git-common-dir-finish-lifecycle";
  receiptCount: number;
  invalidReceiptCount: number;
  eventCount: number;
  taskTrend: {
    limit: 20;
    totalCount: number;
    truncated: boolean;
    items: Array<{
      taskId: string;
      latestEndedAt: string;
      finishAttemptCount: number;
      preflightAttemptCount: number;
      fullAttemptCount: number;
      successfulCount: number;
      blockedCount: number;
      failedCount: number;
      convergenceMilliseconds: number | null;
      verifiedMetadataAncestryCount: number | null;
      historyTruncated: boolean;
    }>;
  };
} | {
  status: "unavailable";
  source: "git-common-dir-finish-lifecycle";
  reason: string;
};

export type HumanGateSummary = {
  status: "available";
  source: "approval-records";
  recordCount: number;
  invalidRecordCount: number;
  observedRequestCount: number;
  observedCompletedCount: number;
  legacyUnobservedCount: number;
  taskTrend: {
    limit: 20;
    totalCount: number;
    truncated: boolean;
    items: Array<{
      taskId: string;
      status: string;
      requestedAt: string | null;
      approvedAt: string | null;
      waitingMilliseconds: number | null;
    }>;
  };
};

export type HealthLifecycleSummary = {
  status: "available";
  source: "git-common-dir-health-lifecycle";
  receiptCount: number;
  invalidReceiptCount: number;
  eventCount: number;
  taskTrend: {
    limit: 20;
    totalCount: number;
    truncated: boolean;
    items: Array<{
      taskId: string;
      latestObservedAt: string;
      observationCount: number;
      firstWarningCount: number | null;
      latestWarningCount: number | null;
      warningDelta: number | null;
      historyTruncated: boolean;
    }>;
  };
} | {
  status: "unavailable";
  source: "git-common-dir-health-lifecycle";
  reason: string;
};
type FileMeasurement = Bucket & {
  activeFiles: number;
  activeBytes: number;
  activeLines: number;
  archivedFiles: number;
  archivedBytes: number;
  archivedLines: number;
};

export type GovernanceCostSummary = {
  schemaVersion: "1.1.0";
  metric: "governance-cost";
  generatedAt: string;
  profile: Profile;
  definitions: {
    lineCount: string;
    activeArchive: string;
    ratios: string;
    localRequiredChecks: string;
    localLifecycle: string;
    humanGate: string;
    historicalPullRequests: string;
    healthLifecycle: string;
    hardLimitEnforced: false;
  };
  categories: Record<string, FileMeasurement>;
  profiles: Record<Profile, Bucket>;
  totals: {
    governance: FileMeasurement;
    source: Bucket;
    tests: Bucket;
    governanceToSourceLineRatio: number | null;
    governanceToTestLineRatio: number | null;
  };
  historicalCi: GithubActionsHistory;
  localRequiredChecks: LocalRequiredChecksSummary;
  localLifecycle: LocalLifecycleSummary;
  humanGate: HumanGateSummary;
  historicalPullRequests: HistoricalPullRequests;
  healthLifecycle: HealthLifecycleSummary;
  unmeasured: string[];
};

export type MetricsOptions = { json?: boolean };

function emptyMeasurement(): FileMeasurement {
  return {
    files: 0,
    bytes: 0,
    lines: 0,
    activeFiles: 0,
    activeBytes: 0,
    activeLines: 0,
    archivedFiles: 0,
    archivedBytes: 0,
    archivedLines: 0
  };
}

function addBucket(target: Bucket, value: Bucket): void {
  target.files += value.files;
  target.bytes += value.bytes;
  target.lines += value.lines;
}

function addMeasurement(target: FileMeasurement, value: FileMeasurement): void {
  addBucket(target, value);
  target.activeFiles += value.activeFiles;
  target.activeBytes += value.activeBytes;
  target.activeLines += value.activeLines;
  target.archivedFiles += value.archivedFiles;
  target.archivedBytes += value.archivedBytes;
  target.archivedLines += value.archivedLines;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
}

function isArchived(relativePath: string, text: string): boolean {
  if (relativePath.split(path.sep).some((part) => ["archive", "archived"].includes(part.toLowerCase()))) return true;
  if (!relativePath.endsWith(".yaml") && !relativePath.endsWith(".yml")) return false;
  try {
    return parseSimpleYaml(text).status === "archived";
  } catch {
    return false;
  }
}

function filesUnder(root: string, relativeDir: string): string[] {
  const fullDir = resolveFrom(root, relativeDir);
  if (!existsSync(fullDir) || !statSync(fullDir).isDirectory()) return [];
  const result: string[] = [];
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(root, relativePath));
    else if (entry.isFile()) result.push(relativePath);
  }
  return result;
}

function measureFiles(root: string, relativePaths: string[], filter?: (file: string) => boolean): FileMeasurement {
  const result = emptyMeasurement();
  for (const relativePath of relativePaths.filter((file) => !filter || filter(file))) {
    const text = readFileSync(resolveFrom(root, relativePath), "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    const lines = countLines(text);
    const archived = isArchived(relativePath, text);
    result.files += 1;
    result.bytes += bytes;
    result.lines += lines;
    if (archived) {
      result.archivedFiles += 1;
      result.archivedBytes += bytes;
      result.archivedLines += lines;
    } else {
      result.activeFiles += 1;
      result.activeBytes += bytes;
      result.activeLines += lines;
    }
  }
  return result;
}

function asBucket(measurement: FileMeasurement): Bucket {
  return { files: measurement.files, bytes: measurement.bytes, lines: measurement.lines };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function profileBucket(root: string, profile: Profile, categories: Record<string, FileMeasurement>): Bucket {
  const result: Bucket = { files: 0, bytes: 0, lines: 0 };
  for (const directory of profileRequiredDirs(profile)) {
    const category = categories[directory];
    if (category) addBucket(result, asBucket(category));
  }
  return result;
}

function period(values: string[]): Period {
  const valid = values.filter((value) => !Number.isNaN(Date.parse(value))).sort();
  return { from: valid[0] ?? null, to: valid.at(-1) ?? null };
}

function observedDurations(receipt: CheckReceipt): number[] {
  return receipt.checks.flatMap((check) => check.durationMilliseconds === undefined ? [] : [check.durationMilliseconds]);
}

export function buildLocalRequiredChecksSummary(root: string): LocalRequiredChecksSummary {
  let directory: string;
  try {
    directory = path.join(gitCommonDir(root), "scwbs-check-receipts");
  } catch (error) {
    return { status: "unavailable", source: "git-common-dir-check-receipts", reason: error instanceof Error ? error.message.trim() : String(error) };
  }
  const receipts: CheckReceipt[] = [];
  let invalidReceiptCount = 0;
  try {
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const value: unknown = JSON.parse(readFileSync(path.join(directory, entry.name), "utf8"));
          if (isCheckReceipt(value) && entry.name === `${encodeURIComponent(value.taskId)}.json`) receipts.push(value);
          else invalidReceiptCount += 1;
        } catch {
          invalidReceiptCount += 1;
        }
      }
    }
  } catch (error) {
    return { status: "unavailable", source: "git-common-dir-check-receipts", reason: error instanceof Error ? error.message : String(error) };
  }
  const durations = receipts.flatMap(observedDurations);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const receiptObservations = receipts.map((receipt) => ({ receipt, durations: observedDurations(receipt) }));
  const trend = [...receiptObservations].sort((left, right) =>
    right.receipt.createdAt.localeCompare(left.receipt.createdAt) || left.receipt.taskId.localeCompare(right.receipt.taskId)
  );
  return {
    status: "available",
    source: "git-common-dir-check-receipts",
    observation: "latest successful canonical receipt per task; failed and superseded attempts are not retained",
    receiptCount: receipts.length,
    invalidReceiptCount,
    checkCount: receipts.reduce((sum, receipt) => sum + receipt.checks.length, 0),
    observedReceiptCount: receiptObservations.filter(({ receipt, durations: values }) => receipt.checks.length > 0 && values.length === receipt.checks.length).length,
    partiallyObservedReceiptCount: receiptObservations.filter(({ receipt, durations: values }) => values.length > 0 && values.length < receipt.checks.length).length,
    unobservedReceiptCount: receiptObservations.filter(({ durations: values }) => values.length === 0).length,
    observedCheckCount: durations.length,
    unobservedCheckCount: receipts.reduce((sum, receipt) => sum + receipt.checks.length, 0) - durations.length,
    receiptPeriod: period(receipts.map((receipt) => receipt.createdAt)),
    observedDurationPeriod: period(receiptObservations.filter(({ durations: values }) => values.length > 0).map(({ receipt }) => receipt.createdAt)),
    durationMilliseconds: {
      total: durations.length === 0 ? null : total,
      average: durations.length === 0 ? null : Math.round(total / durations.length),
      minimum: durations.length === 0 ? null : Math.min(...durations),
      maximum: durations.length === 0 ? null : Math.max(...durations)
    },
    taskTrend: {
      limit: 20,
      totalCount: trend.length,
      truncated: trend.length > 20,
      items: trend.slice(0, 20).map(({ receipt, durations: values }) => ({
        taskId: receipt.taskId,
        createdAt: receipt.createdAt,
        checkCount: receipt.checks.length,
        observedCheckCount: values.length,
        durationMilliseconds: receipt.checks.length > 0 && values.length === receipt.checks.length
          ? values.reduce((sum, value) => sum + value, 0)
          : null
      }))
    }
  };
}

function lifecycleClassification(event: FinishLifecycleEvent): "successful" | "blocked" | "failed" {
  if (event.exitCode === 0 && (event.outcome === "ready" || event.outcome === "completed")) return "successful";
  if (event.outcome === "readiness-blocked" || event.outcome === "awaiting-human-approval") return "blocked";
  return "failed";
}

function convergenceMilliseconds(receipt: FinishLifecycleReceipt): number | null {
  if (receipt.historyTruncated) return null;
  const fullEvents = receipt.events.filter((event) => event.runMode === "full");
  const first = fullEvents[0];
  const completed = fullEvents.find((event) => event.exitCode === 0 && event.outcome === "completed");
  if (!first || !completed) return null;
  const started = Date.parse(first.startedAt);
  const ended = Date.parse(completed.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
}

export function buildLocalLifecycleSummary(root: string): LocalLifecycleSummary {
  let directory: string;
  try {
    directory = finishLifecycleDirectory(root);
  } catch (error) {
    return { status: "unavailable", source: "git-common-dir-finish-lifecycle", reason: error instanceof Error ? error.message.trim() : String(error) };
  }
  const receipts: FinishLifecycleReceipt[] = [];
  let invalidReceiptCount = 0;
  try {
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const value: unknown = JSON.parse(readFileSync(path.join(directory, entry.name), "utf8"));
          if (isFinishLifecycleReceipt(value) && entry.name === `${encodeURIComponent(value.taskId)}.json`) receipts.push(value);
          else invalidReceiptCount += 1;
        } catch {
          invalidReceiptCount += 1;
        }
      }
    }
  } catch (error) {
    return { status: "unavailable", source: "git-common-dir-finish-lifecycle", reason: error instanceof Error ? error.message : String(error) };
  }
  const trend = receipts
    .map((receipt) => {
      const classifications = receipt.events.map(lifecycleClassification);
      const ancestry = receipt.events.flatMap((event) =>
        event.verifiedMetadataAncestryCount === null ? [] : [event.verifiedMetadataAncestryCount]
      );
      return {
        taskId: receipt.taskId,
        latestEndedAt: receipt.events.at(-1)?.endedAt ?? "",
        finishAttemptCount: receipt.events.length,
        preflightAttemptCount: receipt.events.filter((event) => event.runMode === "preflight").length,
        fullAttemptCount: receipt.events.filter((event) => event.runMode === "full").length,
        successfulCount: classifications.filter((value) => value === "successful").length,
        blockedCount: classifications.filter((value) => value === "blocked").length,
        failedCount: classifications.filter((value) => value === "failed").length,
        convergenceMilliseconds: convergenceMilliseconds(receipt),
        verifiedMetadataAncestryCount: ancestry.length === 0 ? null : Math.max(...ancestry),
        historyTruncated: receipt.historyTruncated
      };
    })
    .sort((left, right) => right.latestEndedAt.localeCompare(left.latestEndedAt) || left.taskId.localeCompare(right.taskId));
  return {
    status: "available",
    source: "git-common-dir-finish-lifecycle",
    receiptCount: receipts.length,
    invalidReceiptCount,
    eventCount: receipts.reduce((sum, receipt) => sum + receipt.events.length, 0),
    taskTrend: {
      limit: 20,
      totalCount: trend.length,
      truncated: trend.length > 20,
      items: trend.slice(0, 20)
    }
  };
}

export function buildHumanGateSummary(root: string): HumanGateSummary {
  const entries = listApprovals(root);
  const approvals = entries.flatMap((entry) => entry.approval ? [entry.approval] : []);
  const items = approvals.map((approval) => {
    const requested = approval.requestedAt ? Date.parse(approval.requestedAt) : Number.NaN;
    const approved = approval.approvedAt ? Date.parse(approval.approvedAt) : Number.NaN;
    return {
      taskId: approval.taskId,
      status: approval.status,
      requestedAt: approval.requestedAt ?? null,
      approvedAt: approval.approvedAt ?? null,
      waitingMilliseconds: Number.isFinite(requested) && Number.isFinite(approved) && approved >= requested ? approved - requested : null
    };
  }).sort((left, right) =>
    (right.requestedAt ?? right.approvedAt ?? "").localeCompare(left.requestedAt ?? left.approvedAt ?? "")
    || left.taskId.localeCompare(right.taskId)
  );
  return {
    status: "available",
    source: "approval-records",
    recordCount: approvals.length,
    invalidRecordCount: entries.length - approvals.length,
    observedRequestCount: approvals.filter((approval) => approval.requestedAt).length,
    observedCompletedCount: items.filter((item) => item.waitingMilliseconds !== null).length,
    legacyUnobservedCount: approvals.filter((approval) => !approval.requestedAt).length,
    taskTrend: { limit: 20, totalCount: items.length, truncated: items.length > 20, items: items.slice(0, 20) }
  };
}

export function buildHealthLifecycleSummary(root: string): HealthLifecycleSummary {
  let directory: string;
  try {
    directory = healthLifecycleDirectory(root);
  } catch (error) {
    return { status: "unavailable", source: "git-common-dir-health-lifecycle", reason: error instanceof Error ? error.message : String(error) };
  }
  const receipts: HealthLifecycleReceipt[] = [];
  let invalidReceiptCount = 0;
  try {
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const value: unknown = JSON.parse(readFileSync(path.join(directory, entry.name), "utf8"));
          if (isHealthLifecycleReceipt(value) && entry.name === `${encodeURIComponent(value.taskId)}.json`) receipts.push(value);
          else invalidReceiptCount += 1;
        } catch {
          invalidReceiptCount += 1;
        }
      }
    }
  } catch (error) {
    return { status: "unavailable", source: "git-common-dir-health-lifecycle", reason: error instanceof Error ? error.message : String(error) };
  }
  const items = receipts.map((receipt) => {
    const first = receipt.events[0];
    const latest = receipt.events.at(-1);
    const comparable = !receipt.historyTruncated && receipt.events.length >= 2 && first && latest;
    return {
      taskId: receipt.taskId,
      latestObservedAt: latest?.observedAt ?? "",
      observationCount: receipt.events.length,
      firstWarningCount: first?.warningCount ?? null,
      latestWarningCount: latest?.warningCount ?? null,
      warningDelta: comparable ? latest.warningCount - first.warningCount : null,
      historyTruncated: receipt.historyTruncated
    };
  }).sort((left, right) => right.latestObservedAt.localeCompare(left.latestObservedAt) || left.taskId.localeCompare(right.taskId));
  return {
    status: "available",
    source: "git-common-dir-health-lifecycle",
    receiptCount: receipts.length,
    invalidReceiptCount,
    eventCount: receipts.reduce((sum, receipt) => sum + receipt.events.length, 0),
    taskTrend: { limit: 20, totalCount: items.length, truncated: items.length > 20, items: items.slice(0, 20) }
  };
}

export function buildGovernanceCostSummary(root: string, now = new Date()): GovernanceCostSummary {
  const categories: Record<string, FileMeasurement> = {};
  for (const directory of GOVERNANCE_DIRS) {
    categories[directory] = measureFiles(root, filesUnder(root, directory));
  }
  categories["contracts/registry.yaml"] = measureFiles(
    root,
    existsSync(resolveFrom(root, "contracts/registry.yaml")) ? ["contracts/registry.yaml"] : []
  );

  const governance = emptyMeasurement();
  for (const category of Object.values(categories)) addMeasurement(governance, category);
  const source = measureFiles(root, filesUnder(root, "src"), (file) => file.endsWith(".ts"));
  const tests = measureFiles(root, filesUnder(root, "tests"), (file) => file.endsWith(".ts"));
  const profiles: Record<Profile, Bucket> = {
    Lean: profileBucket(root, "Lean", categories),
    Standard: profileBucket(root, "Standard", categories),
    Strict: profileBucket(root, "Strict", categories)
  };
  const historicalCi = readGithubActionsHistory(root);
  const localRequiredChecks = buildLocalRequiredChecksSummary(root);
  const localLifecycle = buildLocalLifecycleSummary(root);
  const humanGate = buildHumanGateSummary(root);
  const historicalPullRequests = readHistoricalPullRequests(root);
  const healthLifecycle = buildHealthLifecycleSummary(root);

  return {
    schemaVersion: "1.1.0",
    metric: "governance-cost",
    generatedAt: now.toISOString(),
    profile: readProfile(root),
    definitions: {
      lineCount: "UTF-8 newline count, plus one for a non-empty file without a trailing newline",
      activeArchive: "active is the default; status: archived or an archive/archived directory is separated",
      ratios: "governance lines divided by src TypeScript lines or test TypeScript lines; null means zero denominator",
      localRequiredChecks: "current git-common-dir receipts only; latest successful canonical run per task, with missing legacy durations left unobserved",
      localLifecycle: "bounded Task-local finish events from the current git common directory; missing history is not inferred as zero attempts",
      humanGate: "Approval requestedAt through approvedAt when both timestamps are observed; legacy records remain unobserved",
      historicalPullRequests: "one bounded GitHub pull request list request; unmerged and unavailable durations remain null",
      healthLifecycle: "bounded Task-local health warning summaries from the current git common directory; delta requires comparable first and last events",
      hardLimitEnforced: false
    },
    categories,
    profiles,
    totals: {
      governance,
      source: asBucket(source),
      tests: asBucket(tests),
      governanceToSourceLineRatio: ratio(governance.lines, source.lines),
      governanceToTestLineRatio: ratio(governance.lines, tests.lines)
    },
    historicalCi,
    localRequiredChecks,
    localLifecycle,
    humanGate,
    historicalPullRequests,
    healthLifecycle,
    unmeasured: [
      "warning budgets and hard enforcement"
    ]
  };
}

export function runMetricsGovernance(root: string, options: MetricsOptions = {}): number {
  try {
    const summary = buildGovernanceCostSummary(root);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return 0;
    }
    console.log(`Governance cost (${summary.profile})`);
    console.log(`- governance: ${summary.totals.governance.files} files, ${summary.totals.governance.lines} lines, ${summary.totals.governance.bytes} bytes`);
    console.log(`- source: ${summary.totals.source.files} files, ${summary.totals.source.lines} lines`);
    console.log(`- tests: ${summary.totals.tests.files} files, ${summary.totals.tests.lines} lines`);
    console.log(`- hard limit: not enforced; unmeasured dimensions: ${summary.unmeasured.length}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
