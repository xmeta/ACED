import {
  readDiscoveryProbe,
  writeDiscoveryProbe,
  type DiscoveryProbe,
  type DiscoveryStatus
} from "../core/discovery.js";
import { buildDiscoveryFromGithubIssue, buildGithubIssueIntake } from "../core/github-issue.js";

export type DiscoveryOutput = {
  version: "scwbs.discovery.v1";
  status: "created" | "active" | "concluded" | "inconclusive";
  probeId: string;
  path: string;
  nextAction: string;
};

function items(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "goal";
}

function emit(output: DiscoveryOutput, json = false): void {
  if (json) console.log(JSON.stringify(output));
  else console.log([
    `${output.status.toUpperCase()} Discovery Probe ${output.probeId}`,
    `path: ${output.path}`,
    `next: ${output.nextAction}`
  ].join("\n"));
}

export function runDiscoveryNew(root: string, options: {
  probe: string;
  question: string;
  hypotheses?: string;
  activities?: string;
  evidenceExpected?: string;
  unknowns?: string;
  timebox: string;
  costLimit: string;
  exitConditions?: string;
  nextDecision: string;
  deliveryTask?: string;
  json?: boolean;
}): number {
  try {
    const probe: DiscoveryProbe = {
      schemaVersion: "1.0.0",
      id: options.probe,
      type: "discovery-probe",
      status: "proposed",
      question: options.question,
      hypotheses: items(options.hypotheses),
      activities: items(options.activities),
      evidenceExpected: items(options.evidenceExpected),
      unknowns: items(options.unknowns),
      timebox: options.timebox,
      costLimit: options.costLimit,
      exitConditions: items(options.exitConditions),
      nextDecision: options.nextDecision,
      ...(options.deliveryTask ? { deliveryTaskId: options.deliveryTask } : {}),
      createdAt: new Date().toISOString()
    };
    const path = writeDiscoveryProbe(root, probe);
    emit({
      version: "scwbs.discovery.v1",
      status: "created",
      probeId: probe.id,
      path,
      nextAction: `npm run scwbs -- discovery start --probe ${probe.id}`
    }, options.json);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runProjectBootstrap(root: string, goal: string, json = false): number {
  const stamp = Date.now().toString(36).toUpperCase();
  return runDiscoveryNew(root, {
    probe: `PROBE-bootstrap-${slug(goal)}-${stamp}`,
    question: goal,
    hypotheses: "Existing repository capabilities can support the goal",
    activities: "Inspect current contracts and record bounded evidence",
    evidenceExpected: "Current-state inventory",
    unknowns: "Delivery scope and acceptance criteria",
    timebox: "1h",
    costLimit: "one engineer-hour",
    exitConditions: "Decision-driving evidence recorded",
    nextDecision: "Approve a delivery Spec before creating a Task Contract",
    json
  });
}

export function runDiscoveryGoalStart(root: string, goal: string, options: {
  timebox?: string;
  costLimit?: string;
  nextDecision?: string;
  json?: boolean;
} = {}): number {
  try {
    const stamp = Date.now().toString(36).toUpperCase();
    const now = new Date().toISOString();
    const probe: DiscoveryProbe = {
      schemaVersion: "1.0.0",
      id: `PROBE-${slug(goal)}-${stamp}`,
      type: "discovery-probe",
      status: "active",
      question: goal,
      hypotheses: ["The current repository can provide a bounded path to the goal"],
      activities: ["Inspect current contracts and record decision-driving evidence"],
      evidenceExpected: ["Current-state inventory"],
      unknowns: ["Delivery scope and acceptance criteria"],
      timebox: options.timebox ?? "1h",
      costLimit: options.costLimit ?? "one engineer-hour",
      exitConditions: ["Decision-driving evidence recorded"],
      nextDecision: options.nextDecision ?? "Approve a delivery Spec before creating a Task Contract",
      createdAt: now,
      startedAt: now
    };
    const path = writeDiscoveryProbe(root, probe);
    emit({
      version: "scwbs.discovery.v1",
      status: "active",
      probeId: probe.id,
      path,
      nextAction: `npm run scwbs -- discovery conclude --probe ${probe.id} --outcome concluded|inconclusive`
    }, options.json ?? false);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runDiscoveryStart(root: string, id: string, json = false): number {
  try {
    const result = readDiscoveryProbe(root, id);
    if (!result.probe) throw new Error(result.issues.map((item) => item.message).join("\n"));
    if (result.probe.status !== "proposed") {
      throw new Error(`${id} cannot transition from ${result.probe.status} to active`);
    }
    const probe: DiscoveryProbe = { ...result.probe, status: "active", startedAt: new Date().toISOString() };
    const path = writeDiscoveryProbe(root, probe, true);
    emit({
      version: "scwbs.discovery.v1",
      status: "active",
      probeId: id,
      path,
      nextAction: `npm run scwbs -- discovery conclude --probe ${id} --outcome concluded|inconclusive`
    }, json);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runDiscoveryConclude(root: string, id: string, options: {
  outcome: Exclude<DiscoveryStatus, "proposed" | "active">;
  facts?: string;
  rejected?: string;
  remaining?: string;
  exitConditionsMet?: boolean;
  nextDecision?: string;
  json?: boolean;
}): number {
  try {
    const result = readDiscoveryProbe(root, id);
    if (!result.probe) throw new Error(result.issues.map((item) => item.message).join("\n"));
    if (result.probe.status !== "active") {
      throw new Error(`${id} cannot transition from ${result.probe.status} to ${options.outcome}`);
    }
    if (options.outcome === "concluded" && options.exitConditionsMet !== true) {
      throw new Error("concluded requires --exit-conditions-met true");
    }
    const remainingUnknowns = items(options.remaining);
    if (options.outcome === "inconclusive" && remainingUnknowns.length === 0) {
      throw new Error("inconclusive requires --remaining <items>");
    }
    const probe: DiscoveryProbe = {
      ...result.probe,
      status: options.outcome,
      concludedAt: new Date().toISOString(),
      exitConditionsMet: options.outcome === "concluded",
      factsLearned: items(options.facts),
      hypothesesRejected: items(options.rejected),
      remainingUnknowns,
      ...(options.nextDecision ? { nextDecision: options.nextDecision } : {})
    };
    const path = writeDiscoveryProbe(root, probe, true);
    const nextAction = options.outcome === "concluded"
      ? (probe.deliveryTaskId ? `Review delivery Task ${probe.deliveryTaskId}` : probe.nextDecision)
      : `Create a follow-up Probe before: ${probe.nextDecision}`;
    emit({
      version: "scwbs.discovery.v1",
      status: options.outcome,
      probeId: id,
      path,
      nextAction
    }, options.json);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runDiscoveryFromGithubIssue(root: string, issueNumber: string, options: { repository?: string; expectedDigest?: string; dryRun?: boolean; json?: boolean }): number {
  try {
    if (options.dryRun !== true) throw new Error("discovery.from-github-issue.dry-run-required: use --dry-run");
    const result = buildDiscoveryFromGithubIssue(buildGithubIssueIntake(root, Number(issueNumber), options));
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else process.stdout.write(`Discovery candidate: ${String(result.status)}\n`);
    return result.status === "candidate" || result.status === "stale" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
