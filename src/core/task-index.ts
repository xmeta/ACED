import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidTaskId, taskPath, resolveFrom } from "./paths.js";
import { parseSimpleYaml, stringifySimpleYaml } from "./yaml.js";
import type { Issue, TaskContract, TaskIndex, TaskIndexEntry, TaskLifecycleStatus } from "./types.js";

export const taskIndexPath = "contracts/tasks/index.yaml";
export const taskLifecycleStatuses: readonly TaskLifecycleStatus[] = [
  "planned",
  "active",
  "blocked",
  "reviewed",
  "completed",
  "cancelled",
  "archived"
];
const terminalTaskStatuses = new Set<TaskLifecycleStatus>(["completed", "cancelled", "archived"]);

export type TaskListEntry = { task?: TaskContract; issues: Issue[]; path: string };

export function isActiveTaskStatus(status: TaskLifecycleStatus): boolean {
  return !terminalTaskStatuses.has(status);
}

function indexIssue(code: string, message: string): Issue {
  return { severity: "error", code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown, position: number): { entry?: TaskIndexEntry; issues: Issue[] } {
  const label = `${taskIndexPath}.tasks[${position}]`;
  if (!isRecord(value)) return { issues: [indexIssue("task.index.entry", `${label} must be an object`)] };
  const issues: Issue[] = [];
  const id = typeof value.id === "string" ? value.id : "";
  const validId = id.length > 0 && isValidTaskId(id);
  const canonicalPath = validId ? taskPath(id) : "";
  if (!validId) issues.push(indexIssue("task.index.id", `${label}.id must be a valid Task id`));
  if (typeof value.path !== "string" || value.path !== canonicalPath) {
    issues.push(indexIssue("task.index.path", `${label}.path must equal ${canonicalPath || "the canonical Task path"}`));
  }
  if (typeof value.branchName !== "string") issues.push(indexIssue("task.index.branchName", `${label}.branchName must be a string`));
  if (typeof value.wbsNodeId !== "string" || value.wbsNodeId.length === 0) {
    issues.push(indexIssue("task.index.wbsNodeId", `${label}.wbsNodeId must be a non-empty string`));
  }
  const status = typeof value.status === "string" && taskLifecycleStatuses.includes(value.status as TaskLifecycleStatus)
    ? value.status as TaskLifecycleStatus
    : undefined;
  if (!status) issues.push(indexIssue("task.index.status", `${label}.status must be one of ${taskLifecycleStatuses.join(", ")}`));
  const dependsOn = Array.isArray(value.dependsOn) && value.dependsOn.every((item) => typeof item === "string")
    ? value.dependsOn as string[]
    : undefined;
  if (!dependsOn) issues.push(indexIssue("task.index.dependsOn", `${label}.dependsOn must be an array of Task ids`));
  if (value.archivedAt !== undefined) {
    if (typeof value.archivedAt !== "string" || Number.isNaN(Date.parse(value.archivedAt))) {
      issues.push(indexIssue("task.index.archivedAt", `${label}.archivedAt must be an ISO date-time`));
    } else if (status !== "archived") {
      issues.push(indexIssue("task.index.archivedAt", `${label}.archivedAt is only valid for archived status`));
    }
  }
  if (issues.length > 0 || !status || !dependsOn) return { issues };
  return {
    entry: {
      id,
      path: canonicalPath,
      branchName: value.branchName as string,
      wbsNodeId: value.wbsNodeId as string,
      status,
      dependsOn,
      ...(typeof value.archivedAt === "string" ? { archivedAt: value.archivedAt } : {})
    },
    issues
  };
}

export function readTaskIndex(root: string): { index?: TaskIndex; issues: Issue[] } {
  const fullPath = resolveFrom(root, taskIndexPath);
  if (!existsSync(fullPath)) {
    return { issues: [indexIssue("task.index.missing", `${taskIndexPath} does not exist`)] };
  }
  let value: unknown;
  try {
    value = parseSimpleYaml(readFileSync(fullPath, "utf8"));
  } catch (error) {
    return { issues: [indexIssue("task.index.parse", `${taskIndexPath} could not be parsed: ${error instanceof Error ? error.message : String(error)}`)] };
  }
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    return { issues: [indexIssue("task.index.tasks", `${taskIndexPath}.tasks must be an array`)] };
  }
  const issues: Issue[] = [];
  const entries: TaskIndexEntry[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  value.tasks.forEach((item, position) => {
    const parsed = parseEntry(item, position);
    issues.push(...parsed.issues);
    if (!parsed.entry) return;
    if (ids.has(parsed.entry.id)) issues.push(indexIssue("task.index.duplicateId", `${taskIndexPath} contains duplicate id ${parsed.entry.id}`));
    if (paths.has(parsed.entry.path)) issues.push(indexIssue("task.index.duplicatePath", `${taskIndexPath} contains duplicate path ${parsed.entry.path}`));
    ids.add(parsed.entry.id);
    paths.add(parsed.entry.path);
    entries.push(parsed.entry);
  });
  return { index: { tasks: entries }, issues };
}

export function collectTaskIndexInventoryIssues(root: string, tasks: TaskListEntry[]): Issue[] {
  const result = readTaskIndex(root);
  const issues = [...tasks.flatMap((entry) => entry.issues), ...result.issues];
  if (!result.index) return issues;
  const indexed = new Map(result.index.tasks.map((entry) => [entry.id, entry]));
  const contracts = new Map(tasks.flatMap((entry) => entry.task ? [[entry.task.id, entry] as const] : []));
  for (const [id, contract] of contracts) {
    const entry = indexed.get(id);
    if (!entry) {
      issues.push(indexIssue("task.index.contractMissing", `${contract.path} is not indexed by ${taskIndexPath}`));
      continue;
    }
    if (entry.branchName !== (contract.task?.branchName ?? "")) {
      issues.push(indexIssue("task.index.branchNameDrift", `${id} branchName does not match its Task Contract`));
    }
    if (entry.wbsNodeId !== contract.task?.wbsNodeId) {
      issues.push(indexIssue("task.index.wbsNodeIdDrift", `${id} wbsNodeId does not match its Task Contract`));
    }
  }
  for (const entry of result.index.tasks) {
    if (!contracts.has(entry.id)) issues.push(indexIssue("task.index.orphan", `${entry.id} has no Task Contract at ${entry.path}`));
  }
  return issues;
}

export function activeTaskEntries(root: string, tasks: TaskListEntry[]): TaskListEntry[] {
  const result = readTaskIndex(root);
  if (!result.index || result.issues.length > 0) return tasks;
  const statusById = new Map(result.index.tasks.map((entry) => [entry.id, entry.status]));
  return tasks.filter((entry) => !entry.task || isActiveTaskStatus(statusById.get(entry.task.id) ?? "planned"));
}

export function buildTaskIndex(tasks: TaskListEntry[], current?: TaskIndex): TaskIndex {
  const prior = new Map(current?.tasks.map((entry) => [entry.id, entry]) ?? []);
  const entries = tasks.flatMap((item) => {
    if (!item.task) return [];
    const previous = prior.get(item.task.id);
    const status = previous?.status ?? "planned";
    return [{
      id: item.task.id,
      path: item.path,
      branchName: item.task.branchName ?? "",
      wbsNodeId: item.task.wbsNodeId,
      status,
      dependsOn: previous?.dependsOn ?? [],
      ...(status === "archived" && previous?.archivedAt ? { archivedAt: previous.archivedAt } : {})
    } satisfies TaskIndexEntry];
  });
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { tasks: entries };
}

export function taskIndexYaml(index: TaskIndex): string {
  return stringifySimpleYaml(index as unknown as Record<string, unknown>);
}

export function writeTaskIndexAtomic(root: string, index: TaskIndex): void {
  const fullPath = resolveFrom(root, taskIndexPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporaryPath = `${fullPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, taskIndexYaml(index), "utf8");
  renameSync(temporaryPath, fullPath);
}
