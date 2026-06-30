import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readJsonFile } from "./json.js";
import { defaultWbsPath, resolveFrom } from "./paths.js";
import { asWbsDocument, validateWbsShape } from "./schema.js";
import type { Issue, WbsDocument, WbsNode } from "./types.js";

export function readWbs(root: string, relativePath = defaultWbsPath): WbsDocument {
  return readJsonFile<WbsDocument>(resolveFrom(root, relativePath));
}

export function findNode(wbs: WbsDocument, nodeId: string): WbsNode | undefined {
  return wbs.nodes.find((node) => node.id === nodeId);
}

export function isDoneNode(node: WbsNode): boolean {
  const scwbs = node.extensions?.scwbs;
  const scwbsStatus = typeof scwbs === "object" && scwbs !== null ? (scwbs as Record<string, unknown>).status : undefined;
  return node.status === "completed" || scwbsStatus === "Done";
}

export function validateWbsDocument(root: string, relativePath = defaultWbsPath): Issue[] {
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return [{ severity: "error", code: "wbs.missing", message: `${relativePath} does not exist` }];
  }

  const document = readJsonFile<unknown>(fullPath);
  const issues = validateWbsShape(document);
  if (issues.length > 0) return issues;

  const wbs = asWbsDocument(document);
  const nodeIds = new Set<string>();
  let rootCount = 0;

  for (const node of wbs.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ severity: "error", code: "wbs.node.duplicate", message: `duplicate node id: ${node.id}` });
    }
    nodeIds.add(node.id);
    if (node.parentId === null) rootCount += 1;
  }

  if (!nodeIds.has(wbs.rootId)) {
    issues.push({ severity: "error", code: "wbs.rootId", message: `rootId does not reference an existing node: ${wbs.rootId}` });
  }
  if (rootCount !== 1) {
    issues.push({ severity: "error", code: "wbs.root", message: `WBS must have exactly one root node, found ${rootCount}` });
  }
  const rootNode = wbs.nodes.find((node) => node.parentId === null);
  if (rootNode && rootNode.id !== wbs.rootId) {
    issues.push({ severity: "error", code: "wbs.root", message: `root node ${rootNode.id} must match rootId ${wbs.rootId}` });
  }
  for (const node of wbs.nodes) {
    if (node.parentId !== null && !nodeIds.has(node.parentId)) {
      issues.push({ severity: "error", code: "wbs.parent", message: `node ${node.id} parentId does not exist: ${node.parentId}` });
    }
  }

  const artifactIds = new Set((wbs.artifacts ?? []).map((artifact) => artifact.id));
  for (const node of wbs.nodes) {
    for (const output of node.outputs ?? []) {
      if (!artifactIds.has(output)) {
        issues.push({ severity: "error", code: "wbs.output", message: `node ${node.id} output references missing artifact: ${output}` });
      }
    }
  }

  return issues;
}

function validateOperationsFallback(target: string): Issue[] {
  try {
    const document = readJsonFile<unknown>(target);
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return [{ severity: "error", code: "wjs.validate", message: "operation change set must be an object" }];
    }
    const value = document as Record<string, unknown>;
    const issues: Issue[] = [];
    for (const key of ["schemaVersion", "targetWbsId", "changeSetId", "operations"]) {
      if (value[key] === undefined) issues.push({ severity: "error", code: "wjs.validate", message: `operation change set missing ${key}` });
    }
    if (!Array.isArray(value.operations)) {
      issues.push({ severity: "error", code: "wjs.validate", message: "operation change set operations must be an array" });
    }
    return issues;
  } catch (error) {
    return [{ severity: "error", code: "wjs.validate", message: error instanceof Error ? error.message : String(error) }];
  }
}

export function runWjsValidate(root: string, relativePath = defaultWbsPath, kind: "wbs" | "operations" = "wbs"): Issue[] {
  const wjsRoot = path.resolve(root, "wjs");
  const validator = path.resolve(wjsRoot, "tools/validate.ts");
  const target = resolveFrom(root, relativePath);
  if (!existsSync(validator)) return validateWbsDocument(root, relativePath);

  let result = spawnSync(process.execPath, ["--experimental-strip-types", "tools/validate.ts", `--${kind}`, target], {
    cwd: wjsRoot,
    encoding: "utf8"
  });
  if (result.status !== 0 && result.stderr?.includes("ERR_NO_TYPESCRIPT")) {
    result = spawnSync(process.execPath, ["tools/validate.ts", `--${kind}`, target], {
      cwd: wjsRoot,
      encoding: "utf8"
    });
  }
  if (result.status !== 0 && kind === "operations" && /ERR_NO_TYPESCRIPT|ERR_UNKNOWN_FILE_EXTENSION/.test(result.stderr ?? "")) {
    return validateOperationsFallback(target);
  }
  if (result.status !== 0 && kind === "wbs" && /ERR_NO_TYPESCRIPT|ERR_UNKNOWN_FILE_EXTENSION/.test(result.stderr ?? "")) {
    return validateWbsDocument(root, relativePath);
  }

  if (result.status === 0) return [];
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [{ severity: "error", code: "wjs.validate", message: `${relativePath} failed WJS ${kind} validation` }];
  }
  return lines.map((line) => ({ severity: "error", code: "wjs.validate", message: line }));
}
