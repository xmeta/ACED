import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { approvalPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import type { ApprovalRecord } from "../core/types.js";

export function buildApprovalRequest(taskId: string, options: { pullRequest?: string; note?: string }): ApprovalRecord {
  return {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    status: "requested",
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.note ? { notes: [options.note] } : {})
  };
}

export function buildApprovalRequestYaml(taskId: string, options: { pullRequest?: string; note?: string }): string {
  return stringifySimpleYaml(buildApprovalRequest(taskId, options) as unknown as Record<string, unknown>);
}

export function runApprovalRequest(root: string, taskId: string, options: { pullRequest?: string; note?: string; force: boolean }): number {
  try {
    const relativePath = approvalPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }

    const yaml = buildApprovalRequestYaml(taskId, options);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
