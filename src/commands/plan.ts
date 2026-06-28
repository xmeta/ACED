import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readSpec } from "../core/contracts.js";
import { resolveFrom, taskPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";

export function runPlan(root: string, specId: string): number {
  try {
    const specRelativePath = specId.includes("/") ? specId : `contracts/specs/${specId}.yaml`;
    const { spec, issues } = readSpec(root, specRelativePath);
    if (!spec) throw new Error(issues.map((issue) => issue.message).join("\n"));
    const base = spec.id.replace(/^SPEC-/, "WBS-");
    const tasks = [
      ["001", "Confirm contract and paths"],
      ["002", "Implement behavior"],
      ["003", "Add verification"],
      ["004", "Update documentation"]
    ];
    const changeSetPath = `contracts/changesets/plan-${spec.id}.json`;
    const changeSet = {
      schemaVersion: "0.1.0",
      targetWbsId: "scwbs",
      changeSetId: `changeset-plan-${spec.id}`,
      author: "scwbs",
      reason: `Plan tasks for ${spec.id}`,
      dryRun: true,
      operations: tasks.map(([suffix, title], index) => ({
        operationId: `op-${String(index + 1).padStart(3, "0")}`,
        operation: "addNode",
        node: {
          id: `node-${base.toLowerCase()}-${suffix}`,
          parentId: "node-project",
          code: `draft.${Number(suffix)}`,
          name: title,
          type: "workPackage",
          status: "draft"
        },
        position: {
          mode: "last"
        }
      }))
    };
    const fullChangeSetPath = resolveFrom(root, changeSetPath);
    if (existsSync(fullChangeSetPath)) throw new Error(`${changeSetPath} already exists`);
    mkdirSync(path.dirname(fullChangeSetPath), { recursive: true });
    writeFileSync(fullChangeSetPath, `${JSON.stringify(changeSet, null, 2)}\n`, "utf8");
    console.log(`created ${changeSetPath}`);
    for (const [suffix, title] of tasks) {
      const taskId = `${base}-${suffix}`;
      const relativePath = taskPath(taskId);
      const fullPath = resolveFrom(root, relativePath);
      if (existsSync(fullPath)) continue;
      writeFileSync(fullPath, stringifySimpleYaml({
        id: taskId,
        type: "task-contract",
        wbsNodeId: `node-${base.toLowerCase()}-${suffix}`,
        featureId: spec.featureId,
        allowedPaths: ["src/**", "tests/**", "docs/**", "contracts/**"],
        forbiddenPaths: ["wjs/**"],
        humanGateRequiredPaths: ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"],
        requiredChecks: ["test", "typecheck", "build"],
        doneCriteria: [title],
        evidenceRequired: ["test-result", "typecheck-result", "build-result"]
      }), "utf8");
      console.log(`created ${relativePath}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
