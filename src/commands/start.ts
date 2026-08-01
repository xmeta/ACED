import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readTask } from "../core/contracts.js";
import { currentBranch } from "../core/git.js";
import { taskBootstrapManagedContractPaths } from "../core/managed-contract-paths.js";
import { resolveFrom, specPath, taskPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { syncRegistry } from "./registry-rebuild.js";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "goal";
}

export function buildStartArtifacts(goal: string): Record<string, string> {
  const stamp = Date.now().toString(36).toUpperCase();
  const specId = `SPEC-LITE-${stamp}`;
  const taskId = `SCWBS-DRAFT-${stamp}`;
  const nodeId = `node-${slug(goal)}`;
  return {
    [specPath(specId)]: stringifySimpleYaml({
      id: specId,
      type: "spec-contract",
      featureId: `F-${stamp}`,
      title: goal,
      status: "draft",
      version: "0.1.0",
      summary: goal,
      acceptanceCriteria: [`Define acceptance criteria for: ${goal}`]
    }),
    [`contracts/changesets/start-${stamp}.json`]: `${JSON.stringify({
      schemaVersion: "0.1.0",
      targetWbsId: "scwbs",
      changeSetId: `changeset-start-${stamp}`,
      author: "scwbs",
      reason: `Start lightweight SC-WBS flow for: ${goal}`,
      dryRun: true,
      operations: [{
        operationId: "op-001",
        operation: "addNode",
        node: {
          id: nodeId,
          parentId: "node-project",
          code: "draft",
          name: goal,
          type: "workPackage",
          status: "draft"
        },
        position: {
          mode: "last"
        }
      }]
    }, null, 2)}\n`,
    [taskPath(taskId)]: stringifySimpleYaml({
      id: taskId,
      type: "task-contract",
      wbsNodeId: nodeId,
      featureId: `F-${stamp}`,
      branchName: `task/${taskId}-${slug(goal)}`,
      allowedPaths: ["src/**", "tests/**", "docs/**", "contracts/**"],
      forbiddenPaths: ["wjs/**"],
      humanGateRequiredPaths: ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"],
      requiredChecks: ["test", "typecheck", "build"],
      doneCriteria: [`Plan and implement: ${goal}`],
      evidenceRequired: ["test-result", "typecheck-result", "build-result"],
      managedContractPaths: taskBootstrapManagedContractPaths(taskId, { specId })
    })
  };
}

export function runStart(root: string, goal: string): number {
  try {
    const { task } = readTask(root, goal);
    if (task) {
      const branch = currentBranch(root) ?? "(unknown)";
      const branchStatus = task.branchName === branch ? "ok" : "mismatch";
      const lines = [
        `Task: ${task.id}`,
        `Branch: ${branch}`,
        `Expected branch: ${task.branchName ?? "(none)"}`,
        `Branch status: ${branchStatus}`,
        `WBS node: ${task.wbsNodeId}`,
        `Contract lock: ${task.contractLock?.wbsScopeRevision ?? task.contractLock?.wbsRevision ?? "(none)"}`,
        `Global contract lock: ${task.contractLock?.wbsGlobalRevision ?? "(legacy or none)"}`,
        "Allowed paths:",
        ...task.allowedPaths.map((item) => `- ${item}`),
        "Forbidden paths:",
        ...task.forbiddenPaths.map((item) => `- ${item}`),
        "Human gate paths:",
        ...task.humanGateRequiredPaths.map((item) => `- ${item}`),
        "Stop if:",
        ...((task.stopIf ?? []).length > 0 ? (task.stopIf ?? []).map((item) => `- ${item}`) : ["- (none)"]),
        "Checks:",
        ...task.requiredChecks.map((item) => `- ${item}`)
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return branchStatus === "ok" ? 0 : 1;
    }

    const artifacts = buildStartArtifacts(goal);
    for (const [relativePath, content] of Object.entries(artifacts)) {
      const fullPath = resolveFrom(root, relativePath);
      if (existsSync(fullPath)) throw new Error(`${relativePath} already exists`);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      console.log(`created ${relativePath}`);
    }
    syncRegistry(root);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
