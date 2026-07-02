import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { listApprovals, listEvidence, listReviews, listSpecChanges, listSpecs, listTasks } from "../core/contracts.js";
import { defaultRegistryPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { readWbs } from "../core/wbs.js";

export function buildRegistryYaml(root: string): string {
  const wbs = readWbs(root);
  const contracts: Record<string, unknown>[] = [];
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
    contracts.push({ id: `TASK-${task.id}`, type: "task", path, featureId: task.featureId });
  }
  for (const { evidence, path } of listEvidence(root)) {
    if (!evidence) continue;
    contracts.push({ id: evidence.id, type: "evidence", path, relatedTask: evidence.taskId });
  }
  for (const { approval, path } of listApprovals(root)) {
    if (!approval) continue;
    contracts.push({ id: approval.id, type: "approval", path, status: approval.status, relatedTask: approval.taskId });
  }
  for (const { review, path } of listReviews(root)) {
    if (!review) continue;
    contracts.push({ id: review.id, type: "review", path, status: review.status, relatedTask: review.taskId });
  }
  contracts.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return stringifySimpleYaml({ projectId: wbs.id, contracts });
}

export function runRegistryRebuild(root: string, options: { check: boolean; force: boolean }): number {
  try {
    const next = buildRegistryYaml(root);
    const fullPath = resolveFrom(root, defaultRegistryPath);
    const current = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
    if (options.check) {
      if (current === next) {
        console.log("PASS registry rebuild --check");
        return 0;
      }
      console.error(`${defaultRegistryPath} is out of sync; run scwbs registry rebuild --force`);
      return 1;
    }
    if (existsSync(fullPath) && !options.force && current !== next) {
      console.error(`${defaultRegistryPath} differs; rerun with --force to overwrite`);
      return 1;
    }
    writeFileSync(fullPath, next, "utf8");
    process.stdout.write(next);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
