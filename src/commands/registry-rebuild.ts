import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { collectArtifactIdentityIssues, listApprovals, listBlocks, listEvidence, listReviews, listRisks, listSpecChanges, listSpecs, listTasks } from "../core/contracts.js";
import { defaultRegistryPath, defaultWbsPath, evidencePath, resolveFrom } from "../core/paths.js";
import { parseSimpleYaml, stringifySimpleYaml } from "../core/yaml.js";
import { readWbs } from "../core/wbs.js";
import { isActiveTaskStatus, readTaskIndex } from "../core/task-index.js";
import { createConsoleReporter, type Reporter } from "../core/report.js";
import type { Evidence } from "../core/types.js";

export type RegistryRebuildOptions = {
  check: boolean;
  force: boolean;
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
  output?: string;
  reporter?: Reporter;
};

export type RegistryRebuildSummary = {
  schemaVersion: "1.0.0";
  status: "rebuilt" | "synchronized" | "out-of-sync";
  added: number;
  updated: number;
  removed: number;
  path: typeof defaultRegistryPath;
};

function registryEntries(yaml: string): Map<string, string> {
  try {
    const parsed = parseSimpleYaml(yaml) as { contracts?: Array<Record<string, unknown>> };
    const entries = Array.isArray(parsed.contracts) ? parsed.contracts : [];
    return new Map(entries.map((entry) => [`${String(entry.type ?? "")}:${String(entry.id ?? entry.path ?? "")}`, JSON.stringify(entry)]));
  } catch {
    return new Map();
  }
}

export function buildRegistryRebuildSummary(current: string, next: string, status: RegistryRebuildSummary["status"]): RegistryRebuildSummary {
  const before = registryEntries(current);
  const after = registryEntries(next);
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const [key, value] of after) {
    if (!before.has(key)) added += 1;
    else if (before.get(key) !== value) updated += 1;
  }
  for (const key of before.keys()) if (!after.has(key)) removed += 1;
  return { schemaVersion: "1.0.0", status, added, updated, removed, path: defaultRegistryPath };
}

function printSummary(summary: RegistryRebuildSummary, reporter: Reporter): void {
  reporter.log("PASS registry rebuilt");
  reporter.log(`added: ${summary.added}`);
  reporter.log(`updated: ${summary.updated}`);
  reporter.log(`removed: ${summary.removed}`);
  reporter.log(`path: ${summary.path}`);
}

function printSuccess(summary: RegistryRebuildSummary, yaml: string, options: RegistryRebuildOptions, reporter: Reporter): void {
  if (options.quiet) return;
  if (options.json) {
    reporter.log(JSON.stringify(summary));
    return;
  }
  if (options.output === "-") {
    reporter.write(yaml);
    return;
  }
  printSummary(summary, reporter);
  if (options.verbose) reporter.write(yaml);
}

export function buildRegistryYaml(root: string, options: { evidence?: Evidence } = {}): string {
  const identityIssues = collectArtifactIdentityIssues(root);
  if (identityIssues.length > 0) {
    throw new Error(identityIssues.map((item) => `${item.code}: ${item.message}`).join("; "));
  }
  const projectId = existsSync(resolveFrom(root, defaultWbsPath)) ? readWbs(root).id : "scwbs";
  const contracts: Record<string, unknown>[] = [];
  const taskIndex = readTaskIndex(root);
  const taskLifecycle = taskIndex.index && taskIndex.issues.length === 0
    ? new Map(taskIndex.index.tasks.map((entry) => [entry.id, entry]))
    : new Map();
  for (const { spec, path } of listSpecs(root)) {
    if (!spec) continue;
    contracts.push({ id: spec.id, type: "spec", path, status: spec.status, version: spec.version, featureId: spec.featureId });
  }
  for (const { specChange, path } of listSpecChanges(root)) {
    if (!specChange) continue;
    contracts.push({ id: specChange.id, type: "spec-change", path, status: specChange.status, version: specChange.proposedVersion, relatedTask: specChange.taskId });
  }
  for (const { task, path } of listTasks(root)) {
    if (!task) continue;
    const lifecycle = taskLifecycle.get(task.id);
    const status = lifecycle?.status ?? "planned";
    contracts.push({
      id: `TASK-${task.id}`,
      type: "task",
      path,
      status,
      active: isActiveTaskStatus(status),
      ...(lifecycle?.archivedAt ? { archivedAt: lifecycle.archivedAt } : {}),
      featureId: task.featureId
    });
  }
  let candidateEvidenceIncluded = false;
  for (const { evidence: storedEvidence, path } of listEvidence(root)) {
    const evidence = options.evidence?.taskId === storedEvidence?.taskId ? options.evidence : storedEvidence;
    if (!evidence) continue;
    if (evidence === options.evidence) candidateEvidenceIncluded = true;
    contracts.push({ id: evidence.id, type: "evidence", path, relatedTask: evidence.taskId });
  }
  if (options.evidence && !candidateEvidenceIncluded) {
    contracts.push({
      id: options.evidence.id,
      type: "evidence",
      path: evidencePath(options.evidence.taskId),
      relatedTask: options.evidence.taskId
    });
  }
  for (const { approval, path } of listApprovals(root)) {
    if (!approval) continue;
    contracts.push({ id: approval.id, type: "approval", path, status: approval.status, relatedTask: approval.taskId });
  }
  for (const { block, path } of listBlocks(root)) {
    if (!block) continue;
    contracts.push({ id: block.id, type: "block", path, status: block.status, relatedTask: block.taskId });
  }
  for (const { risk, path } of listRisks(root)) {
    if (!risk) continue;
    contracts.push({ id: risk.id, type: "risk", path, status: risk.status });
  }
  for (const { review, path } of listReviews(root)) {
    if (!review) continue;
    contracts.push({ id: review.id, type: "review", path, status: review.status, relatedTask: review.taskId });
  }
  contracts.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return stringifySimpleYaml({ projectId, contracts });
}

export function syncRegistry(root: string): RegistryRebuildSummary {
  const next = buildRegistryYaml(root);
  const fullPath = resolveFrom(root, defaultRegistryPath);
  const current = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
  const summary = buildRegistryRebuildSummary(current, next, current === next ? "synchronized" : "rebuilt");
  if (current !== next) {
    writeFileSync(fullPath, next, "utf8");
  }
  return summary;
}

export function runRegistryRebuild(root: string, options: RegistryRebuildOptions): number {
  const reporter = options.reporter ?? createConsoleReporter();
  try {
    const outputModes = [options.quiet, options.json, options.verbose, options.output !== undefined].filter(Boolean).length;
    if (outputModes > 1 || (options.output !== undefined && options.output !== "-")) {
      reporter.error("Choose one of --quiet, --json, --verbose, or --output -");
      return 2;
    }
    const next = buildRegistryYaml(root);
    const fullPath = resolveFrom(root, defaultRegistryPath);
    const current = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
    if (options.check) {
      if (current === next) {
        if (options.output === "-") reporter.write(next);
        else if (options.json) reporter.log(JSON.stringify(buildRegistryRebuildSummary(current, next, "synchronized")));
        else if (!options.quiet) {
          reporter.log("PASS registry rebuild --check");
          if (options.verbose) reporter.write(next);
        }
        return 0;
      }
      if (options.json) reporter.log(JSON.stringify(buildRegistryRebuildSummary(current, next, "out-of-sync")));
      else reporter.error(`${defaultRegistryPath} is out of sync; run scwbs registry rebuild --force`);
      return 1;
    }
    if (existsSync(fullPath) && !options.force && current !== next) {
      reporter.error(`${defaultRegistryPath} differs; rerun with --force to overwrite`);
      return 1;
    }
    writeFileSync(fullPath, next, "utf8");
    printSuccess(buildRegistryRebuildSummary(current, next, "rebuilt"), next, options, reporter);
    return 0;
  } catch (error) {
    reporter.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
