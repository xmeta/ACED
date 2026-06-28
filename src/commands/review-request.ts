import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readTask } from "../core/contracts.js";
import { evidencePath, resolveFrom, reviewPath, taskPath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { ReviewRecord } from "../core/types.js";

export function buildReviewRequest(taskId: string, options: { pullRequest?: string }): ReviewRecord {
  return {
    id: `RVW-${taskId}`,
    type: "review",
    taskId,
    status: "requested",
    reviewProfile: "independent-ai-review",
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    groundTruth: [
      taskPath(taskId),
      evidencePath(taskId)
    ]
  };
}

export function buildReviewRequestYaml(taskId: string, options: { pullRequest?: string }): string {
  return stringifySimpleYaml(buildReviewRequest(taskId, options) as unknown as Record<string, unknown>);
}

export function runReviewRequest(root: string, taskId: string, options: { pullRequest?: string; force: boolean }): number {
  try {
    const { task, issues } = readTask(root, taskId);
    if (!task) throw new Error(issues.map((issue) => issue.message).join("\n"));
    const relativePath = reviewPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const yaml = buildReviewRequestYaml(taskId, options);
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
