import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveFrom } from "./paths.js";
import type { Issue } from "./types.js";
import { parseSimpleYaml, stringifySimpleYaml } from "./yaml.js";
import { validateDiscoveryProbe } from "./schema/discovery.js";

export type DiscoveryStatus = "proposed" | "active" | "concluded" | "inconclusive";
export type DiscoveryProbe = {
  schemaVersion: "1.0.0";
  id: string;
  type: "discovery-probe";
  status: DiscoveryStatus;
  question: string;
  hypotheses: string[];
  activities: string[];
  evidenceExpected: string[];
  unknowns: string[];
  timebox: string;
  costLimit: string;
  exitConditions: string[];
  nextDecision: string;
  deliveryTaskId?: string;
  createdAt?: string;
  startedAt?: string;
  concludedAt?: string;
  exitConditionsMet?: boolean;
  factsLearned?: string[];
  hypothesesRejected?: string[];
  remainingUnknowns?: string[];
};

export const discoveryDirectory = "contracts/discovery";
const ID = /^PROBE-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function discoveryPath(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid Discovery Probe id; expected PROBE-<safe-id>");
  return `${discoveryDirectory}/${id}.yaml`;
}

export function readDiscoveryProbe(root: string, id: string): { probe?: DiscoveryProbe; issues: Issue[] } {
  const relativePath = discoveryPath(id);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "discovery.missing", message: `${relativePath} does not exist` }] };
  }
  const value = parseSimpleYaml(readFileSync(fullPath, "utf8"));
  const issues = validateDiscoveryProbe(value, relativePath);
  return issues.length > 0 ? { issues } : { probe: value as DiscoveryProbe, issues };
}

export function listDiscoveryProbes(root: string): Array<{ path: string; probe?: DiscoveryProbe; issues: Issue[] }> {
  const directory = resolveFrom(root, discoveryDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".yaml")).sort().map((file) => {
    const relativePath = `${discoveryDirectory}/${file}`;
    const value = parseSimpleYaml(readFileSync(resolveFrom(root, relativePath), "utf8"));
    const issues = validateDiscoveryProbe(value, relativePath);
    return issues.length > 0 ? { path: relativePath, issues } : {
      path: relativePath,
      probe: value as DiscoveryProbe,
      issues
    };
  });
}

export function discoveryIssues(root: string): Issue[] {
  return listDiscoveryProbes(root).flatMap((entry) => [
    ...entry.issues,
    ...(entry.probe?.deliveryTaskId && entry.probe.status !== "concluded"
      ? [{
        severity: "error" as const,
        code: "discovery.delivery.blocked",
        message: `${entry.probe.deliveryTaskId} is blocked by ${entry.probe.id} status ${entry.probe.status}`
      }]
      : [])
  ]);
}

export function probesForTask(root: string, taskId: string): DiscoveryProbe[] {
  return listDiscoveryProbes(root)
    .flatMap((entry) => entry.probe ? [entry.probe] : [])
    .filter((probe) => probe.deliveryTaskId === taskId);
}

export function writeDiscoveryProbe(root: string, probe: DiscoveryProbe, overwrite = false): string {
  const relativePath = discoveryPath(probe.id);
  const fullPath = resolveFrom(root, relativePath);
  if (!overwrite && existsSync(fullPath)) throw new Error(`${relativePath} already exists`);
  const issues = validateDiscoveryProbe(probe, relativePath);
  if (issues.length > 0) throw new Error(issues.map((item) => item.message).join("\n"));
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporary = `${fullPath}.tmp-${process.pid}`;
  writeFileSync(temporary, stringifySimpleYaml(probe as unknown as Record<string, unknown>), "utf8");
  renameSync(temporary, fullPath);
  return relativePath;
}
