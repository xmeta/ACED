import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlanningWorkItem, SpecContract, TaskContract } from "./types.js";
import { readTask } from "./contracts.js";
import { readDiscoveryProbe, writeDiscoveryProbe, type DiscoveryProbe } from "./discovery.js";
import { resolveFrom, taskPath } from "./paths.js";
import { stringifySimpleYaml } from "./yaml.js";

export type PlanProbeResult = {
  id: string;
  status: "missing" | DiscoveryProbe["status"];
};

export type RollingWavePlan = {
  schemaVersion: "1.0.0";
  id: string;
  type: "rolling-wave-plan";
  specId: string;
  specVersion: string;
  generatedAt: string;
  planningMode: "probe" | "delivery";
  inputs: {
    acceptanceCriteria: string[];
    unresolvedDecisions: string[];
    dependencies: string[];
    gates: string[];
    uncertainty: "low" | "medium" | "high";
    probeResults: PlanProbeResult[];
  };
  approachMap: Array<{ title: string; status: "candidate" }>;
  readyWindow: Array<{ taskId: string; title: string; paths: string[] }>;
  artifacts: {
    tasks: string[];
    probe?: string;
  };
  replan?: {
    reason: string;
    previousHash: string;
    changes: {
      added: string[];
      removed: string[];
      retained: string[];
    };
  };
};

const broadScopes = new Set(["**", "src/**", "tests/**", "docs/**", "contracts/**"]);

function safeSuffix(value: string): string {
  const suffix = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!suffix) throw new Error("Planning work item id must contain a safe character");
  return suffix;
}

function planId(specId: string): string {
  return `PLAN-${safeSuffix(specId.replace(/^SPEC-/, ""))}`;
}

export function rollingWavePlanPath(specId: string): string {
  return `contracts/plans/${planId(specId)}.json`;
}

function hashPlan(plan: RollingWavePlan): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

function taskIdFor(spec: SpecContract, item: PlanningWorkItem): string {
  return `${spec.id.replace(/^SPEC-/, "WBS-")}-${safeSuffix(item.id)}`;
}

function validateReadyWindow(items: PlanningWorkItem[]): void {
  if (items.length < 1 || items.length > 3) {
    throw new Error("planning.readyWindow must contain 1 to 3 work items");
  }
  const ids = new Set<string>();
  for (const item of items) {
    const id = safeSuffix(item.id);
    if (ids.has(id)) throw new Error(`Duplicate planning.readyWindow id: ${id}`);
    ids.add(id);
    if (item.paths.length === 0) throw new Error(`${id} requires at least one scoped path`);
    const unsafe = item.paths.filter((candidate) =>
      candidate.startsWith("/")
      || candidate.includes("\\")
      || candidate.split("/").includes("..")
    );
    if (unsafe.length > 0) throw new Error(`${id} uses unsafe scope: ${unsafe.join(", ")}`);
    const broad = item.paths.filter((candidate) => broadScopes.has(candidate));
    if (broad.length > 0) {
      throw new Error(`${id} uses broad scope: ${broad.join(", ")}`);
    }
  }
}

function taskContract(spec: SpecContract, item: PlanningWorkItem): TaskContract {
  const taskId = taskIdFor(spec, item);
  return {
    id: taskId,
    type: "task-contract",
    wbsNodeId: "wbs-less",
    featureId: spec.featureId,
    branchName: `task/${taskId}-${safeSuffix(item.title.toLowerCase()).slice(0, 40)}`,
    allowedPaths: item.paths,
    forbiddenPaths: ["wjs/**"],
    humanGateRequiredPaths: [
      "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"
    ],
    requiredChecks: item.requiredChecks ?? ["test", "typecheck", "build"],
    doneCriteria: item.doneCriteria ?? [item.title],
    evidenceRequired: ["test-result", "typecheck-result", "build-result"],
    ...(spec.planning?.gates?.length ? { stopIf: spec.planning.gates } : {})
  };
}

function probeFor(spec: SpecContract, unresolved: string[]): DiscoveryProbe {
  const id = `PROBE-${safeSuffix(spec.id.replace(/^SPEC-/, ""))}`;
  return {
    schemaVersion: "1.0.0",
    id,
    type: "discovery-probe",
    status: "proposed",
    question: unresolved[0] ?? `Which delivery approach should ${spec.id} use?`,
    hypotheses: [],
    activities: [],
    evidenceExpected: spec.acceptanceCriteria,
    unknowns: unresolved,
    timebox: "Set before starting the Probe",
    costLimit: "Set before starting the Probe",
    exitConditions: unresolved.map((item) => `Resolve: ${item}`),
    nextDecision: `Populate planning.readyWindow for ${spec.id}`,
    createdAt: new Date().toISOString()
  };
}

function writeAtomically(root: string, relativePath: string, content: string, overwrite: boolean): void {
  const fullPath = resolveFrom(root, relativePath);
  if (!overwrite && existsSync(fullPath)) throw new Error(`${relativePath} already exists`);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporary = `${fullPath}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, fullPath);
}

export function buildRollingWavePlan(root: string, spec: SpecContract, replanReason?: string): RollingWavePlan {
  if (spec.status !== "approved") throw new Error(`${spec.id} must be approved before planning`);
  const planning = spec.planning;
  if (!planning) throw new Error(`${spec.id}.planning is required; planning inputs must be explicit`);

  const unresolved = planning.unresolvedDecisions ?? [];
  const dependencies = planning.dependencies ?? [];
  const gates = planning.gates ?? [];
  const uncertainty = planning.uncertainty ?? "medium";
  const probeResults: PlanProbeResult[] = (planning.probeIds ?? []).map((id) => {
    const result = readDiscoveryProbe(root, id);
    return { id, status: result.probe?.status ?? "missing" };
  });
  const uncertaintyClosed = probeResults.length > 0
    && probeResults.every((probe) => probe.status === "concluded");
  const hasOpenProbe = probeResults.some((probe) => probe.status !== "concluded");
  const needsProbe = hasOpenProbe
    || ((unresolved.length > 0 || uncertainty === "high") && !uncertaintyClosed);
  const readyItems = planning.readyWindow ?? [];
  if (!needsProbe) validateReadyWindow(readyItems);

  const relativePath = rollingWavePlanPath(spec.id);
  const fullPath = resolveFrom(root, relativePath);
  const previous = existsSync(fullPath)
    ? JSON.parse(readFileSync(fullPath, "utf8")) as RollingWavePlan
    : undefined;
  if (previous && !replanReason) {
    throw new Error(`${relativePath} already exists; --replan-reason is required`);
  }
  if (!previous && replanReason) throw new Error("--replan-reason requires an existing plan");

  const currentTaskIds = needsProbe ? [] : readyItems.map((item) => taskIdFor(spec, item));
  const previousTaskIds = previous?.readyWindow.map((item) => item.taskId) ?? [];
  const plan: RollingWavePlan = {
    schemaVersion: "1.0.0",
    id: planId(spec.id),
    type: "rolling-wave-plan",
    specId: spec.id,
    specVersion: spec.version,
    generatedAt: new Date().toISOString(),
    planningMode: needsProbe ? "probe" : "delivery",
    inputs: {
      acceptanceCriteria: spec.acceptanceCriteria,
      unresolvedDecisions: unresolved,
      dependencies,
      gates,
      uncertainty,
      probeResults
    },
    approachMap: (planning.approachCandidates ?? []).map((title) => ({ title, status: "candidate" })),
    readyWindow: needsProbe ? [] : readyItems.map((item) => ({
      taskId: taskIdFor(spec, item),
      title: item.title,
      paths: item.paths
    })),
    artifacts: { tasks: currentTaskIds },
    ...(previous && replanReason ? {
      replan: {
        reason: replanReason,
        previousHash: hashPlan(previous),
        changes: {
          added: currentTaskIds.filter((id) => !previousTaskIds.includes(id)),
          removed: previousTaskIds.filter((id) => !currentTaskIds.includes(id)),
          retained: currentTaskIds.filter((id) => previousTaskIds.includes(id))
        }
      }
    } : {})
  };

  if (needsProbe) {
    const existingProbe = probeResults.find((probe) => probe.status !== "missing");
    if (existingProbe) {
      plan.artifacts.probe = `contracts/discovery/${existingProbe.id}.yaml`;
    } else {
      const probe = probeFor(spec, unresolved);
      const probePath = `contracts/discovery/${probe.id}.yaml`;
      if (!existsSync(resolveFrom(root, probePath))) writeDiscoveryProbe(root, probe);
      plan.artifacts.probe = probePath;
    }
  } else {
    const taskCandidates = readyItems.map((item) => ({
      taskId: taskIdFor(spec, item),
      relativePath: taskPath(taskIdFor(spec, item)),
      contract: taskContract(spec, item)
    }));
    for (const candidate of taskCandidates) {
      if (!existsSync(resolveFrom(root, candidate.relativePath))) continue;
      if (!previous || !previousTaskIds.includes(candidate.taskId)) {
        throw new Error(`${candidate.relativePath} already exists outside the previous Ready Window`);
      }
      const existing = readTask(root, candidate.taskId);
      if (!existing.task) throw new Error(existing.issues.map((item) => item.message).join("\n"));
      const fields = ["allowedPaths", "requiredChecks", "doneCriteria"] as const;
      const changed = fields.filter((field) =>
        JSON.stringify(existing.task?.[field]) !== JSON.stringify(candidate.contract[field])
      );
      if (changed.length > 0) {
        throw new Error(
          `${candidate.taskId} authority or criteria changed (${changed.join(", ")}); use a new work item id`
        );
      }
    }
    const newTasks = taskCandidates.filter((item) => !existsSync(resolveFrom(root, item.relativePath)));
    for (const item of newTasks) {
      writeAtomically(
        root,
        item.relativePath,
        stringifySimpleYaml(item.contract as unknown as Record<string, unknown>),
        false
      );
    }
  }

  writeAtomically(root, relativePath, `${JSON.stringify(plan, null, 2)}\n`, Boolean(previous));
  return plan;
}
