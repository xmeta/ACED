import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readJsonFile } from "./json.js";
import { defaultWbsPath, resolveFrom } from "./paths.js";
import { asWbsDocument, validateWbsShape } from "./schema.js";
import { classifyDecisionReadiness } from "./discovery.js";
import { resolveWjsRuntime, type WjsRuntime } from "./wjs-runtime.js";
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
  const nodeCodes = new Set<string>();
  let rootCount = 0;

  for (const node of wbs.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ severity: "error", code: "wbs.node.duplicate", message: `duplicate node id: ${node.id}` });
    }
    nodeIds.add(node.id);

    if (node.code) {
      if (nodeCodes.has(node.code)) {
        issues.push({ severity: "error", code: "wbs.code.duplicate", message: `duplicate WBS code: ${node.code}` });
      }
      nodeCodes.add(node.code);
    }

    if (node.status === "completed" && node.progressPercent !== undefined && node.progressPercent < 100) {
      issues.push({
        severity: "error",
        code: "wbs.status.progress.mismatch",
        message: `node ${node.id} status is completed but progressPercent is ${node.progressPercent}%`
      });
    }
    if (node.status !== "completed" && node.progressPercent === 100) {
      issues.push({
        severity: "error",
        code: "wbs.status.progress.mismatch",
        message: `node ${node.id} progressPercent is 100% but status is ${node.status}`
      });
    }

    if (node.workMode === "discovery" && node.discovery) {
      const expected = classifyDecisionReadiness(
        node.discovery.exitConditionsMet,
        node.discovery.openUnknowns,
        node.discovery.blockingUnknowns
      );
      if (expected !== node.discovery.decisionReadiness) {
        issues.push({
          severity: "error",
          code: "wbs.discovery.readiness.mismatch",
          message: `node ${node.id} discovery decisionReadiness is ${node.discovery.decisionReadiness}, expected ${expected}`
        });
      }
    }

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
    if (node.parentId !== null) {
      if (!nodeIds.has(node.parentId)) {
        issues.push({ severity: "error", code: "wbs.parent", message: `node ${node.id} parentId does not exist: ${node.parentId}` });
      } else {
        const parent = wbs.nodes.find((n) => n.id === node.parentId);
        if (parent && parent.status === "completed" && node.status !== "completed") {
          issues.push({
            severity: "error",
            code: "wbs.hierarchy.incomplete_child",
            message: `parent node ${parent.id} is completed but child node ${node.id} is ${node.status}`
          });
        }
      }
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

function wjsValidatorUnavailable(kind: "wbs" | "operations", target: string, reason: string, runtime?: WjsRuntime): Issue {
  return {
    severity: "error",
    code: "wjs.validator.unavailable",
    message: `canonical WJS ${kind} validator is unavailable for ${target}: ${reason}`,
    fixCommand: runtime?.kind === "bundled"
      ? "Reinstall the scwbs package so its bundled WJS runtime is restored"
      : "git submodule update --init --recursive wjs"
  };
}

function isWjsRuntimeUnavailable(result: { error?: Error; stderr?: string; stdout?: string }): boolean {
  const output = `${result.error?.message ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /ENOENT|ERR_NO_TYPESCRIPT|ERR_UNKNOWN_FILE_EXTENSION|MODULE_NOT_FOUND|Cannot find (?:module|package)/i.test(output);
}

export function runWjsValidate(root: string, relativePath = defaultWbsPath, kind: "wbs" | "operations" = "wbs"): Issue[] {
  const runtime = resolveWjsRuntime(root);
  const target = resolveFrom(root, relativePath);
  if (!runtime) {
    return kind === "operations"
      ? [wjsValidatorUnavailable(kind, relativePath, "bundled runtime and wjs submodule are missing")]
      : validateWbsDocument(root, relativePath);
  }

  const result = runtime.kind === "bundled"
    ? spawnSync(process.execPath, ["--experimental-strip-types", runtime.validator, `--${kind}`, target], { cwd: runtime.root, encoding: "utf8" })
    : runSubmoduleValidator(runtime, kind, target);
  if (result.status !== 0 && isWjsRuntimeUnavailable(result)) {
    return kind === "operations"
      ? [wjsValidatorUnavailable(kind, relativePath, "validator runtime or dependencies could not be executed", runtime)]
      : validateWbsDocument(root, relativePath);
  }

  if (result.status === 0) return [];
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [{ severity: "error", code: "wjs.validate", message: `${relativePath} failed WJS ${kind} validation` }];
  }
  return lines.map((line) => ({ severity: "error", code: "wjs.validate", message: line }));
}

function runSubmoduleValidator(runtime: WjsRuntime, kind: "wbs" | "operations", target: string) {
  let result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "validate", "--", `--${kind}`, target], {
    cwd: runtime.root,
    encoding: "utf8"
  });
  if (result.status !== 0 && /missing script: validate/i.test(result.stderr ?? "")) {
    result = spawnSync(process.execPath, ["--experimental-strip-types", runtime.validator, `--${kind}`, target], {
      cwd: runtime.root,
      encoding: "utf8"
    });
  }
  return result;
}
