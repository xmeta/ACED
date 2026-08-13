import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listRisks, listSpecs, readEvidence } from "./contracts.js";
import { fileSha256 } from "./hash.js";
import { defaultRisksDir, resolveFrom } from "./paths.js";
import { stringifySimpleYaml } from "./yaml.js";
import type { Evidence, Issue, Profile, RiskAcceptance, RiskLevel, RiskRecord, RiskStatus, RiskTreatmentStrategy, SpecRequirement, SpecContract } from "./types.js";

export const riskSchemaVersion = "scwbs.risk.v1" as const;
export const riskLevels: Readonly<Record<RiskLevel, { minimum: number; maximum: number }>> = {
  low: { minimum: 1, maximum: 4 },
  medium: { minimum: 5, maximum: 9 },
  high: { minimum: 10, maximum: 16 },
  critical: { minimum: 17, maximum: 25 }
};

const MAX_RISKS = 100;
const MAX_ITEMS = 50;

export type RiskAcceptanceStatus = "valid" | "missing" | "stale";

type RiskScopeEntryStatus = "resolved" | "missing" | "invalid" | "ambiguous";

export type RiskScopeConstituent =
  | { kind: "task"; id: string; status: RiskScopeEntryStatus; subjectHeadCommit?: string; diffHash?: string; detail?: string }
  | { kind: "spec"; id: string; status: RiskScopeEntryStatus; version?: string; revision?: string; detail?: string }
  | { kind: "requirement"; id: string; status: RiskScopeEntryStatus; specId?: string; revision?: string; detail?: string };

export type RiskCurrentScope = {
  scopeFingerprint: string;
  complete: boolean;
  issues: string[];
  constituents: RiskScopeConstituent[];
  legacySubject: { subjectHeadCommit?: string; diffHash?: string };
};

export function riskScore(likelihood: number, impact: number): number {
  if (!Number.isInteger(likelihood) || likelihood < 1 || likelihood > 5) throw new Error("Risk likelihood must be an integer from 1 to 5");
  if (!Number.isInteger(impact) || impact < 1 || impact > 5) throw new Error("Risk impact must be an integer from 1 to 5");
  return likelihood * impact;
}

export function riskLevel(score: number): RiskLevel {
  if (!Number.isInteger(score) || score < 1 || score > 25) throw new Error("Risk score must be an integer from 1 to 25");
  if (score <= 4) return "low";
  if (score <= 9) return "medium";
  if (score <= 16) return "high";
  return "critical";
}

function evidenceSubject(evidence: Evidence | undefined): { subjectHeadCommit?: string; diffHash?: string } {
  return {
    subjectHeadCommit: evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit,
    diffHash: evidence?.diffHash ?? evidence?.git?.diffHash
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function requirementRevision(spec: SpecContract, requirement: SpecRequirement, specRevision: string): string {
  return fingerprint({
    specId: spec.id,
    specVersion: spec.version,
    specRevision,
    requirementId: requirement.id,
    content: {
      acceptanceScenarios: requirement.acceptanceScenarios,
      source: requirement.source,
      statement: requirement.statement,
      verificationMode: requirement.verificationMode
    }
  });
}

function resolveSpecs(root: string, ids: string[], constituents: RiskScopeConstituent[], issues: string[]): Map<string, { spec: SpecContract; path: string; revision: string }> {
  const result = new Map<string, { spec: SpecContract; path: string; revision: string }>();
  const entries = listSpecs(root);
  for (const id of uniqueSorted(ids).slice(0, MAX_ITEMS)) {
    const matches = entries.filter((entry) => entry.spec?.id === id);
    if (matches.length !== 1 || !matches[0]?.spec) {
      const status: RiskScopeEntryStatus = matches.length === 0 ? "missing" : matches.some((entry) => entry.issues.length > 0) ? "invalid" : "ambiguous";
      const detail = matches.length === 0 ? `Spec ${id} is missing` : matches.length > 1 ? `Spec ${id} is ambiguous` : `Spec ${id} is invalid`;
      constituents.push({ kind: "spec", id, status, detail });
      issues.push(detail);
      continue;
    }
    const entry = matches[0];
    const spec = entry.spec;
    if (!spec) {
      const detail = `Spec ${id} is invalid`;
      constituents.push({ kind: "spec", id, status: "invalid", detail });
      issues.push(detail);
      continue;
    }
    const revision = fileSha256(root, entry.path);
    result.set(id, { spec, path: entry.path, revision });
    constituents.push({ kind: "spec", id, status: "resolved", version: spec.version, revision });
  }
  return result;
}

export function riskCurrentScope(root: string, risk: RiskRecord): RiskCurrentScope {
  const constituents: RiskScopeConstituent[] = [];
  const issues: string[] = [];
  const tasks = uniqueSorted(risk.scope.tasks).slice(0, MAX_ITEMS);
  const specs = uniqueSorted(risk.scope.specs).slice(0, MAX_ITEMS);
  const requirements = uniqueSorted(risk.scope.requirements).slice(0, MAX_ITEMS);

  for (const taskId of tasks) {
    const result = readEvidence(root, taskId);
    if (!result.evidence) {
      const status: RiskScopeEntryStatus = result.issues.some((issue) => issue.code.endsWith(".missing")) ? "missing" : "invalid";
      const detail = result.issues.map((issue) => issue.message).join("; ") || `Evidence for Task ${taskId} is unavailable`;
      constituents.push({ kind: "task", id: taskId, status, detail });
      issues.push(detail);
      continue;
    }
    const subject = evidenceSubject(result.evidence);
    if (!subject.subjectHeadCommit || !subject.diffHash) {
      const detail = `Evidence for Task ${taskId} has no subjectHeadCommit and diffHash`;
      constituents.push({ kind: "task", id: taskId, status: "invalid", ...subject, detail });
      issues.push(detail);
      continue;
    }
    constituents.push({ kind: "task", id: taskId, status: "resolved", ...subject });
  }

  const resolvedSpecs = resolveSpecs(root, specs, constituents, issues);
  for (const requirementId of requirements) {
    const matches: Array<{ spec: SpecContract; specId: string; specRevision: string; requirement: SpecRequirement }> = [];
    for (const { spec, revision } of resolvedSpecs.values()) {
      const requirement = spec.requirements?.find((candidate) => candidate.id === requirementId);
      if (requirement) matches.push({ spec, specId: spec.id, specRevision: revision, requirement });
    }
    if (matches.length !== 1) {
      const detail = matches.length === 0 ? `Requirement ${requirementId} is missing from linked Specs` : `Requirement ${requirementId} is ambiguous across linked Specs`;
      constituents.push({ kind: "requirement", id: requirementId, status: matches.length === 0 ? "missing" : "ambiguous", detail });
      issues.push(detail);
      continue;
    }
    const match = matches[0];
    const revision = requirementRevision(match.spec, match.requirement, match.specRevision);
    constituents.push({ kind: "requirement", id: requirementId, status: "resolved", specId: match.specId, revision });
  }

  if (tasks.length + specs.length + requirements.length === 0) issues.push("Risk scope is empty");
  const sortedConstituents = [...constituents].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const scopeFingerprint = fingerprint({
    schemaVersion: "scwbs.risk-scope.v1",
    constituents: sortedConstituents
  });
  const legacySubject = tasks.length === 1
    ? (() => { const task = sortedConstituents.find((entry): entry is Extract<RiskScopeConstituent, { kind: "task" }> => entry.kind === "task"); return { subjectHeadCommit: task?.subjectHeadCommit, diffHash: task?.diffHash }; })()
    : {};
  return { scopeFingerprint, complete: issues.length === 0, issues, constituents: sortedConstituents, legacySubject };
}

export function riskAcceptanceStatus(root: string, risk: RiskRecord): RiskAcceptanceStatus {
  if (!risk.acceptance) return "missing";
  const current = riskCurrentScope(root, risk);
  if (risk.acceptance.scopeFingerprint) return current.complete && risk.acceptance.scopeFingerprint === current.scopeFingerprint ? "valid" : "stale";
  const taskOnly = risk.scope.tasks.length === 1 && risk.scope.specs.length === 0 && risk.scope.requirements.length === 0;
  if (!taskOnly || !current.complete) return "stale";
  return risk.acceptance.subjectHeadCommit === current.legacySubject.subjectHeadCommit && risk.acceptance.diffHash === current.legacySubject.diffHash ? "valid" : "stale";
}

export function riskCurrentSubject(root: string, risk: RiskRecord): { subjectHeadCommit?: string; diffHash?: string } {
  return riskCurrentScope(root, risk).legacySubject;
}

export type RiskSummary = {
  id: string;
  title: string;
  status: RiskStatus;
  score: number;
  level: RiskLevel;
  residualScore: number;
  residualLevel: RiskLevel;
  owner: string;
  treatment: RiskTreatmentStrategy;
  acceptanceStatus: RiskAcceptanceStatus;
  scope: RiskRecord["scope"];
  currentScopeFingerprint: string;
  acceptedScopeFingerprint?: string;
  scopeComplete: boolean;
  scopeConstituents: RiskScopeConstituent[];
  scopeIssues: string[];
};

export function summarizeRisk(root: string, risk: RiskRecord): RiskSummary {
  const current = riskCurrentScope(root, risk);
  return {
    id: risk.id,
    title: risk.title,
    status: risk.status,
    score: risk.assessment.score,
    level: risk.assessment.level,
    residualScore: risk.residualRisk.score,
    residualLevel: risk.residualRisk.level,
    owner: risk.treatment.owner,
    treatment: risk.treatment.strategy,
    acceptanceStatus: riskAcceptanceStatus(root, risk),
    scope: risk.scope,
    currentScopeFingerprint: current.scopeFingerprint,
    ...(risk.acceptance?.scopeFingerprint ? { acceptedScopeFingerprint: risk.acceptance.scopeFingerprint } : {}),
    scopeComplete: current.complete,
    scopeConstituents: current.constituents,
    scopeIssues: current.issues
  };
}

export function collectRiskIssues(root: string, profile: Profile): Issue[] {
  if (profile !== "Strict") return [];
  const issues: Issue[] = [];
  for (const entry of listRisks(root).slice(0, MAX_RISKS)) {
    issues.push(...entry.issues);
    if (!entry.risk || entry.issues.length > 0 || entry.risk.status === "closed") continue;
    const risk = entry.risk;
    const linked = risk.scope.tasks.length + risk.scope.specs.length + risk.scope.requirements.length > 0;
    if (!linked) continue;
    if ((risk.assessment.level === "high" || risk.assessment.level === "critical") && risk.treatment.actions.length === 0) {
      issues.push({
        severity: "error",
        code: "risk.treatment.required",
        message: `${risk.id} is ${risk.assessment.level} and has no treatment action`,
        fixCommand: `npm run scwbs -- risk update ${risk.id} --actions "<treatment action>" --json`
      });
    }
    if ((risk.residualRisk.level === "high" || risk.residualRisk.level === "critical") && riskAcceptanceStatus(root, risk) !== "valid") {
      const status = riskAcceptanceStatus(root, risk);
      issues.push({
        severity: "error",
        code: status === "stale" ? "risk.acceptance.stale" : "risk.acceptance.required",
        message: `${risk.id} residual risk is ${risk.residualRisk.level} and Human acceptance is ${status}`,
        remediation: { kind: "guidance", owner: "human", message: `Review the current Evidence subject and accept ${risk.id} as a human if appropriate.` }
      });
    }
  }
  return issues;
}

function safeRiskPath(id: string): string {
  if (!/^RISK-[A-Z0-9][A-Z0-9._-]*$/.test(id)) throw new Error("Invalid risk id");
  return `${defaultRisksDir}/${id}.yaml`;
}

function list(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(new Set(values.flatMap((item) => item.split(",").map((part) => part.trim()).filter(Boolean)))).slice(0, MAX_ITEMS);
}

export type RiskInput = {
  id: string;
  title: string;
  likelihood: number;
  impact: number;
  owner: string;
  strategy?: RiskTreatmentStrategy;
  actions?: string | string[];
  verification?: string | string[];
  tasks?: string | string[];
  specs?: string | string[];
  requirements?: string | string[];
  status?: RiskStatus;
  now?: string;
};

function buildRisk(input: RiskInput, previous?: RiskRecord): RiskRecord {
  const score = riskScore(input.likelihood, input.impact);
  const priorResidual = previous?.residualRisk;
  const treatment: RiskRecord["treatment"] = {
    strategy: input.strategy ?? previous?.treatment.strategy ?? "mitigate",
    owner: input.owner.trim() || previous?.treatment.owner || "unassigned",
    actions: list(input.actions ?? previous?.treatment.actions),
    verification: list(input.verification ?? previous?.treatment.verification)
  };
  const residualLikelihood = priorResidual?.likelihood ?? input.likelihood;
  const residualImpact = priorResidual?.impact ?? input.impact;
  const residualScore = riskScore(residualLikelihood, residualImpact);
  return {
    schemaVersion: riskSchemaVersion,
    id: input.id,
    type: "risk",
    title: input.title.trim() || previous?.title || input.id,
    status: input.status ?? previous?.status ?? "open",
    scope: {
      tasks: list(input.tasks ?? previous?.scope.tasks),
      specs: list(input.specs ?? previous?.scope.specs),
      requirements: list(input.requirements ?? previous?.scope.requirements)
    },
    assessment: { likelihood: input.likelihood as 1 | 2 | 3 | 4 | 5, impact: input.impact as 1 | 2 | 3 | 4 | 5, score, level: riskLevel(score) },
    treatment,
    residualRisk: {
      likelihood: residualLikelihood as 1 | 2 | 3 | 4 | 5,
      impact: residualImpact as 1 | 2 | 3 | 4 | 5,
      score: residualScore,
      level: riskLevel(residualScore)
    },
    ...(previous?.acceptance ? { acceptance: previous.acceptance } : {}),
    createdAt: previous?.createdAt ?? input.now ?? new Date().toISOString(),
    ...(previous ? { updatedAt: input.now ?? new Date().toISOString() } : {})
  };
}

export function addRisk(root: string, input: RiskInput, dryRun = false): RiskRecord {
  const relativePath = safeRiskPath(input.id);
  const fullPath = resolveFrom(root, relativePath);
  if (existsSync(fullPath)) throw new Error(`${relativePath} already exists; use risk update`);
  const risk = buildRisk(input);
  if (!dryRun) {
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, stringifySimpleYaml(risk as unknown as Record<string, unknown>), "utf8");
  }
  return risk;
}

export function updateRisk(root: string, id: string, input: Omit<RiskInput, "id">, dryRun = false): RiskRecord {
  const relativePath = safeRiskPath(id);
  const entry = listRisks(root).find((candidate) => candidate.path === relativePath);
  if (!entry?.risk) throw new Error(`${relativePath} does not exist or is invalid`);
  const risk = buildRisk({ ...input, id }, entry.risk);
  if (!dryRun) writeFileSync(resolveFrom(root, relativePath), stringifySimpleYaml(risk as unknown as Record<string, unknown>), "utf8");
  return risk;
}

export function acceptRisk(root: string, id: string, actor: string, reason: string, now = new Date().toISOString()): RiskRecord {
  if (actor !== "human") throw new Error("risk.accept.human-only: only a human actor may accept a risk");
  const relativePath = safeRiskPath(id);
  const entry = listRisks(root).find((candidate) => candidate.path === relativePath);
  if (!entry?.risk) throw new Error(`${relativePath} does not exist or is invalid`);
  const risk = entry.risk;
  const current = riskCurrentScope(root, risk);
  if (!current.complete) throw new Error(`risk.accept.scope-incomplete: ${current.issues.join("; ")}`);
  const expected = `CONFIRM TTY RISK ${id} ${current.scopeFingerprint}`;
  if (reason !== expected) throw new Error(`risk.accept.confirmation-required: exact reason required: ${expected}`);
  const acceptance: RiskAcceptance = {
    acceptedBy: "human",
    acceptedAt: now,
    ...(current.legacySubject.subjectHeadCommit ? { subjectHeadCommit: current.legacySubject.subjectHeadCommit } : {}),
    ...(current.legacySubject.diffHash ? { diffHash: current.legacySubject.diffHash } : {}),
    scopeFingerprint: current.scopeFingerprint,
    reason
  };
  const updated: RiskRecord = { ...risk, status: "accepted", acceptance, updatedAt: now };
  writeFileSync(resolveFrom(root, relativePath), stringifySimpleYaml(updated as unknown as Record<string, unknown>), "utf8");
  return updated;
}
