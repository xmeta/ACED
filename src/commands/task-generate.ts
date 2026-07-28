import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readWbs, findNode } from "../core/wbs.js";
import { evidencePayloadPath, resolveFrom, taskPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { TaskContract } from "../core/types.js";

function draftFeatureId(code: string): string {
  return `F-${code.replace(/\./g, "-")}`;
}

function branchSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function buildDraftTask(root: string, nodeId: string, taskId: string): TaskContract {
  const wbs = readWbs(root);
  const node = findNode(wbs, nodeId);
  if (!node) {
    throw new Error(`WBS node not found: ${nodeId}`);
  }

  return {
    id: taskId,
    type: "task-contract",
    wbsNodeId: node.id,
    featureId: draftFeatureId(node.code),
    branchName: `task/${taskId}-${branchSlug(node.name)}`,
    allowedPaths: ["src/**", "tests/**", "docs/**"],
    forbiddenPaths: ["wjs/**"],
    humanGateRequiredPaths: ["package.json", "package-lock.json", ".github/**"],
    requiredChecks: ["test", "typecheck", "build"],
    doneCriteria: node.acceptanceCriteria?.length ? [...node.acceptanceCriteria] : [`Complete ${node.name}`],
    evidenceRequired: ["test-result", "typecheck-result", "build-result"],
    managedContractPaths: [evidencePayloadPath(taskId)]
  };
}

export function buildDraftTaskYaml(root: string, nodeId: string, taskId: string): string {
  return stringifySimpleYaml(buildDraftTask(root, nodeId, taskId) as unknown as Record<string, unknown>);
}

export function runTaskGenerate(root: string, nodeId: string, taskId: string, options: { force: boolean }): number {
  try {
    const relativePath = taskPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }

    const yaml = buildDraftTaskYaml(root, nodeId, taskId);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
