import { existsSync } from "node:fs";
import { readApproval, readEvidence } from "./contracts.js";
import { matchesAny } from "./glob.js";
import { validateHumanGateApproval } from "./human-gate.js";
import { defaultCheckCoveragePath, resolveFrom } from "./paths.js";
import { asCheckCoveragePolicy, validateCheckCoveragePolicy } from "./schema/check-coverage.js";
import type { CheckCoveragePolicy, Issue, TaskContract } from "./types.js";
import { readYamlFile } from "./yaml.js";

export function readCheckCoveragePolicy(root: string): { policy: CheckCoveragePolicy; issues: Issue[] } {
  const fullPath = resolveFrom(root, defaultCheckCoveragePath);
  if (!existsSync(fullPath)) return { policy: { rules: [] }, issues: [] };
  try {
    const value = readYamlFile<unknown>(fullPath);
    const issues = validateCheckCoveragePolicy(value, defaultCheckCoveragePath);
    return { policy: issues.length === 0 ? asCheckCoveragePolicy(value) : { rules: [] }, issues };
  } catch (error) {
    return {
      policy: { rules: [] },
      issues: [{ severity: "error", code: "checkCoverage.parse", message: `${defaultCheckCoveragePath}: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
}

export type CheckCoverageSummary = {
  required: string[];
  missing: string[];
  matchedFiles: Map<string, string[]>;
};

export function checkCoverageSummary(policy: CheckCoveragePolicy, task: TaskContract, files: string[]): CheckCoverageSummary {
  const required = new Set<string>();
  const matchedFiles = new Map<string, string[]>();
  for (const rule of policy.rules) {
    const matches = files.filter((file) => matchesAny(file, rule.paths));
    if (matches.length === 0) continue;
    for (const check of rule.requires) {
      required.add(check);
      matchedFiles.set(check, Array.from(new Set([...(matchedFiles.get(check) ?? []), ...matches])));
    }
  }
  const requiredChecks = [...required].sort();
  return {
    required: requiredChecks,
    missing: requiredChecks.filter((check) => !task.requiredChecks.includes(check)),
    matchedFiles
  };
}

function staticPatternPrefix(pattern: string): string {
  return pattern.replace(/\\/g, "/").split(/[?*[{]/, 1)[0]?.replace(/\/$/, "") ?? "";
}

function patternsMayOverlap(left: string, right: string): boolean {
  const leftPrefix = staticPatternPrefix(left);
  const rightPrefix = staticPatternPrefix(right);
  if (leftPrefix.length === 0 || rightPrefix.length === 0) return true;
  return leftPrefix === rightPrefix || leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`);
}

export function checkCoverageSummaryForAllowedPaths(policy: CheckCoveragePolicy, task: TaskContract): CheckCoverageSummary {
  const representativePaths = policy.rules.flatMap((rule) =>
    rule.paths.filter((policyPath) => task.allowedPaths.some((allowedPath) => patternsMayOverlap(policyPath, allowedPath)))
  );
  return checkCoverageSummary(policy, task, representativePaths);
}

export function collectCheckCoverageIssues(root: string, task: TaskContract, files: string[]): Issue[] {
  const { policy, issues } = readCheckCoveragePolicy(root);
  if (issues.length > 0) return issues;
  const summary = checkCoverageSummary(policy, task, files);
  const waivers = new Map((task.checkCoverageWaivers ?? []).map((waiver) => [waiver.check, waiver]));
  const result: Issue[] = [];
  for (const check of summary.missing) {
    const waiver = waivers.get(check);
    if (!waiver) {
      result.push({
        severity: "error",
        code: "checkCoverage.missing",
        message: `${task.id} changes ${summary.matchedFiles.get(check)?.join(", ")} and requires missing check ${check}`,
        fixCommand: `Add ${check} to requiredChecks in contracts/tasks/${task.id}.yaml`
      });
      continue;
    }
    const waiverFiles = summary.matchedFiles.get(check) ?? [];
    const syntheticGateTask = { ...task, humanGateRequiredPaths: waiverFiles };
    const evidence = readEvidence(root, task.id).evidence;
    const approval = readApproval(root, task.id).approval;
    const evidenceHead = evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit;
    const evidenceDiffHash = evidence?.diffHash ?? evidence?.git?.diffHash;
    const auditableScope = Boolean(evidenceHead && evidenceDiffHash && approval?.headCommit && approval.diffHash);
    const gate = validateHumanGateApproval(
      syntheticGateTask,
      evidence,
      approval,
      waiverFiles,
      root
    );
    if (!auditableScope || !gate.approved) {
      result.push({
        severity: "error",
        code: "checkCoverage.waiver.approval",
        message: `${task.id} waives ${check} (${waiver.reason}) but requires Human Approval scoped to current Evidence`,
        fixCommand: `npm run scwbs -- approval request --task ${task.id}`
      });
    }
  }
  return result;
}
