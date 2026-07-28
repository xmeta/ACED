import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readApproval, readEvidence } from "./contracts.js";
import { matchesAny } from "./glob.js";
import { validateHumanGateApproval } from "./human-gate.js";
import { defaultCheckCoveragePath, resolveFrom } from "./paths.js";
import { asCheckCoveragePolicy, validateCheckCoveragePolicy } from "./schema/check-coverage.js";
import type { CheckCoveragePolicy, Issue, TaskContract } from "./types.js";
import { readYamlFile } from "./yaml.js";
import { branchDiffHash, changedFilesBetween, headCommit, isCommitAncestor } from "./git.js";
import { taskLifecycleMetadataPaths } from "./managed-contract-paths.js";

function coverageMetadataFiles(taskId: string): string[] {
  return taskLifecycleMetadataPaths(taskId);
}

function evidenceIsCurrent(root: string, task: TaskContract, evidence: NonNullable<ReturnType<typeof readEvidence>["evidence"]>): boolean {
  const evidenceHead = evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit ?? evidence.commit;
  const evidenceDiffHash = evidence.diffHash ?? evidence.git?.diffHash;
  const currentHead = headCommit(root);
  if (!evidenceHead || !evidenceDiffHash || !currentHead) return false;
  try {
    const currentDiffHash = branchDiffHash(root, evidence.git?.base ?? "origin/main", coverageMetadataFiles(task.id));
    if (currentDiffHash !== evidenceDiffHash) return false;
    if (evidenceHead === currentHead) return true;
    return isCommitAncestor(root, evidenceHead, currentHead)
      && changedFilesBetween(root, evidenceHead, currentHead).every((file) => coverageMetadataFiles(task.id).includes(file.replace(/\\/g, "/")));
  } catch {
    return false;
  }
}

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
  unclassifiedFiles: string[];
};

export type CheckCoverageReport = {
  implementationFiles: string[];
  unclassifiedFiles: string[];
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isPolicyImplementationPath(policy: CheckCoveragePolicy, file: string): boolean {
  const normalizedFile = normalizePath(file);
  return normalizedFile.endsWith(".ts") && (policy.implementationRoots ?? []).some((root) => {
    const normalizedRoot = normalizePath(root).replace(/\/$/, "");
    return normalizedFile.startsWith(`${normalizedRoot}/`);
  });
}

function isClassified(policy: CheckCoveragePolicy, file: string): boolean {
  return policy.rules.some((rule) => matchesAny(file, rule.paths));
}

export function checkCoverageReport(policy: CheckCoveragePolicy, files: string[]): CheckCoverageReport {
  const implementationFiles = files
    .map(normalizePath)
    .filter((file) => isPolicyImplementationPath(policy, file))
    .sort();
  return {
    implementationFiles,
    unclassifiedFiles: implementationFiles.filter((file) => !isClassified(policy, file))
  };
}

function implementationFilesUnder(root: string, relativeDirectory: string): string[] {
  const directory = resolveFrom(root, relativeDirectory);
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (currentDirectory: string): void => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(normalizePath(path.relative(root, fullPath)));
      }
    }
  };
  visit(directory);
  return files;
}

function implementationRootIssues(root: string, directories: string[]): { directories: string[]; issues: Issue[] } {
  const validDirectories: string[] = [];
  const issues: Issue[] = [];
  for (const directory of directories) {
    const normalized = normalizePath(directory).replace(/\/$/, "");
    const fullPath = resolveFrom(root, directory);
    const unsafe = path.isAbsolute(directory) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..");
    if (unsafe || !existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
      issues.push({
        severity: "error",
        code: "checkCoverage.implementationRoot",
        message: `${directory} must be an existing repository-relative directory in ${defaultCheckCoveragePath}`,
        fixCommand: `Use an existing repository-relative source directory in ${defaultCheckCoveragePath}.implementationRoots`
      });
      continue;
    }
    validDirectories.push(directory);
  }
  return { directories: validDirectories, issues };
}

export function collectCheckCoveragePolicyIssues(root: string, policy?: CheckCoveragePolicy): Issue[] {
  const activePolicy = policy ?? readCheckCoveragePolicy(root).policy;
  const roots = implementationRootIssues(root, activePolicy.implementationRoots ?? []);
  if (roots.issues.length > 0) return roots.issues;
  const implementationFiles = roots.directories.flatMap((directory) => implementationFilesUnder(root, directory));
  const report = checkCoverageReport(activePolicy, implementationFiles);
  return report.unclassifiedFiles.map((file) => ({
    severity: "error",
    code: "checkCoverage.unclassified",
    message: `${file} is an implementation path not classified by ${defaultCheckCoveragePath}`,
    fixCommand: `Add ${file} to a classified rule in ${defaultCheckCoveragePath}`
  }));
}

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
    matchedFiles,
    unclassifiedFiles: checkCoverageReport(policy, files).unclassifiedFiles
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
  for (const file of summary.unclassifiedFiles) {
    result.push({
      severity: "error",
      code: "checkCoverage.unclassified",
      message: `${task.id} changes implementation path ${file} that is not classified by ${defaultCheckCoveragePath}`,
      fixCommand: `Classify ${file} in ${defaultCheckCoveragePath} before changing it`
    });
  }
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
    const auditableScope = Boolean(evidenceHead && evidenceDiffHash && approval?.headCommit && approval.diffHash)
      && Boolean(evidence && evidenceIsCurrent(root, task, evidence));
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
