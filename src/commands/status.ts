import { execFileSync } from "node:child_process";
import { evidenceExists, listTasks, readEvidence } from "../core/contracts.js";
import { discoveryNextLine, discoveryStateFromProbe, listDiscoveryProbes } from "../core/discovery.js";
import { currentBranch, headCommit, isShallowRepository } from "../core/git.js";
import { readTaskIndex } from "../core/task-index.js";
import type { DecisionReadiness, Issue, TaskContract, WbsDocument } from "../core/types.js";
import { findNode, isDoneNode, readWbs } from "../core/wbs.js";
import { collectEvidenceTrustIssues, type EvidenceTrustOptions } from "./health.js";

export type CompletionTrustLevel = "verified" | "degraded" | "unverifiable" | "not-evaluated";

export type CompletionTrustSummary = {
  sourceStatus: "available" | "unavailable";
  source: "task-index";
  reason: string | null;
  total: number;
  verified: number;
  degraded: number;
  unverifiable: number;
  notEvaluated: number;
};

export type StatusJsonOutput = {
  version: "scwbs.status.v1";
  project: string;
  repository: {
    shallow: boolean;
    commitReachability: "evaluated" | "not-evaluated";
  };
  wbsStatus: {
    total: number;
    counts: Record<string, number>;
  };
  completionTrust: CompletionTrustSummary;
  evidenceMissing: string[];
  blockingRelations: Array<{ source: string; target: string }>;
  discovery: {
    total: number;
    counts: Record<DecisionReadiness, number>;
    items: Array<{
      id: string;
      source: "wbs" | "probe";
      decisionReadiness: DecisionReadiness;
      openUnknowns: string[];
      blockingUnknowns: string[];
      nextDecision: string;
    }>;
  };
};

export type StatusOptions = {
  json?: boolean;
  strict?: boolean;
};

function discoverySummary(root: string, wbs: WbsDocument): StatusJsonOutput["discovery"] {
  const items: StatusJsonOutput["discovery"]["items"] = wbs.nodes
    .filter((node) => node.workMode === "discovery" && node.discovery)
    .map((node) => ({
      id: node.id,
      source: "wbs" as const,
      decisionReadiness: node.discovery!.decisionReadiness,
      openUnknowns: node.discovery!.openUnknowns,
      blockingUnknowns: node.discovery!.blockingUnknowns,
      nextDecision: node.discovery!.nextDecision
    }));
  for (const entry of listDiscoveryProbes(root)) {
    if (!entry.probe) continue;
    const state = discoveryStateFromProbe(entry.probe);
    items.push({
      id: entry.probe.id,
      source: "probe",
      decisionReadiness: state.decisionReadiness,
      openUnknowns: state.openUnknowns,
      blockingUnknowns: state.blockingUnknowns,
      nextDecision: state.nextDecision
    });
  }
  const counts: StatusJsonOutput["discovery"]["counts"] = { notReady: 0, conditionallyReady: 0, ready: 0 };
  for (const item of items) counts[item.decisionReadiness] += 1;
  return { total: items.length, counts, items };
}

const completedTaskStatuses = new Set(["completed", "archived"]);

function isUnverifiableTrustIssue(issue: Issue): boolean {
  return issue.code === "health.evidence.check.missing"
    || issue.code === "health.evidence.check.notPassed"
    || (
      issue.code.startsWith("health.evidence.provenance.")
      && !issue.code.startsWith("health.evidence.provenance.notEvaluated")
    )
    || /^health\.evidence\.(commit|subjectHeadCommit|diffHash|changedFiles)\.(missing|unknown|stale|allowedPaths|forbiddenPaths)$/.test(issue.code)
    || /^health\.evidence\.git\.(base|baseCommit)\.(missing|unknown)$/.test(issue.code)
    || /^health\.approval\./.test(issue.code);
}

export function assessTaskCompletionTrust(
  root: string,
  wbs: WbsDocument,
  task: TaskContract,
  checkCommitReachability = !isShallowRepository(root),
  repositoryState?: EvidenceTrustOptions["repositoryState"]
): { level: CompletionTrustLevel; issueCodes: string[] } {
  let evidenceResult: ReturnType<typeof readEvidence>;
  try {
    evidenceResult = readEvidence(root, task.id);
  } catch {
    return { level: "unverifiable", issueCodes: ["evidence.parse"] };
  }
  const { evidence, issues: evidenceIssues } = evidenceResult;
  if (!evidence || evidenceIssues.length > 0) {
    return {
      level: "unverifiable",
      issueCodes: evidenceIssues.map((issue) => issue.code)
    };
  }

  const issues = collectEvidenceTrustIssues(root, wbs, task, evidence, {
    checkCommitReachability,
    completed: true,
    repositoryState
  });
  const issueCodes = [...new Set(issues.map((issue) => issue.code))].sort();
  if (issues.some(isUnverifiableTrustIssue)) return { level: "unverifiable", issueCodes };
  if (issues.some((issue) => issue.code.startsWith("health.evidence.provenance.notEvaluated"))) {
    return { level: "not-evaluated", issueCodes };
  }
  if (issues.length > 0) return { level: "degraded", issueCodes };
  if (!checkCommitReachability) return { level: "not-evaluated", issueCodes };
  return { level: "verified", issueCodes };
}

function evidenceCommitReferences(root: string, tasks: TaskContract[]): string[] {
  const references = new Set<string>();
  for (const task of tasks) {
    try {
      const { evidence } = readEvidence(root, task.id);
      if (!evidence) continue;
      for (const value of [
        evidence.commit,
        evidence.subjectHeadCommit,
        evidence.git?.subjectHeadCommit,
        evidence.git?.headCommit,
        evidence.git?.baseCommit
      ]) {
        if (value && /^[0-9a-f]{7,64}$/i.test(value)) references.add(value);
      }
    } catch {
      // Malformed Evidence is classified as unverifiable by the assessment.
    }
  }
  return [...references];
}

function batchCommitExistence(root: string, references: string[]): (commit: string) => boolean {
  const existence = new Map<string, boolean>();
  if (references.length > 0) {
    try {
      const output = execFileSync(
        "git",
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        { cwd: root, input: `${references.join("\n")}\n`, encoding: "utf8" }
      );
      output.trimEnd().split("\n").forEach((line, index) => {
        existence.set(references[index]!, /^[0-9a-f]+ commit$/.test(line));
      });
    } catch {
      for (const reference of references) existence.set(reference, false);
    }
  }
  return (commit: string): boolean => existence.get(commit) ?? false;
}

function collectCompletionTrust(root: string, wbs: WbsDocument): CompletionTrustSummary {
  const indexResult = readTaskIndex(root);
  const empty = {
    source: "task-index" as const,
    total: 0,
    verified: 0,
    degraded: 0,
    unverifiable: 0,
    notEvaluated: 0
  };
  if (!indexResult.index || indexResult.issues.length > 0) {
    return {
      sourceStatus: "unavailable",
      ...empty,
      reason: indexResult.issues[0]?.code ?? "task.index.unavailable"
    };
  }

  const terminalEntries = indexResult.index.tasks.filter((entry) => completedTaskStatuses.has(entry.status));
  const tasks = new Map(listTasks(root).flatMap((entry) => entry.task ? [[entry.task.id, entry.task] as const] : []));
  const checkCommitReachability = !isShallowRepository(root);
  const terminalTasks = terminalEntries.flatMap((entry) => {
    const task = tasks.get(entry.id);
    return task ? [task] : [];
  });
  const repositoryState: EvidenceTrustOptions["repositoryState"] = {
    currentHead: headCommit(root),
    currentBranchName: currentBranch(root),
    commitExists: checkCommitReachability
      ? batchCommitExistence(root, evidenceCommitReferences(root, terminalTasks))
      : () => false
  };
  const summary: CompletionTrustSummary = {
    sourceStatus: "available",
    ...empty,
    reason: null
  };
  for (const entry of terminalEntries) {
    summary.total += 1;
    const task = tasks.get(entry.id);
    if (!task) {
      summary.unverifiable += 1;
      continue;
    }
    const result = assessTaskCompletionTrust(root, wbs, task, checkCommitReachability, repositoryState);
    if (result.level === "verified") summary.verified += 1;
    else if (result.level === "degraded") summary.degraded += 1;
    else if (result.level === "unverifiable") summary.unverifiable += 1;
    else summary.notEvaluated += 1;
  }
  return summary;
}

export function buildStatusJsonOutput(root: string): StatusJsonOutput {
  const wbs = readWbs(root);
  const counts = new Map<string, number>();
  for (const node of wbs.nodes) {
    const status = node.status ?? "planned";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const evidenceMissing: string[] = [];
  for (const entry of listTasks(root)) {
    if (!entry.task) continue;
    const node = findNode(wbs, entry.task.wbsNodeId);
    if (node && isDoneNode(node) && !evidenceExists(root, entry.task.id)) {
      evidenceMissing.push(entry.task.id);
    }
  }
  evidenceMissing.sort();

  const blockers = (wbs.relations ?? [])
    .filter((relation) => relation.type === "blocks")
    .map((relation) => ({ source: relation.source, target: relation.target }));
  const shallow = isShallowRepository(root);
  const sortedCounts = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));

  return {
    version: "scwbs.status.v1",
    project: wbs.name,
    repository: {
      shallow,
      commitReachability: shallow ? "not-evaluated" : "evaluated"
    },
    wbsStatus: {
      total: wbs.nodes.length,
      counts: sortedCounts
    },
    completionTrust: collectCompletionTrust(root, wbs),
    evidenceMissing,
    blockingRelations: blockers,
    discovery: discoverySummary(root, wbs)
  };
}

function buildStatusText(report: StatusJsonOutput): string {
  const trust = report.completionTrust;
  const lines = [
    `Project: ${report.project}`,
    "",
    "Status:",
    ...Object.entries(report.wbsStatus.counts).map(([status, count]) => `- ${status}: ${count}`),
    "",
    "Completion Trust (terminal Tasks):",
    ...(trust.sourceStatus === "available"
      ? [
          `- verified: ${trust.verified}`,
          `- degraded: ${trust.degraded}`,
          `- unverifiable: ${trust.unverifiable}`,
          `- not-evaluated: ${trust.notEvaluated}`
        ]
      : [`- unavailable: ${trust.reason}`]),
    "",
    "Evidence Missing:",
    ...(report.evidenceMissing.length === 0 ? ["- None"] : report.evidenceMissing.map((item) => `- ${item}`)),
    "",
    "Blocking Relations:",
    ...(report.blockingRelations.length === 0
      ? ["- None"]
      : report.blockingRelations.map((relation) => `- ${relation.source} blocks ${relation.target}`)),
    "",
    "Discovery Readiness:",
    ...(report.discovery.total === 0
      ? ["- None"]
      : [
          `- notReady: ${report.discovery.counts.notReady}`,
          `- conditionallyReady: ${report.discovery.counts.conditionallyReady}`,
          `- ready: ${report.discovery.counts.ready}`,
          ...report.discovery.items.map((item) => discoveryNextLine(item.id, item))
        ])
  ];
  return `${lines.join("\n")}\n`;
}

export function buildStatus(root: string): string {
  return buildStatusText(buildStatusJsonOutput(root));
}

export function runStatus(root: string, options: StatusOptions = {}): number {
  try {
    const report = buildStatusJsonOutput(root);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(buildStatusText(report));
    if (!options.strict) return 0;
    const trust = report.completionTrust;
    return trust.sourceStatus !== "available"
      || trust.degraded > 0
      || trust.unverifiable > 0
      || trust.notEvaluated > 0
      ? 1
      : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
