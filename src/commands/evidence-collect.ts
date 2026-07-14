import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readEvidence, readTask } from "../core/contracts.js";
import { buildCheckCacheKey, buildCheckCacheSubject } from "../core/check-cache.js";
import { resolveCheckCommand } from "../core/check-catalog.js";
import { branchChangedFiles, branchDiffHash, currentBranch, headCommit, mergeBase, resolveCommit } from "../core/git.js";
import { evidencePath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Evidence, EvidenceCheckStatus } from "../core/types.js";
import { collectSubmoduleProvenance } from "../core/submodule-provenance.js";

const maxCheckOutputSummaryLength = 1000;

type TestQualityOptions = NonNullable<Evidence["testQuality"]>;

export type EvidenceCollectSummary = {
  schemaVersion: "1.0.0";
  status: "pass";
  taskId: string;
  path: string;
  checks: {
    total: number;
    passed: number;
    failed: number;
  };
  changedFiles: number;
  pullRequest: string | null;
};

export type EvidenceCollectOptions = {
  force: boolean;
  baseRef?: string;
  pullRequest?: string;
  testQuality?: TestQualityOptions;
  rerunChecks?: boolean;
  json?: boolean;
  verbose?: boolean;
  output?: string;
  quiet?: boolean;
};

function postEvidenceMetadataFiles(taskId: string): string[] {
  return [
    `contracts/evidence/${taskId}.yaml`,
    `contracts/approvals/${taskId}.yaml`,
    `contracts/reviews/${taskId}.yaml`,
    "contracts/registry.yaml"
  ];
}

function commandForCheck(check: string): string[] {
  return resolveCheckCommand(check);
}

function summarizeCheckOutput(output: string | null | undefined): string | undefined {
  const normalized = (output ?? "").replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length <= maxCheckOutputSummaryLength) return normalized;
  const marker = "[truncated]\n";
  return `${marker}${normalized.slice(-(maxCheckOutputSummaryLength - marker.length))}`;
}

function runCheck(root: string, check: string, cacheKey: string): Evidence["checks"][number] {
  const command = commandForCheck(check);
  const result = spawnSync(command[0] ?? "npm", command.slice(1), {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  const status: EvidenceCheckStatus = result.status === 0 ? "passed" : "failed";
  const record: Evidence["checks"][number] = {
    name: check,
    status,
    source: "local",
    command: command.join(" "),
    cacheKey,
    executedAt: new Date().toISOString()
  };
  if (status === "passed") return record;
  const stdoutSummary = summarizeCheckOutput(result.stdout);
  const stderrSummary = summarizeCheckOutput(result.stderr);
  return {
    ...record,
    ...(typeof result.status === "number" ? { exitStatus: result.status } : {}),
    ...(stdoutSummary ? { stdoutSummary } : {}),
    ...(stderrSummary ? { stderrSummary } : {})
  };
}

export function buildCollectedEvidence(root: string, taskId: string, options: { baseRef?: string; pullRequest?: string; testQuality?: TestQualityOptions; rerunChecks?: boolean } = {}): Evidence {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const baseRef = options.baseRef ?? "origin/main";
  const head = headCommit(root);
  const baseCommit = mergeBase(root, baseRef) ?? resolveCommit(root, baseRef);
  const diffHash = branchDiffHash(root, baseRef, postEvidenceMetadataFiles(taskId));
  const { evidence: existingEvidence } = readEvidence(root, taskId);
  const pullRequest = options.pullRequest ?? existingEvidence?.git?.pullRequest;
  const testQuality = options.testQuality ?? existingEvidence?.testQuality;
  const cacheSubject = task.requiredChecks.length > 0
    ? buildCheckCacheSubject(root, { baseRef, excludedMetadataFiles: postEvidenceMetadataFiles(taskId) })
    : undefined;
  const checks = task.requiredChecks.map((check) => {
    const command = commandForCheck(check);
    const cacheKey = buildCheckCacheKey(cacheSubject ?? { fingerprint: "", reusable: false }, check, command);
    const reusable = existingEvidence?.checks.find((candidate) =>
      candidate.name === check
      && candidate.status === "passed"
      && candidate.command === command.join(" ")
      && candidate.cacheKey === cacheKey
    );
    return !options.rerunChecks && cacheSubject?.reusable && reusable ? reusable : runCheck(root, check, cacheKey);
  });
  const submodules = collectSubmoduleProvenance(root, baseRef, task);
  return {
    id: `EVD-${taskId}`,
    type: "evidence",
    taskId,
    ...(head ? { commit: head } : {}),
    ...(head ? { subjectHeadCommit: head } : {}),
    diffHash,
    git: {
      ...(currentBranch(root) ? { branch: currentBranch(root) } : {}),
      base: baseRef,
      ...(baseCommit ? { baseCommit } : {}),
      changedFilesBasis: "branch-diff",
      ...(pullRequest ? { pullRequest } : {}),
      ...(head ? { subjectHeadCommit: head } : {}),
      diffHash,
      ...(head ? { headCommit: head } : {})
    },
    changedFiles: branchChangedFiles(root, baseRef),
    ...(submodules.length > 0 ? { submodules } : {}),
    checks,
    ...(testQuality ? { testQuality } : {})
  };
}

export function buildCollectedEvidenceYaml(root: string, taskId: string, options: { baseRef?: string; pullRequest?: string; testQuality?: TestQualityOptions; rerunChecks?: boolean } = {}): string {
  return stringifySimpleYaml(buildCollectedEvidence(root, taskId, options) as unknown as Record<string, unknown>);
}

export function buildEvidenceCollectSummary(taskId: string, relativePath: string, evidence: Evidence): EvidenceCollectSummary {
  const passed = evidence.checks.filter((check) => check.status === "passed").length;
  const failed = evidence.checks.length - passed;
  return {
    schemaVersion: "1.0.0",
    status: "pass",
    taskId,
    path: relativePath,
    checks: {
      total: evidence.checks.length,
      passed,
      failed
    },
    changedFiles: evidence.changedFiles.length,
    pullRequest: evidence.git?.pullRequest ?? null
  };
}

export function formatEvidenceCollectSummary(summary: EvidenceCollectSummary): string {
  return [
    "PASS evidence collected",
    `path: ${summary.path}`,
    `checks: ${summary.checks.passed} passed, ${summary.checks.failed} failed`,
    `changedFiles: ${summary.changedFiles}`,
    `pullRequest: ${summary.pullRequest ?? "(not recorded)"}`
  ].join("\n") + "\n";
}

export function runEvidenceCollect(root: string, taskId: string, options: EvidenceCollectOptions): number {
  try {
    const outputModes = [options.json, options.verbose, options.output !== undefined].filter(Boolean).length;
    if (outputModes > 1) {
      console.error("Choose one of --json, --verbose, or --output -");
      return 2;
    }
    if (options.output !== undefined && options.output !== "-") {
      console.error("--output target must be -");
      return 2;
    }
    const relativePath = evidencePath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const evidence = buildCollectedEvidence(root, taskId, {
      baseRef: options.baseRef,
      pullRequest: options.pullRequest,
      testQuality: options.testQuality,
      rerunChecks: options.rerunChecks
    });
    const yaml = stringifySimpleYaml(evidence as unknown as Record<string, unknown>);
    writeFileSync(fullPath, yaml, "utf8");
    const summary = buildEvidenceCollectSummary(taskId, relativePath, evidence);
    if (!options.quiet) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else if (options.output === "-") {
        process.stdout.write(yaml);
      } else {
        process.stdout.write(formatEvidenceCollectSummary(summary));
        if (options.verbose) process.stdout.write(yaml);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
