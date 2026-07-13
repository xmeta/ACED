import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evidenceExists, listTasks, readBlock, readTask } from "../core/contracts.js";
import { blockPath, defaultWbsPath, resolveFrom, specChangePath } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { findNode, readWbs } from "../core/wbs.js";
import type { BlockRecord, SpecChangeProposal } from "../core/types.js";
import { buildReviewQueue } from "./review-queue.js";

type BlockChangeSet = {
  schemaVersion: "0.1.0";
  targetWbsId: string;
  changeSetId: string;
  author: "ai-agent";
  reason: string;
  dryRun: true;
  operations: Array<{
    operationId: string;
    operation: "changeNodeStatus";
    nodeId: string;
    status: "blocked";
  }>;
};

function loadTaskAndNode(root: string, taskId: string) {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }
  const wbs = readWbs(root);
  const node = findNode(wbs, task.wbsNodeId);
  if (!node) throw new Error(`${task.id} references missing WBS node: ${task.wbsNodeId}`);
  return { task, wbs, node };
}

export function classifyBlockReason(reason: string): Pick<BlockRecord, "category" | "level" | "requiredHumanDecision"> {
  const lowered = reason.toLowerCase();
  if (/db|database|schema|migration/.test(lowered)) {
    return { category: "db", level: 2, requiredHumanDecision: "Decide database schema or migration scope before implementation continues." };
  }
  if (/auth|authentication|authorization|permission|権限|認証/.test(lowered)) {
    return { category: /permission|権限/.test(lowered) ? "permission" : "auth", level: 2, requiredHumanDecision: "Decide authentication or permission design before implementation continues." };
  }
  if (/security|secret|personal|pii|個人情報|セキュリティ/.test(lowered)) {
    return { category: "security", level: 2, requiredHumanDecision: "Decide security or privacy handling before implementation continues." };
  }
  if (/breaking|api|破壊/.test(lowered)) {
    return { category: "breaking-api", level: 2, requiredHumanDecision: "Decide API compatibility and rollout policy before implementation continues." };
  }
  if (/business|rule|業務/.test(lowered)) {
    return { category: "business-rule", level: 2, requiredHumanDecision: "Decide the missing business rule before implementation continues." };
  }
  if (/external|service|billing|release|課金|外部|リリース/.test(lowered)) {
    return { category: "external-service", level: 2, requiredHumanDecision: "Decide external service, billing, or release impact before implementation continues." };
  }
  if (/human gate|human-gate|gate|人間|human/.test(lowered)) {
    return { category: "human-gate", level: 1, requiredHumanDecision: "Complete the required human gate decision before implementation continues." };
  }
  return { category: "unknown", level: 1, requiredHumanDecision: "Clarify the blocking decision before implementation continues." };
}

export function buildBlockRecord(taskId: string, reason: string, now = new Date().toISOString()): BlockRecord {
  const classified = classifyBlockReason(reason);
  return {
    id: `BLK-${taskId}`,
    type: "block",
    taskId,
    status: "blocked",
    ...classified,
    reason,
    createdAt: now,
    history: [{ status: "blocked", at: now, reason, by: "ai-agent" }]
  };
}

function blockHistory(block: BlockRecord): NonNullable<BlockRecord["history"]> {
  return block.history ?? [{ status: "blocked", at: block.createdAt, reason: block.reason, by: "ai-agent" }];
}

export function buildBlockRecordYaml(taskId: string, reason: string, now?: string, previous?: BlockRecord): string {
  const block = buildBlockRecord(taskId, reason, now);
  if (previous) block.history = [...blockHistory(previous), ...block.history!];
  return stringifySimpleYaml(block as unknown as Record<string, unknown>);
}

export function runHumanBlockResolve(root: string, taskId: string, reason: string, options: { now?: string; actor?: string } = {}): number {
  try {
    if ((options.actor ?? process.env.SCWBS_AGENT_MODE) === "ai") {
      console.error("AI execution mode cannot resolve Blocks; request a human decision instead");
      return 1;
    }
    const resolution = reason.trim();
    if (!resolution) throw new Error("Resolution reason must be a non-empty string");
    const { block, issues } = readBlock(root, taskId);
    if (!block) throw new Error(issues.map((item) => item.message).join("\n"));
    if (block.status === "resolved") throw new Error(`${taskId} block is already resolved`);
    const resolvedAt = options.now ?? new Date().toISOString();
    const resolved: BlockRecord = {
      ...block,
      status: "resolved",
      resolvedAt,
      resolvedBy: "human",
      resolution,
      history: [...blockHistory(block), { status: "resolved", at: resolvedAt, reason: resolution, by: "human" }]
    };
    const yaml = stringifySimpleYaml(resolved as unknown as Record<string, unknown>);
    writeFileSync(resolveFrom(root, blockPath(taskId)), yaml, "utf8");
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function buildBlockSpecChange(taskId: string, reason: string): SpecChangeProposal {
  const classified = classifyBlockReason(reason);
  return {
    id: `SCP-${taskId}-block`,
    type: "spec-change-proposal",
    status: "proposed",
    targetSpec: "TBD",
    currentVersion: "TBD",
    proposedVersion: "TBD",
    taskId,
    level: classified.level,
    summary: `Resolve block for ${taskId}`,
    rationale: [reason, classified.requiredHumanDecision],
    affectedPaths: [],
    approval: { required: classified.level === 2, status: "requested" },
    risks: ["Implementation must remain stopped until this proposal is resolved."]
  };
}

export function buildBlockChangeSet(root: string, taskId: string, reason: string): string {
  const { task, wbs, node } = loadTaskAndNode(root, taskId);
  const changeSet: BlockChangeSet = {
    schemaVersion: "0.1.0",
    targetWbsId: wbs.id,
    changeSetId: `changeset-block-${task.id}`,
    author: "ai-agent",
    reason,
    dryRun: true,
    operations: [
      {
        operationId: "op-001",
        operation: "changeNodeStatus",
        nodeId: node.id,
        status: "blocked"
      }
    ]
  };
  return `${JSON.stringify(changeSet, null, 2)}\n`;
}

export function runAiBlock(root: string, taskId: string, reason: string, options: { specChange?: boolean } = {}): number {
  try {
    const taskResult = readTask(root, taskId);
    if (!taskResult.task) throw new Error(taskResult.issues.map((issue) => issue.message).join("\n"));
    const relativePath = blockPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const previousResult = readBlock(root, taskId);
    const missingBlockOnly = previousResult.issues.length === 1 && previousResult.issues[0]?.code === "block.missing";
    if (!missingBlockOnly && !previousResult.block) {
      throw new Error(previousResult.issues.map((item) => item.message).join("\n"));
    }
    const previous = previousResult.block;
    const yaml = buildBlockRecordYaml(taskId, reason, undefined, previous);
    writeFileSync(fullPath, yaml, "utf8");
    process.stdout.write(yaml);
    if (options.specChange) {
      const specChange = buildBlockSpecChange(taskId, reason);
      const specChangeRelativePath = specChangePath(specChange.id);
      const specChangeFullPath = resolveFrom(root, specChangeRelativePath);
      mkdirSync(path.dirname(specChangeFullPath), { recursive: true });
      writeFileSync(specChangeFullPath, stringifySimpleYaml(specChange as unknown as Record<string, unknown>), "utf8");
      process.stdout.write(`\nSpec Change Proposal: ${specChangeRelativePath}\n`);
    }
    process.stdout.write(`\nHuman decision required: ${buildBlockRecord(taskId, reason).requiredHumanDecision}\n`);
    process.stdout.write("AI must stop implementation until the block is resolved.\n");
    if (existsSync(resolveFrom(root, defaultWbsPath))) {
      process.stdout.write("\nWBS block change-set preview:\n");
      process.stdout.write(buildBlockChangeSet(root, taskId, reason));
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function buildNextTask(root: string): string {
  if (!existsSync(resolveFrom(root, defaultWbsPath))) {
    const candidates = listTasks(root)
      .flatMap(({ task }) => task && !evidenceExists(root, task.id) && readBlock(root, task.id).block?.status !== "blocked" ? [{ taskId: task.id, nodeName: task.wbsNodeId, nodeCode: "WBS-less" }] : [])
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    if (candidates.length === 0) return "No available planned tasks.\n";
    const lines = ["Planned task candidates:", ...candidates.map((candidate) => `- ${candidate.taskId} | ${candidate.nodeName} | ${candidate.nodeCode}`)];
    return `${lines.join("\n")}\n`;
  }
  const wbs = readWbs(root);
  const nodesById = new Map(wbs.nodes.map((node) => [node.id, node]));
  const tasks = listTasks(root);
  const candidates = tasks
    .flatMap(({ task }) => {
      if (!task || task.humanGateRequiredPaths.length > 0) return [];
      if (evidenceExists(root, task.id)) return [];
      if (readBlock(root, task.id).block?.status === "blocked") return [];
      const node = findNode(wbs, task.wbsNodeId);
      if (!node) return [];
      const status = node.status ?? "planned";
      if (status !== "planned") return [];
      const dependencies = (wbs.relations ?? []).filter((relation) => relation.type === "dependsOn" && relation.source === node.id);
      if (dependencies.some((relation) => nodesById.get(relation.target)?.status !== "completed")) return [];
      return [{ taskId: task.id, nodeName: node.name, nodeCode: node.code }];
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  if (candidates.length === 0) {
    const hasMissingEvidence = tasks.some((entry) => entry.task && !evidenceExists(root, entry.task.id));
    const hasReviewCandidate = buildReviewQueue(root) !== "Review Queue:\n- None\n";
    const followUp = hasMissingEvidence || hasReviewCandidate
      ? "\nFollow-up work remains for existing contracts. Run `scwbs next` for Evidence or review guidance.\n"
      : "";
    return `No available planned tasks.${followUp}\n`;
  }

  const lines = ["Planned task candidates:", ...candidates.map((candidate) => `- ${candidate.taskId} | ${candidate.nodeName} | ${candidate.nodeCode}`)];
  return `${lines.join("\n")}\n`;
}

export function runAiNextTask(root: string): number {
  try {
    process.stdout.write(buildNextTask(root));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
