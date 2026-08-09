import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { listActiveTasks } from "../core/contracts.js";
import { defaultWbsPath, resolveFrom } from "../core/paths.js";
import { hasErrors, printIssues } from "../core/report.js";
import { readWbs, resolveWjsRuntime, runWjsValidate } from "../core/wbs.js";
import type { WbsDocument, WbsNode } from "../core/types.js";

export function runWbsValidate(root: string): number {
  const issues = runWjsValidate(root);
  if (issues.length === 0) {
    console.log(`${defaultWbsPath}: OK (wbs)`);
    return 0;
  }
  printIssues(issues);
  return hasErrors(issues) ? 1 : 0;
}

export function runWbsApply(root: string, changeSetPath: string, options: { force: boolean; output?: string }): number {
  const runtime = resolveWjsRuntime(root, "apply");
  if (!runtime) {
    console.error("WJS runtime is unavailable: install the scwbs package or initialize the wjs submodule");
    return 1;
  }

  const toolArgs = [resolveFrom(root, defaultWbsPath), resolveFrom(root, changeSetPath)];
  if (options.output) toolArgs.push("-o", resolveFrom(root, options.output));
  if (options.force) toolArgs.push("--force");

  const result = runtime.kind === "bundled"
    ? spawnSync(process.execPath, ["--experimental-strip-types", runtime.apply, ...toolArgs], { cwd: runtime.root, encoding: "utf8" })
    : runSubmoduleApply(runtime.root, runtime.apply, toolArgs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

function runSubmoduleApply(wjsRoot: string, applyTool: string, toolArgs: string[]) {
  let result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "apply", "--", ...toolArgs], {
    cwd: wjsRoot,
    encoding: "utf8"
  });
  if (result.status !== 0 && /missing script: apply/i.test(result.stderr ?? "")) {
    result = spawnSync(process.execPath, ["--experimental-strip-types", applyTool, ...toolArgs], {
      cwd: wjsRoot,
      encoding: "utf8"
    });
  }
  return result;
}

function normalizeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function applyWbsChangesets(base: WbsDocument, changeSets: Array<Record<string, unknown>>): WbsDocument {
  const next = JSON.parse(JSON.stringify(base)) as WbsDocument;
  for (const changeSet of changeSets) {
    const operations = Array.isArray(changeSet.operations) ? changeSet.operations : [];
    for (const rawOperation of operations) {
      if (!rawOperation || typeof rawOperation !== "object") continue;
      const operation = rawOperation as Record<string, unknown>;
      if (
        operation.operation === "setDocumentExtension"
        && typeof operation.namespace === "string"
        && operation.value
        && typeof operation.value === "object"
        && !Array.isArray(operation.value)
      ) {
        next.extensions = {
          ...(next.extensions ?? {}),
          [operation.namespace]: JSON.parse(JSON.stringify(operation.value)) as Record<string, unknown>
        };
      }
      if (operation.operation === "changeNodeStatus" && typeof operation.nodeId === "string" && typeof operation.status === "string") {
        const node = next.nodes.find((item) => item.id === operation.nodeId);
        if (node) node.status = operation.status as WbsDocument["nodes"][number]["status"];
      }
      if (operation.operation === "addNode") {
        const node = operation.node as Record<string, unknown> | undefined;
        const nodeId = typeof node?.id === "string" ? node.id : (typeof operation.nodeId === "string" ? operation.nodeId : "");
        if (!nodeId) continue;
        if (next.nodes.some((item) => item.id === nodeId)) continue;
        next.nodes.push({
          id: nodeId,
          parentId: typeof node?.parentId === "string" ? node.parentId : (typeof operation.parentId === "string" ? operation.parentId : next.rootId),
          code: typeof node?.code === "string" ? node.code : (typeof operation.code === "string" ? operation.code : nodeId),
          name: typeof node?.name === "string" ? node.name : (typeof operation.name === "string" ? operation.name : nodeId),
          type: (node?.type === "summary" || node?.type === "deliverable" || node?.type === "activity" || node?.type === "milestone" ? node.type : (operation.type === "summary" || operation.type === "deliverable" || operation.type === "activity" || operation.type === "milestone" ? operation.type : "workPackage")) as WbsNode["type"],
          status: (node?.status === "draft" || node?.status === "ready" || node?.status === "inProgress" || node?.status === "blocked" || node?.status === "completed" || node?.status === "cancelled" ? node.status : (operation.status === "draft" || operation.status === "ready" || operation.status === "inProgress" || operation.status === "blocked" || operation.status === "completed" || operation.status === "cancelled" ? operation.status : "planned")) as WbsNode["status"]
        });
      }
      if (operation.operation === "addNodeOutput" && typeof operation.nodeId === "string" && typeof operation.artifactId === "string") {
        const node = next.nodes.find((item) => item.id === operation.nodeId);
        if (node) node.outputs = [...new Set([...(node.outputs ?? []), operation.artifactId])];
      }
    }
  }
  return next;
}

export function verifyWbsChangesets(root: string, basePath: string, headPath: string, changeSetPaths: string[]): boolean {
  const base = JSON.parse(readFileSync(resolveFrom(root, basePath), "utf8")) as WbsDocument;
  const head = JSON.parse(readFileSync(resolveFrom(root, headPath), "utf8")) as WbsDocument;
  const changeSets = changeSetPaths.map((file) => JSON.parse(readFileSync(resolveFrom(root, file), "utf8")) as Record<string, unknown>);
  return normalizeJson(canonical(applyWbsChangesets(base, changeSets))) === normalizeJson(canonical(head));
}

export function runWbsVerifyChangesets(root: string, options: { base?: string; head?: string; changeSets: string[] }): number {
  if (!options.base || !options.head || options.changeSets.length === 0) {
    console.error("Usage: scwbs wbs verify-changesets --base <base.wbs.json> --head <head.wbs.json> --changeset <change-set.json> [--changeset <change-set.json>...]");
    return 2;
  }
  try {
    if (verifyWbsChangesets(root, options.base, options.head, options.changeSets)) {
      console.log("PASS wbs verify-changesets");
      return 0;
    }
    console.error("WBS changesets do not reproduce the head WBS");
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function buildWbsCandidatesFromTaskIndex(root: string): string {
  const ids = listActiveTasks(root).flatMap((entry) => entry.task ? [entry.task.id] : []);
  const wbs = existsSync(resolveFrom(root, defaultWbsPath)) ? readWbs(root) : null;
  const rootId = wbs?.rootId ?? "node-project";
  const operations = ids.map((id, index) => ({
    operationId: `op-${String(index + 1).padStart(3, "0")}`,
    operation: "addNode",
    node: {
      id: `node-${id.toLowerCase()}`,
      parentId: rootId,
      code: id.toLowerCase().replace(/-/g, "."),
      name: id,
      type: "workPackage",
      status: "planned"
    },
    position: { mode: "last" }
  }));
  return `${JSON.stringify({
    schemaVersion: "0.1.0",
    targetWbsId: "scwbs",
    changeSetId: "changeset-wbs-candidates",
    author: "scwbs-cli",
    reason: "Candidate WBS nodes generated from contracts/tasks/index.yaml. Review before applying.",
    dryRun: true,
    operations
  }, null, 2)}\n`;
}

export function runWbsCandidates(root: string): number {
  try {
    process.stdout.write(buildWbsCandidatesFromTaskIndex(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
