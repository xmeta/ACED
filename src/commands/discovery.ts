import {
  readDiscoveryProbe,
  writeDiscoveryProbe,
  type DiscoveryProbe,
  type DiscoveryStatus
} from "../core/discovery.js";

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
