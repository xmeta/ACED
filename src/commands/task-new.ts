import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { taskPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { TaskContract } from "../core/types.js";

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
  wbsNode?: string;
  id?: string;
} = {}): { task: TaskContract; fallback: TaskNewFallback } {
  const id = options.id ?? `SCWBS-DRAFT-${stamp()}`;
  const { title: resolvedTitle, fallback } = resolveTaskTitle(title, id);
  const safeTitle = slug(resolvedTitle);
  const task: TaskContract = {
    id,
    type: "task-contract",
    wbsNodeId: options.wbsNode?.trim() || "node-governance-maintenance",
    featureId: `F-${id.replace(/^SCWBS-DRAFT-/, "")}`,
    branchName: `task/${id}-${safeTitle}`,
    allowedPaths: splitList(options.paths, ["src/**", "tests/**", "docs/**", "contracts/**"]),
    forbiddenPaths: splitList(options.forbid, ["wjs/**"]),
    humanGateRequiredPaths: splitList(options.gate, ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"]),
    stopIf: splitList(options.stop, []),
    requiredChecks: splitList(options.checks, ["test", "typecheck", "build"]),
    doneCriteria: [`Complete ${resolvedTitle}`],
    evidenceRequired: ["test-result", "typecheck-result", "build-result"]
  };
  return { task, fallback };
}

/**
 * M1-012: when a task is meant to be tracked under an existing WBS node,
 * `task new` must not write to the WBS document directly. Instead it emits a
 * changeset draft (the same format `wbs apply` consumes) so a human/CI step
 * can review and apply it explicitly.
 */
function writeWbsLinkChangeset(root: string, task: TaskContract, wbsNodeId: string): string {
  const changesetId = `changeset-${task.id}-link-wbs-node`;
  const relativePath = `contracts/changesets/${task.id}-link-wbs-node.json`;
  const fullPath = resolveFrom(root, relativePath);
  const changeset = {
    schemaVersion: "0.1.0",
    targetWbsId: "scwbs",
    changeSetId: changesetId,
    author: "scwbs-cli",
    reason: `Link task ${task.id} to WBS node ${wbsNodeId} (draft only; review before applying).`,
    dryRun: false,
    operations: [
      {
        operationId: "op-001",
        operation: "addNodeOutput",
        nodeId: wbsNodeId,
        artifactId: `artifact-${task.id.toLowerCase()}`
      }
    ]
  };
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(changeset, null, 2)}\n`, "utf8");
  return relativePath;
}

function appendTaskIndex(root: string, task: TaskContract): void {
  const relativePath = "contracts/tasks/index.yaml";
  const fullPath = resolveFrom(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const existing = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "tasks:\n";
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  if (new RegExp(`\\bid: ${task.id}\\b`).test(existing)) return;
  const entry = [
    `  - id: ${task.id}`,
    `    path: ${taskPath(task.id)}`,
    `    branchName: ${task.branchName ?? ""}`,
    `    wbsNodeId: ${task.wbsNodeId}`,
    "    status: planned",
    "    dependsOn: []",
    ""
  ].join("\n");
  writeFileSync(fullPath, `${prefix}${entry}`, "utf8");
}

export function runTaskNew(root: string, title: string, options: {
  paths?: string;
  forbid?: string;
  gate?: string;
  checks?: string;
  stop?: string;
  wbsNode?: string;
} = {}): number {
  try {
    const { task, fallback } = buildCoreTaskNew(title, { ...options, id: nextDraftTaskId(root) });
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
    appendTaskIndex(root, task);

    // M1-012: WBS-backed operation never edits the WBS directly; it only
    // proposes a changeset draft for later review via `wbs apply`.
    if (options.wbsNode) {
      const changesetPath = writeWbsLinkChangeset(root, task, options.wbsNode);
      process.stdout.write(`Draft changeset written (not applied): ${changesetPath}\n`);
      process.stdout.write(`Review and apply with: scwbs wbs apply contracts/wbs/project.wbs.json ${changesetPath} --force\n`);
    }

    if (fallback.usedFallbackTitle && fallback.fallbackNote) {
      process.stdout.write(`Notice: ${fallback.fallbackNote}\n`);
    }

    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
