import { writeFileSync } from "node:fs";
import { listTasks, readTask } from "../core/contracts.js";
import { taskPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { buildLockedTask } from "./task-lock.js";
import { syncRegistry } from "./registry-rebuild.js";

export function buildTaskRefreshPreview(root: string, taskId: string): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
  const refreshed = buildLockedTask(root, taskId);
  const reasons = taskRefreshReasons(root, taskId);
  const lines = ["Task Contract refresh preview:", "", "Safe updates:"];
  const oldLock = task.contractLock ?? {};
  const newLock = refreshed.contractLock ?? {};
  for (const key of ["lockVersion", "wbsRevision", "wbsScopeRevision", "wbsGlobalRevision", "wbsNodeId", "specVersion", "specRevision", "createdAt"] as const) {
    if (oldLock[key] !== newLock[key]) lines.push(`- contractLock.${key}: ${oldLock[key] ?? "<missing>"} -> ${newLock[key] ?? "<missing>"}`);
  }
  if (lines.length === 3) lines.push("- None");
  lines.push("");
  lines.push("Refresh policy:");
  lines.push("- This command changes contractLock metadata only; it never changes Task authority fields");
  lines.push(`- Detected reasons: ${reasons.length > 0 ? reasons.join("; ") : "none; the current lock is fresh"}`);
  lines.push("");
  lines.push("Human Gate boundary:");
  lines.push("- If accepting the underlying WBS or Spec change requires changing scope, checks, or other authority, stop and use the Human Approval / new Task workflow");
  lines.push("- A refresh is not approval for a semantic contract change");
  return `${lines.join("\n")}\n`;
}

export function taskRefreshReasons(root: string, taskId: string): string[] {
  const { task, issues } = readTask(root, taskId);
  if (!task) return issues.map((item) => item.message);
  const refreshed = buildLockedTask(root, taskId);
  const current = task.contractLock;
  if (!current) return ["missing contractLock"];
  if (current.lockVersion !== "2") return ["legacy whole-WBS lock requires migration"];
  const reasons: string[] = [];
  if (current.wbsNodeId !== refreshed.contractLock?.wbsNodeId) reasons.push("referenced WBS node changed");
  if (current.wbsScopeRevision !== refreshed.contractLock?.wbsScopeRevision) reasons.push("node, ancestor, dependency, or artifact scope changed");
  if (current.wbsGlobalRevision !== refreshed.contractLock?.wbsGlobalRevision) reasons.push("WBS schema or global SC-WBS policy changed");
  if (current.specVersion !== refreshed.contractLock?.specVersion || current.specRevision !== refreshed.contractLock?.specRevision) reasons.push("Spec lock changed");
  return reasons;
}

export function buildAffectedTaskRefreshReport(root: string, includeAll = false): string {
  const entries = listTasks(root).flatMap(({ task, issues, path }) => {
    if (!task) return [{ taskId: path, reasons: [`invalid Task Contract: ${issues.map((item) => item.message).join("; ")}`] }];
    const reasons = taskRefreshReasons(root, task.id);
    return includeAll || reasons.length > 0 ? [{ taskId: task.id, reasons }] : [];
  });
  const lines = [includeAll ? "All Task Contracts:" : "Affected Task Contracts:"];
  if (entries.length === 0) lines.push("- None");
  for (const entry of entries) {
    lines.push(`- ${entry.taskId}${entry.reasons.length > 0 ? `: ${entry.reasons.join("; ")}` : ": current"}`);
  }
  return `${lines.join("\n")}\n`;
}

function hasInvalidTaskContracts(root: string): boolean {
  return listTasks(root).some(({ task }) => !task);
}

export function runTaskRefresh(root: string, taskId: string | undefined, options: { apply: boolean; affected?: boolean; all?: boolean }): number {
  try {
    if (options.affected) {
      if (options.apply) throw new Error("--affected is preview-only; use --all --apply for an explicit bulk update");
      process.stdout.write(buildAffectedTaskRefreshReport(root));
      return hasInvalidTaskContracts(root) ? 1 : 0;
    }
    if (options.all) {
      process.stdout.write(buildAffectedTaskRefreshReport(root, true));
      if (hasInvalidTaskContracts(root)) return 1;
      if (!options.apply) return 0;
      const refreshedTasks = listTasks(root).map(({ task, issues }) => {
        if (!task) throw new Error(issues.map((item) => item.message).join("\n"));
        return buildLockedTask(root, task.id);
      });
      for (const refreshed of refreshedTasks) {
        writeFileSync(resolveFrom(root, taskPath(refreshed.id)), stringifySimpleYaml(refreshed as unknown as Record<string, unknown>), "utf8");
      }
      syncRegistry(root);
      console.log("refreshed all Task Contracts");
      return 0;
    }
    if (!taskId) throw new Error("Missing --task <task-id>, --affected, or --all");
    if (!options.apply) {
      process.stdout.write(buildTaskRefreshPreview(root, taskId));
      return 0;
    }
    const refreshed = buildLockedTask(root, taskId);
    writeFileSync(resolveFrom(root, taskPath(taskId)), stringifySimpleYaml(refreshed as unknown as Record<string, unknown>), "utf8");
    syncRegistry(root);
    console.log(`refreshed ${taskPath(taskId)}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
