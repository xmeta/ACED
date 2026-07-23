import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listTasks } from "../core/contracts.js";
import { isWbsLessTask, WBS_LESS_TASK_NODE_ID } from "../core/node-utils.js";
import { defaultWbsPath, taskPath, resolveFrom } from "../core/paths.js";
import { buildTaskIndex, readTaskIndex, writeTaskIndexAtomic } from "../core/task-index.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { findNode, readWbs } from "../core/wbs.js";
import type { TaskContract } from "../core/types.js";
import { syncRegistry } from "./registry-rebuild.js";

const BROAD_SCOPE_PATTERNS = new Set(["src/**", "tests/**", "docs/**", "contracts/**", "**"]);
const STANDARD_HUMAN_GATE_PATHS = ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48) || "task";
}

function stamp(): string {
  return Date.now().toString(36).toUpperCase();
}

export function nextDraftTaskId(root: string, baseStamp = stamp()): string {
  const baseId = `SCWBS-DRAFT-${baseStamp}`;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? baseId : `${baseId}-${index}`;
    if (!existsSync(resolveFrom(root, taskPath(candidate)))) return candidate;
  }
  throw new Error(`Could not allocate a draft task id for ${baseId}`);
}

function splitList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function humanGatePaths(value: string | undefined): string[] {
  return [...new Set([...STANDARD_HUMAN_GATE_PATHS, ...splitList(value, [])])];
}

export interface TaskNewFallback {
  usedFallbackTitle: boolean;
  fallbackNote?: string;
}

/**
 * M1-007: when the title is missing, do not error out. Fall back to a safe,
 * deterministic placeholder title instead of guessing at user intent, and
 * surface a clear notice plus a fixCommand so the caller knows to rename it.
 * This is the "safe non-interactive fallback" path; a TTY-driven interactive
 * prompt is out of scope for the CLI's non-interactive/CI usage.
 */
export function resolveTaskTitle(rawTitle: string, id: string): { title: string; fallback: TaskNewFallback } {
  const trimmed = rawTitle.trim();
  if (trimmed.length > 0) {
    return { title: trimmed, fallback: { usedFallbackTitle: false } };
  }
  const fallbackTitle = `untitled task ${id.replace(/^SCWBS-DRAFT-/, "").toLowerCase()}`;
  return {
    title: fallbackTitle,
    fallback: {
      usedFallbackTitle: true,
      fallbackNote: `No title was given, so a placeholder title was used. Rename it with: scwbs task rename --task ${id} --title "<title>"`
    }
  };
}

export function buildCoreTaskNew(title: string, options: {
  paths?: string;
  forbid?: string;
  gate?: string;
  checks?: string;
  stop?: string;
  noStopConditions?: boolean;
  wbsNode?: string;
  id?: string;
} = {}): { task: TaskContract; fallback: TaskNewFallback } {
  const id = options.id ?? `SCWBS-DRAFT-${stamp()}`;
  const { title: resolvedTitle, fallback } = resolveTaskTitle(title, id);
  const safeTitle = slug(resolvedTitle);
  const task: TaskContract = {
    id,
    type: "task-contract",
    wbsNodeId: options.wbsNode?.trim() || WBS_LESS_TASK_NODE_ID,
    featureId: `F-${id.replace(/^SCWBS-DRAFT-/, "")}`,
    branchName: `task/${id}-${safeTitle}`,
    allowedPaths: splitList(options.paths, []),
    forbiddenPaths: splitList(options.forbid, ["wjs/**"]),
    humanGateRequiredPaths: humanGatePaths(options.gate),
    stopIf: splitList(options.stop, []),
    requiredChecks: splitList(options.checks, ["test", "typecheck", "build"]),
    doneCriteria: [`Complete ${resolvedTitle}`],
    evidenceRequired: ["test-result", "typecheck-result", "build-result"]
  };
  return { task, fallback };
}

export function runTaskNew(root: string, title: string, options: {
  paths?: string;
  forbid?: string;
  gate?: string;
  checks?: string;
  stop?: string;
  noStopConditions?: boolean;
  wbsNode?: string;
} = {}): number {
  try {
    if (!options.stop && !options.noStopConditions) {
      console.error("Task creation is fail-closed: provide --stop <reasons> or explicitly acknowledge an empty stop list with --no-stop-conditions");
      return 1;
    }
    const { task, fallback } = buildCoreTaskNew(title, { ...options, id: nextDraftTaskId(root) });
    if (!isWbsLessTask(task)) {
      if (!existsSync(resolveFrom(root, defaultWbsPath))) {
        console.error(`Cannot validate --wbs-node ${task.wbsNodeId}: WBS document is missing`);
        return 1;
      }
      const wbs = readWbs(root);
      if (!findNode(wbs, task.wbsNodeId)) {
        console.error(`Unknown WBS node: ${task.wbsNodeId}`);
        return 1;
      }
    }
    const relativePath = taskPath(task.id);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath)) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const yaml = stringifySimpleYaml(task as unknown as Record<string, unknown>);
    writeFileSync(fullPath, yaml, "utf8");

    // M1-011: WBS-less operation keeps tasks discoverable via the index.
    const currentIndex = readTaskIndex(root).index;
    writeTaskIndexAtomic(root, buildTaskIndex(listTasks(root), currentIndex));

    // M1-012: WBS-backed operation never edits the WBS directly. The Task
    // Contract's wbsNodeId field is the canonical association; no changeset
    // is emitted.

    if (fallback.usedFallbackTitle && fallback.fallbackNote) {
      process.stdout.write(`Notice: ${fallback.fallbackNote}\n`);
    }

    if (task.allowedPaths.length === 0) {
      process.stdout.write("Notice: no --paths were provided; allowedPaths is empty and this draft cannot authorize implementation.\n");
    }
    const broadScopes = task.allowedPaths.filter((item) => BROAD_SCOPE_PATTERNS.has(item));
    if (broadScopes.length > 0) {
      process.stdout.write(`Warning: broad allowedPaths require explicit review before implementation: ${broadScopes.join(", ")}\n`);
    }
    if (isWbsLessTask(task)) {
      process.stdout.write("Notice: no --wbs-node was provided; this task is WBS-less and will not enter WBS completion queues.\n");
    }

    syncRegistry(root);
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
