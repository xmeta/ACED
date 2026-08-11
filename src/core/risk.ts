import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listRisks, readEvidence } from "./contracts.js";
import { defaultRisksDir, resolveFrom } from "./paths.js";
import { stringifySimpleYaml } from "./yaml.js";
import type { Evidence, Issue, Profile, RiskAcceptance, RiskLevel, RiskRecord, RiskStatus, RiskTreatmentStrategy } from "./types.js";

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

function linkedEvidence(root: string, risk: RiskRecord): Evidence | undefined {
  for (const taskId of risk.scope.tasks.slice(0, MAX_ITEMS)) {
    const result = readEvidence(root, taskId);
    if (result.evidence) return result.evidence;
  }
  return undefined;
}

export function riskAcceptanceStatus(root: string, risk: RiskRecord): RiskAcceptanceStatus {
  if (!risk.acceptance) return "missing";
  const subject = evidenceSubject(linkedEvidence(root, risk));
  if (!subject.subjectHeadCommit || !subject.diffHash) return "stale";
  return risk.acceptance.subjectHeadCommit === subject.subjectHeadCommit && risk.acceptance.diffHash === subject.diffHash ? "valid" : "stale";
}

export function riskCurrentSubject(root: string, risk: RiskRecord): { subjectHeadCommit?: string; diffHash?: string } {
  return evidenceSubject(linkedEvidence(root, risk));
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
};

export function summarizeRisk(root: string, risk: RiskRecord): RiskSummary {
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
    scope: risk.scope
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
  const subject = riskCurrentSubject(root, risk);
  if (!subject.subjectHeadCommit || !subject.diffHash) throw new Error("risk.accept.subject-missing: linked current Evidence subjectHeadCommit and diffHash are required");
  const expected = `CONFIRM TTY RISK ${id} ${subject.subjectHeadCommit} ${subject.diffHash}`;
  if (reason !== expected) throw new Error(`risk.accept.confirmation-required: exact reason required: ${expected}`);
  const acceptance: RiskAcceptance = { acceptedBy: "human", acceptedAt: now, subjectHeadCommit: subject.subjectHeadCommit, diffHash: subject.diffHash, reason };
  const updated: RiskRecord = { ...risk, status: "accepted", acceptance, updatedAt: now };
  writeFileSync(resolveFrom(root, relativePath), stringifySimpleYaml(updated as unknown as Record<string, unknown>), "utf8");
  return updated;
}
