import { existsSync, readFileSync } from "node:fs";
import { listTasks, readTask } from "../core/contracts.js";
import { resolveFrom } from "../core/paths.js";
import {
  buildTaskIndex,
  collectTaskIndexInventoryIssues,
  readTaskIndex,
  taskIndexPath,
  taskIndexYaml,
  writeTaskIndexAtomic
} from "../core/task-index.js";
import type { TaskIndex, TaskIndexEntry } from "../core/types.js";
import { syncRegistry } from "./registry-rebuild.js";

export type TaskIndexRebuildOptions = {
  check?: boolean;
  force?: boolean;
  json?: boolean;
};

type TaskIndexSummary = {
  schemaVersion: "1.0.0";
  status: "synchronized" | "out-of-sync" | "rebuilt";
  active: number;
  archived: number;
  total: number;
  issues: number;
};

function summary(index: TaskIndex, status: TaskIndexSummary["status"], issues: number): TaskIndexSummary {
  return {
    schemaVersion: "1.0.0",
    status,
    active: index.tasks.filter((entry) => !["completed", "cancelled", "archived"].includes(entry.status)).length,
    archived: index.tasks.filter((entry) => entry.status === "archived").length,
    total: index.tasks.length,
    issues
  };
}

function printSummary(value: TaskIndexSummary, json = false): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const prefix = value.status === "out-of-sync" ? "FAIL" : "PASS";
  console.log(`${prefix} task index ${value.status}`);
  console.log(`active: ${value.active}`);
  console.log(`archived: ${value.archived}`);
  console.log(`total: ${value.total}`);
  console.log(`issues: ${value.issues}`);
}

export function runTaskIndexRebuild(root: string, options: TaskIndexRebuildOptions): number {
  try {
    if (options.check && options.force) {
      console.error("Choose one of --check or --force");
      return 2;
    }
    if (!options.check && !options.force) {
      console.error("Task index rebuild is read-only by default; pass --check or --force");
      return 2;
    }
    const tasks = listTasks(root);
    const current = readTaskIndex(root);
    const next = buildTaskIndex(tasks, current.index);
    const nextYaml = taskIndexYaml(next);
    const fullPath = resolveFrom(root, taskIndexPath);
    const currentYaml = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
    const inventoryIssues = collectTaskIndexInventoryIssues(root, tasks);
    const synchronized = currentYaml === nextYaml && inventoryIssues.length === 0;

    if (options.check) {
      printSummary(summary(next, synchronized ? "synchronized" : "out-of-sync", inventoryIssues.length), options.json);
      return synchronized ? 0 : 1;
    }

    const invalidContracts = tasks.flatMap((entry) => entry.issues);
    if (invalidContracts.length > 0) {
      printSummary(summary(next, "out-of-sync", invalidContracts.length), options.json);
      return 1;
    }
    writeTaskIndexAtomic(root, next);
    syncRegistry(root);
    printSummary(summary(next, "rebuilt", 0), options.json);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function archivedEntry(entry: TaskIndexEntry, archivedAt: string): TaskIndexEntry {
  return { ...entry, status: "archived", archivedAt };
}

export function runTaskArchive(root: string, taskId: string, options: { now?: string; json?: boolean } = {}): number {
  try {
    const taskResult = readTask(root, taskId);
    if (!taskResult.task) throw new Error(taskResult.issues.map((issue) => issue.message).join("\n"));
    const indexResult = readTaskIndex(root);
    const inventoryIssues = collectTaskIndexInventoryIssues(root, listTasks(root));
    if (!indexResult.index || inventoryIssues.length > 0) {
      throw new Error(`Task index is invalid; run scwbs task index rebuild --force before archiving`);
    }
    const position = indexResult.index.tasks.findIndex((entry) => entry.id === taskId);
    if (position < 0) throw new Error(`${taskId} is not present in ${taskIndexPath}`);
    const current = indexResult.index.tasks[position]!;
    const archivedAt = current.archivedAt ?? options.now ?? new Date().toISOString();
    indexResult.index.tasks[position] = archivedEntry(current, archivedAt);
    writeTaskIndexAtomic(root, indexResult.index);
    syncRegistry(root);
    const result = { schemaVersion: "1.0.0", taskId, status: "archived", archivedAt };
    if (options.json) console.log(JSON.stringify(result));
    else {
      console.log(`PASS archived ${taskId}`);
      console.log(`archivedAt: ${archivedAt}`);
      console.log("Task, Evidence, Approval, and Review records remain in place.");
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
