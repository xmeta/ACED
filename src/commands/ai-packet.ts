import { readTask } from "../core/contracts.js";
import { findNode, readWbs } from "../core/wbs.js";
import type { WbsDocument, WbsNode } from "../core/types.js";

function relationDepthNodes(wbs: WbsDocument, node: WbsNode, maxDepth: number): Set<string> {
  const selected = new Set<string>([node.id]);
  const queue: Array<{ id: string; depth: number }> = [{ id: node.id, depth: 0 }];
  const relations = wbs.relations ?? [];

  if (maxDepth >= 1 && node.parentId) {
    selected.add(node.parentId);
    for (const sibling of wbs.nodes.filter((candidate) => candidate.parentId === node.parentId)) selected.add(sibling.id);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth) continue;
    for (const relation of relations) {
      if (relation.source !== current.id && relation.target !== current.id) continue;
      const next = relation.source === current.id ? relation.target : relation.source;
      if (selected.has(next)) continue;
      selected.add(next);
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }

  return selected;
}

export function buildAiPacket(root: string, taskId: string, relationDepth = 1): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }
  const wbs = readWbs(root);
  const node = findNode(wbs, task.wbsNodeId);
  if (!node) throw new Error(`${task.id} references missing WBS node: ${task.wbsNodeId}`);

  const selectedNodes = relationDepthNodes(wbs, node, Math.max(0, relationDepth));
  const relatedRelations = (wbs.relations ?? []).filter((relation) => selectedNodes.has(relation.source) && selectedNodes.has(relation.target));
  const dependsOn = relatedRelations
    .filter((relation) => relation.type === "dependsOn" && relation.source === node.id)
    .map((relation) => findNode(wbs, relation.target)?.name ?? relation.target);
  const artifacts = (node.outputs ?? [])
    .map((artifactId) => (wbs.artifacts ?? []).find((artifact) => artifact.id === artifactId))
    .filter((artifact) => artifact !== undefined);

  return `# AI Work Packet

## Role
Implementation Agent

## Task
${task.id} ${node.name}

## WBS Node
- Node ID: ${node.id}
- Code: ${node.code}
- Type: ${node.type}
- Status: ${node.status ?? "planned"}
- Feature: ${task.featureId}

## Scope
${task.doneCriteria.length === 0 ? "- Not specified" : task.doneCriteria.map((item) => `- ${item}`).join("\n")}

## Allowed Paths
${task.allowedPaths.map((item) => `- ${item}`).join("\n") || "- None"}

## Forbidden Paths
${task.forbiddenPaths.map((item) => `- ${item}`).join("\n") || "- None"}

## Human Gate Required Paths
${task.humanGateRequiredPaths.map((item) => `- ${item}`).join("\n") || "- None"}

## Required Checks
${task.requiredChecks.map((item) => `- ${item}`).join("\n") || "- None"}

## Depends On
${dependsOn.map((item) => `- ${item}`).join("\n") || "- None"}

## Context Filter
- Relation depth: ${Math.max(0, relationDepth)}
- Included WBS nodes: ${selectedNodes.size}
- Rule: include the target task first, then only nearby parent, sibling, dependency, and blocker context unless a larger depth is explicitly requested.

## Related Relations
${relatedRelations.map((relation) => `- ${relation.type}: ${relation.source} -> ${relation.target}`).join("\n") || "- None"}

## Output Artifacts
${artifacts.map((artifact) => `- ${artifact.id}: ${artifact.name}${artifact.uri ? ` (${artifact.uri})` : ""}`).join("\n") || "- None"}

## Stop Conditions
- DBスキーマ変更が必要
- 認証・権限変更が必要
- API契約の破壊的変更が必要
- Business Ruleが不足している
- allowedPaths外の変更が必要
- 仕様変更レベル判断に迷う場合はLevel 2として扱う
- Human Gate対象変更はLevel 0またはLevel 1に見えても停止する
`;
}

export function runAiPacket(root: string, taskId: string, relationDepth = 1): number {
  try {
    process.stdout.write(buildAiPacket(root, taskId, relationDepth));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
