import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readTask } from "../core/contracts.js";
import { branchChangedFiles, currentBranch, headCommit, mergeBase, resolveCommit } from "../core/git.js";
import { evidencePath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { Evidence, EvidenceCheckStatus } from "../core/types.js";

const maxCheckOutputSummaryLength = 1000;

function commandForCheck(check: string): string[] {
  if (check === "test") return ["npm", "test"];
  if (check === "typecheck") return ["npm", "run", "typecheck"];
  if (check === "build") return ["npm", "run", "build"];
  return ["npm", "run", check];
}

function summarizeCheckOutput(output: string | null | undefined): string | undefined {
  const normalized = (output ?? "").replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length <= maxCheckOutputSummaryLength) return normalized;
  const marker = "[truncated]\n";
  return `${marker}${normalized.slice(-(maxCheckOutputSummaryLength - marker.length))}`;
}

function runCheck(root: string, check: string): Evidence["checks"][number] {
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

export function buildCollectedEvidence(root: string, taskId: string, options: { baseRef?: string } = {}): Evidence {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const baseRef = options.baseRef ?? "origin/main";
  const head = headCommit(root);
  const baseCommit = mergeBase(root, baseRef) ?? resolveCommit(root, baseRef);
  return {
    id: `EVD-${taskId}`,
    type: "evidence",
    taskId,
    ...(head ? { commit: head } : {}),
    git: {
      ...(currentBranch(root) ? { branch: currentBranch(root) } : {}),
      base: baseRef,
      ...(baseCommit ? { baseCommit } : {}),
      changedFilesBasis: "branch-diff",
      ...(head ? { headCommit: head } : {})
    },
    changedFiles: branchChangedFiles(root, baseRef),
    checks: task.requiredChecks.map((check) => runCheck(root, check))
  };
}

export function buildCollectedEvidenceYaml(root: string, taskId: string, options: { baseRef?: string } = {}): string {
  return stringifySimpleYaml(buildCollectedEvidence(root, taskId, options) as unknown as Record<string, unknown>);
}

export function runEvidenceCollect(root: string, taskId: string, options: { force: boolean; baseRef?: string }): number {
  try {
    const relativePath = evidencePath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const yaml = buildCollectedEvidenceYaml(root, taskId, { baseRef: options.baseRef });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
