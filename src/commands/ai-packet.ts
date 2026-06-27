import { readTask } from "../core/contracts.js";
import { findNode, readWbs } from "../core/wbs.js";

export function buildAiPacket(root: string, taskId: string): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }
  const wbs = readWbs(root);
  const node = findNode(wbs, task.wbsNodeId);
  if (!node) throw new Error(`${task.id} references missing WBS node: ${task.wbsNodeId}`);

  const relatedRelations = (wbs.relations ?? []).filter((relation) => relation.source === node.id || relation.target === node.id);
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

## Output Artifacts
${artifacts.map((artifact) => `- ${artifact.id}: ${artifact.name}${artifact.uri ? ` (${artifact.uri})` : ""}`).join("\n") || "- None"}

## Stop Conditions
- DBスキーマ変更が必要
- 認証・権限変更が必要
- API契約の破壊的変更が必要
- Business Ruleが不足している
- allowedPaths外の変更が必要
`;
}

export function runAiPacket(root: string, taskId: string): number {
  try {
    process.stdout.write(buildAiPacket(root, taskId));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
