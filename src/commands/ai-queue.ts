import { listTasks, readTask } from "../core/contracts.js";
import { findNode, readWbs } from "../core/wbs.js";

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

export function runAiBlock(root: string, taskId: string, reason: string): number {
  try {
    process.stdout.write(buildBlockChangeSet(root, taskId, reason));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function buildNextTask(root: string): string {
  const wbs = readWbs(root);
  const nodesById = new Map(wbs.nodes.map((node) => [node.id, node]));
  const candidates = listTasks(root)
    .flatMap(({ task }) => {
      if (!task || task.humanGateRequiredPaths.length > 0) return [];
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
    return "No available planned tasks.\n";
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
