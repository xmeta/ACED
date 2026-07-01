import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readApproval } from "../core/contracts.js";
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

export function buildApprovalApprove(taskId: string, options: { pullRequest?: string; reason?: string; approvedBy?: string; approvedAt?: string }): ApprovalRecord {
  return {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    status: "approved",
    approvedBy: options.approvedBy ?? "human",
    approvedAt: options.approvedAt ?? new Date().toISOString(),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.reason ? { reason: options.reason } : {})
  };
}

export function buildApprovalApproveYaml(taskId: string, options: { pullRequest?: string; reason?: string; approvedBy?: string; approvedAt?: string }): string {
  return stringifySimpleYaml(buildApprovalApprove(taskId, options) as unknown as Record<string, unknown>);
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

export function runApprovalApprove(root: string, taskId: string, options: { pullRequest?: string; reason?: string; approvedBy?: string; force: boolean }): number {
  try {
    const relativePath = approvalPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const { approval, issues } = readApproval(root, taskId);
    const missingApprovalOnly = issues.length === 1 && issues[0]?.code === "approval.missing";
    if (!missingApprovalOnly && !approval) {
      throw new Error(issues.map((issue) => issue.message).join("\n"));
    }
    if (approval?.status === "approved" && !options.force) {
      console.error(`${relativePath} is already approved; rerun with --force to overwrite`);
      return 1;
    }
    if (approval?.status === "rejected" && !options.force) {
      console.error(`${relativePath} is rejected; rerun with --force to approve anyway`);
      return 1;
    }

    const yaml = buildApprovalApproveYaml(taskId, {
      pullRequest: options.pullRequest ?? approval?.pullRequest,
      reason: options.reason,
      approvedBy: options.approvedBy
    });
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
