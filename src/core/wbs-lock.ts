import { createHash } from "node:crypto";
import type { WbsArtifact, WbsDocument, WbsNode, WbsRelation } from "./types.js";
import { findNode } from "./wbs.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

function revision(value: unknown): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(canonical(value)));
  return `sha256:${hash.digest("hex")}`;
}

function addNodeAndAncestors(wbs: WbsDocument, nodeId: string, nodeIds: Set<string>): void {
  let current = findNode(wbs, nodeId);
  while (current && !nodeIds.has(current.id)) {
    nodeIds.add(current.id);
    current = current.parentId ? findNode(wbs, current.parentId) : undefined;
  }
}

export function buildWbsScopeSnapshot(wbs: WbsDocument, taskNodeId: string): {
  taskNodeId: string;
  nodes: WbsNode[];
  dependencies: WbsRelation[];
  artifactRelations: WbsRelation[];
  artifacts: WbsArtifact[];
} {
  if (!findNode(wbs, taskNodeId)) throw new Error(`missing WBS node: ${taskNodeId}`);
  const nodeIds = new Set<string>();
  const dependencySourceIds = new Set<string>([taskNodeId]);
  const queue = [taskNodeId];
  addNodeAndAncestors(wbs, taskNodeId, nodeIds);

  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const relation of wbs.relations ?? []) {
      if (relation.type !== "dependsOn" || relation.source !== source) continue;
      addNodeAndAncestors(wbs, relation.target, nodeIds);
      if (!dependencySourceIds.has(relation.target)) {
        dependencySourceIds.add(relation.target);
        queue.push(relation.target);
      }
    }
  }

  const dependencies = (wbs.relations ?? [])
    .filter((relation) => relation.type === "dependsOn" && dependencySourceIds.has(relation.source))
    .sort((left, right) => left.id.localeCompare(right.id));
  const nodes = wbs.nodes.filter((node) => nodeIds.has(node.id)).sort((left, right) => left.id.localeCompare(right.id));
  const artifactIds = new Set(nodes.flatMap((node) => node.outputs ?? []));
  const artifactRelations = (wbs.relations ?? [])
    .filter((relation) => (relation.type === "produces" || relation.type === "consumes") && (nodeIds.has(relation.source) || nodeIds.has(relation.target)))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const relation of artifactRelations) {
    if (!nodeIds.has(relation.source)) artifactIds.add(relation.source);
    if (!nodeIds.has(relation.target)) artifactIds.add(relation.target);
  }
  const artifacts = (wbs.artifacts ?? []).filter((artifact) => artifactIds.has(artifact.id)).sort((left, right) => left.id.localeCompare(right.id));
  return { taskNodeId, nodes, dependencies, artifactRelations, artifacts };
}

export function wbsScopeRevision(wbs: WbsDocument, taskNodeId: string): string {
  return revision(buildWbsScopeSnapshot(wbs, taskNodeId));
}

function globalAuthorityScwbsPolicy(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const policy = structuredClone(value) as Record<string, unknown>;
  const governanceCost = policy.governanceCost;
  if (!governanceCost || typeof governanceCost !== "object" || Array.isArray(governanceCost)) return policy;
  const authorityGovernanceCost = { ...(governanceCost as Record<string, unknown>) };
  delete authorityGovernanceCost.warningBudgets;
  if (Object.keys(authorityGovernanceCost).length === 0) delete policy.governanceCost;
  else policy.governanceCost = authorityGovernanceCost;
  return Object.keys(policy).length === 0 ? undefined : policy;
}

export function wbsGlobalRevision(wbs: WbsDocument): string {
  const scwbsPolicy = globalAuthorityScwbsPolicy(wbs.extensions?.scwbs);
  return revision({ schemaVersion: wbs.schemaVersion, wbsId: wbs.id, rootId: wbs.rootId, scwbsPolicy });
}
