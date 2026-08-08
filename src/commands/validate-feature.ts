import { listSpecs, listTasks, readEvidence } from "../core/contracts.js";
import { commitExists, isCommitAncestor } from "../core/git.js";
import { readTaskIndex } from "../core/task-index.js";
import type { Evidence, RequirementEvidence, RequirementVerificationMode, SpecContract, SpecRequirement, TaskContract } from "../core/types.js";

export type FeatureValidationStatus = "GO" | "NO-GO" | "MANUAL_VERIFY_REQUIRED";

export type FeatureValidationOptions = {
  baseRef?: string;
  json?: boolean;
};

type RequirementResult = {
  requirementId: string;
  statement: string;
  verificationMode: RequirementVerificationMode;
  taskIds: string[];
  evidenceStatus: "covered" | "not-covered" | "missing" | "stale" | "manual-required";
  issues: string[];
};

type FeatureValidationReport = {
  version: "scwbs.feature-validation.v1";
  status: FeatureValidationStatus;
  spec: { id: string; version: string; requirementsVersion?: string };
  requirements: RequirementResult[];
  unknownRequirementDeclarations: Array<{ taskId: string; requirementIds: string[] }>;
  warnings: string[];
  summary: {
    total: number;
    covered: number;
    notCovered: number;
    manualVerifyRequired: number;
  };
};

function legacyRequirements(spec: SpecContract): { requirements: SpecRequirement[]; warnings: string[] } {
  if (spec.requirements && spec.requirements.length > 0) return { requirements: spec.requirements, warnings: [] };
  return {
    requirements: spec.acceptanceCriteria.map((statement, index) => ({
      id: `LEGACY-${String(index + 1).padStart(3, "0")}`,
      statement,
      acceptanceScenarios: [statement],
      verificationMode: "manual",
      source: "legacy:acceptanceCriteria"
    })),
    warnings: [
      `${spec.id} uses legacy acceptanceCriteria; add requirementsVersion: 1.0.0 and stable requirement IDs before feature validation can produce GO`
    ]
  };
}

function taskStatusById(root: string): Map<string, string> {
  const result = readTaskIndex(root);
  return new Map(result.index?.tasks.map((entry) => [entry.id, entry.status]) ?? []);
}

function currentEvidenceStatus(
  root: string,
  evidence: Evidence | undefined,
  coverage: RequirementEvidence | undefined,
  verificationMode: RequirementVerificationMode,
  baseRef: string
): { status: RequirementResult["evidenceStatus"]; issues: string[] } {
  if (!evidence || !coverage) return { status: "missing", issues: ["Requirement Evidence is missing"] };
  if (
    coverage.subjectHeadCommit !== evidence.subjectHeadCommit
    || coverage.diffHash !== evidence.diffHash
    || !coverage.subjectHeadCommit
    || !coverage.diffHash
  ) {
    return { status: "stale", issues: ["Requirement Evidence provenance does not match Evidence subjectHeadCommit/diffHash"] };
  }
  if (!commitExists(root, coverage.subjectHeadCommit)) {
    return { status: "stale", issues: ["Requirement Evidence subject HEAD does not exist"] };
  }
  if (!isCommitAncestor(root, coverage.subjectHeadCommit, baseRef)) {
    return { status: "stale", issues: [`Requirement Evidence subject HEAD is not merged into ${baseRef}`] };
  }
  if (coverage.status === "not-covered") {
    return { status: "not-covered", issues: ["Evidence explicitly marks the requirement as not-covered"] };
  }
  const humanReference = coverage.references.some((reference) => /^(human|manual):/i.test(reference));
  if (verificationMode === "manual" || verificationMode === "hybrid") {
    if (coverage.status !== "covered" || !humanReference) {
      return { status: "manual-required", issues: ["Manual or hybrid Requirement requires explicit human evidence"] };
    }
    return { status: "covered", issues: [] };
  }
  const checks = new Set(evidence.checks.filter((check) => check.status === "passed").map((check) => check.name));
  if (coverage.status !== "covered" || !coverage.checkNames?.length || !coverage.checkNames.every((check) => checks.has(check))) {
    return { status: "not-covered", issues: ["Automated Requirement needs covered status and current passed check references"] };
  }
  return { status: "covered", issues: [] };
}

function renderReport(report: FeatureValidationReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Feature validation: ${report.status}\n`);
  report.requirements.forEach((requirement) => {
    process.stdout.write(`- ${requirement.requirementId}: ${requirement.evidenceStatus}${requirement.issues.length > 0 ? ` (${requirement.issues.join("; ")})` : ""}\n`);
  });
  report.warnings.forEach((warning) => process.stdout.write(`WARN ${warning}\n`));
}

export function runValidateFeature(root: string, specId: string, options: FeatureValidationOptions = {}): number {
  const specEntry = listSpecs(root).find((entry) => entry.spec?.id === specId);
  if (!specEntry?.spec) {
    const report: FeatureValidationReport = {
      version: "scwbs.feature-validation.v1",
      status: "NO-GO",
      spec: { id: specId, version: "unknown" },
      requirements: [],
      unknownRequirementDeclarations: [],
      warnings: [`Spec ${specId} was not found`],
      summary: { total: 0, covered: 0, notCovered: 0, manualVerifyRequired: 0 }
    };
    renderReport(report, options.json ?? false);
    return 1;
  }

  const spec = specEntry.spec;
  const normalized = legacyRequirements(spec);
  const tasks = listTasks(root).flatMap((entry) => entry.task ? [entry.task] : []);
  const statuses = taskStatusById(root);
  const baseRef = options.baseRef ?? "origin/main";
  const knownRequirementIds = new Set(normalized.requirements.map((requirement) => requirement.id));
  const unknownRequirementDeclarations = tasks.flatMap((task) => {
    const requirementIds = (task.requirementIds ?? []).filter((id) => !knownRequirementIds.has(id));
    return requirementIds.length > 0 ? [{ taskId: task.id, requirementIds }] : [];
  });
  const requirements = normalized.requirements.map((requirement): RequirementResult => {
    const owners = tasks.filter((task) => task.requirementIds?.includes(requirement.id));
    const taskIds = owners.map((task) => task.id);
    const issues: string[] = [];
    if (owners.length === 0) issues.push("No Task declares ownership of this Requirement");
    if (owners.length > 1) issues.push(`Duplicate ownership by ${taskIds.join(", ")}`);
    if (owners.length === 1) {
      const task = owners[0] as TaskContract;
      const taskStatus = statuses.get(task.id) ?? "planned";
      if (!["completed", "archived"].includes(taskStatus)) issues.push(`Task ${task.id} is ${taskStatus}, not completed or archived`);
      const { evidence } = readEvidence(root, task.id);
      const coverage = evidence?.requirementEvidence?.find((entry) => entry.requirementId === requirement.id);
      const evidenceResult = currentEvidenceStatus(root, evidence, coverage, requirement.verificationMode, baseRef);
      issues.push(...evidenceResult.issues);
      return {
        requirementId: requirement.id,
        statement: requirement.statement,
        verificationMode: requirement.verificationMode,
        taskIds,
        evidenceStatus: issues.length > 0 ? evidenceResult.status : "covered",
        issues
      };
    }
    return {
      requirementId: requirement.id,
      statement: requirement.statement,
      verificationMode: requirement.verificationMode,
      taskIds,
      evidenceStatus: "not-covered",
      issues
    };
  });

  const manualVerifyRequired = requirements.filter((requirement) => requirement.evidenceStatus === "manual-required").length;
  const notCovered = requirements.filter((requirement) => requirement.evidenceStatus !== "covered" && requirement.evidenceStatus !== "manual-required").length;
  const status: FeatureValidationStatus = notCovered > 0
    ? "NO-GO"
    : manualVerifyRequired > 0
      ? "MANUAL_VERIFY_REQUIRED"
      : "GO";
  const report: FeatureValidationReport = {
    version: "scwbs.feature-validation.v1",
    status,
    spec: {
      id: spec.id,
      version: spec.version,
      ...(spec.requirementsVersion ? { requirementsVersion: spec.requirementsVersion } : {})
    },
    requirements,
    unknownRequirementDeclarations,
    warnings: normalized.warnings,
    summary: {
      total: requirements.length,
      covered: requirements.length - notCovered - manualVerifyRequired,
      notCovered,
      manualVerifyRequired
    }
  };
  if (unknownRequirementDeclarations.length > 0) {
    report.warnings.push(...unknownRequirementDeclarations.map((entry) =>
      `Task ${entry.taskId} declares unknown Requirement IDs: ${entry.requirementIds.join(", ")}`
    ));
  }
  if (unknownRequirementDeclarations.length > 0 && report.status === "GO") report.status = "NO-GO";
  renderReport(report, options.json ?? false);
  return report.status === "GO" ? 0 : report.status === "MANUAL_VERIFY_REQUIRED" ? 2 : 1;
}
