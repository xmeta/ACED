import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listTasks, readTask } from "../core/contracts.js";
import { resolveFrom, taskPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";

const STOP_WORDS = [/db/i, /database/i, /api/i, /auth/i, /permission/i, /security/i, /personal/i, /privacy/i, /business rule/i];

function nextLiteId(root: string): string {
  const count = listTasks(root).filter((entry) => entry.task?.mode === "lite" || entry.task?.id.startsWith("LITE-")).length + 1;
  return `LITE-${String(count).padStart(3, "0")}`;
}

export function runLiteTask(root: string, title: string): number {
  try {
    const taskId = nextLiteId(root);
    const relativePath = taskPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, stringifySimpleYaml({
      id: taskId,
      type: "task-contract",
      mode: "lite",
      wbsNodeId: "node-project",
      featureId: "F-SCWBS-LITE",
      allowedPaths: ["src/**", "tests/**", "docs/**"],
      forbiddenPaths: ["wjs/**"],
      humanGateRequiredPaths: ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"],
      requiredChecks: ["test"],
      doneCriteria: [title],
      evidenceRequired: ["test-result"]
    }), "utf8");
    console.log(`created ${relativePath}`);
    if (STOP_WORDS.some((pattern) => pattern.test(title))) {
      console.log("warning: Lite stop condition matched; use scwbs promote before implementation");
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runPromote(root: string, taskId: string): number {
  try {
    const { task, issues } = readTask(root, taskId);
    if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
    if (task.mode !== "lite" && !task.id.startsWith("LITE-")) {
      console.error(`${task.id} is not a lite task`);
      return 1;
    }
    const title = task.doneCriteria[0] ?? task.id;
    const unsafe = STOP_WORDS.some((pattern) => pattern.test(title));
    const specId = `SPEC-${task.id}`;
    const specRelativePath = `contracts/specs/${specId}.yaml`;
    if (!existsSync(resolveFrom(root, specRelativePath))) {
      writeFileSync(resolveFrom(root, specRelativePath), stringifySimpleYaml({
        id: specId,
        type: "spec-contract",
        featureId: task.featureId,
        title,
        status: "draft",
        version: "0.1.0",
        summary: title,
        acceptanceCriteria: task.doneCriteria
      }), "utf8");
      console.log(`created ${specRelativePath}`);
    }
    if (unsafe) {
      console.log(`Human Gate required: ${task.id} matches a Lite stop condition`);
      console.log(`Suggested command: scwbs approval request --task ${task.id} --note "Lite promotion requires human gate"`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
