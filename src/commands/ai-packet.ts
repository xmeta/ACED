import { existsSync } from "node:fs";
import { readEvidence, readTask } from "../core/contracts.js";
import { defaultWbsPath, resolveFrom, profileRequiredDirs } from "../core/paths.js";
import { readProfile } from "./profile.js";
import { findNode, readWbs } from "../core/wbs.js";
import type { AiPacketFormat, Profile, WbsDocument, WbsNode } from "../core/types.js";
import type { TaskContract } from "../core/types.js";
import { checkCoverageSummaryForAllowedPaths, readCheckCoveragePolicy } from "../core/check-coverage.js";

function submodulePacket(root: string, task: TaskContract): string {
  const evidence = readEvidence(root, task.id).evidence;
  const entries = evidence?.submodules ?? (task.submoduleDependencies ?? []).map((item) => ({
    ...item,
    baseCommit: "pending collection",
    headCommit: "pending collection",
    changedFiles: [],
    upstreamRef: item.upstreamRef ?? "refs/remotes/origin/HEAD",
    upstreamReachable: false
  }));
  if (entries.length === 0) return "## Submodule Dependencies\n- None";
  return `## Submodule Dependencies\n${entries.map((item) => [
    `- ${item.path} | ${item.repository}`,
    `  dependentPullRequest: ${item.pullRequest ?? "not recorded"}`,
    `  mergeOrder: ${item.pullRequest ? `${item.pullRequest} before parent PR` : "record upstream PR before parent merge"}`,
    `  upstreamReachable: ${item.upstreamReachable}`,
    `  upstreamRef: ${item.upstreamRef}`,
    `  commits: ${item.baseCommit} -> ${item.headCommit}`,
    ...((item.checks ?? []).map((check) => `  check: ${check.name} = ${check.status}`))
  ].join("\n")).join("\n")}`;
}

function checkCoveragePacket(root: string, task: TaskContract): string {
  const { policy, issues } = readCheckCoveragePolicy(root);
  if (issues.length > 0) return `## Check Coverage\n- Policy error: ${issues.map((issue) => issue.message).join("; ")}`;
  const summary = checkCoverageSummaryForAllowedPaths(policy, task);
  return `## Check Coverage
Required by allowed paths:
${summary.required.map((item) => `- ${item}`).join("\n") || "- None"}
Missing from Task Contract:
${summary.missing.map((item) => `- ${item}`).join("\n") || "- None"}`;
}

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

function subtreePhase(wbs: WbsDocument, node: WbsNode): "bootstrap" | "normal" | "unspecified" {
  let current: WbsNode | undefined = node;

  while (current) {
    const scwbs = current.extensions?.scwbs;
    const phase = typeof scwbs === "object" && scwbs !== null ? (scwbs as Record<string, unknown>).phase : undefined;
    if (phase === "bootstrap" || phase === "normal") return phase;
    current = current.parentId ? findNode(wbs, current.parentId) : undefined;
  }

  return "unspecified";
}

export function buildAiPacket(root: string, taskId: string, relationDepth = 1, format: AiPacketFormat = "default"): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }

  const profile: Profile = readProfile(root);
  const artifactDirs = profileRequiredDirs(profile);

  if (!existsSync(resolveFrom(root, defaultWbsPath))) {
    return `# AI Work Packet

## Role
Implementation Agent

## Task
${task.id} ${task.doneCriteria[0] ?? ""}

## Profile
- Profile: ${profile}
- Active artifact directories: ${artifactDirs.join(", ")}

## WBS Node
- Node ID: ${task.wbsNodeId}
- Status: WBS document not present; use Task Contract and tasks index as ground truth.
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

${checkCoveragePacket(root, task)}

${submodulePacket(root, task)}

## Context Filter
- Profile: ${profile}
- Active artifact directories: ${artifactDirs.join(", ")}
- Relation depth: ${Math.max(0, relationDepth)}
- Included WBS nodes: 0
- Rule: WBS-less packet uses the Task Contract only.

## Stop Conditions
- DBスキーマ変更が必要
- 認証・権限変更が必要
- API契約の破壊的変更が必要
- Business Ruleが不足している
- allowedPaths外の変更が必要
`;
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

  const header = format === "default" ? "# AI Work Packet" : `# AI Work Packet (${format})`;
  const formatHint = format === "codex"
    ? "\n## Agent Notes\n- Run the validation commands exactly.\n- Keep edits inside Allowed Paths.\n"
    : format === "compact"
      ? "\n## Agent Notes\n- Compact packet: prioritize Task, Scope, Paths, Checks, Stop Conditions.\n"
      : format === "claude"
        ? "\n## Agent Notes\n- Include reasoning in the review summary and preserve SC-WBS constraints.\n"
        : format === "cursor"
          ? "\n## Agent Notes\n- Use Allowed Paths as the editing file set.\n"
          : "";

  return `${header}

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

## Profile
- Profile: ${profile}
- Active artifact directories: ${artifactDirs.join(", ")}

## Subtree Phase
- Phase: ${subtreePhase(wbs, node)}

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
${checkCoveragePacket(root, task)}
${submodulePacket(root, task)}
${formatHint}

## Depends On
${dependsOn.map((item) => `- ${item}`).join("\n") || "- None"}

## Context Filter
- Profile: ${profile}
- Active artifact directories: ${artifactDirs.join(", ")}
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

export function buildTinyPacket(root: string, taskId: string): string {
  const { task, issues } = readTask(root, taskId);
  if (!task) {
    throw new Error(issues.map((issue) => issue.message).join("\n"));
  }
  const profile: Profile = readProfile(root);
  const artifactDirs = profileRequiredDirs(profile);

  if (!existsSync(resolveFrom(root, defaultWbsPath))) {
    return `# Tiny Packet
Task: ${task.id}
Node: ${task.wbsNodeId}
Profile: ${profile}
Artifact dirs: ${artifactDirs.join(", ")}
Objective:
${task.doneCriteria.map((item) => `- ${item}`).join("\n") || "- Not specified"}
Allowed:
${task.allowedPaths.map((item) => `- ${item}`).join("\n") || "- None"}
Forbidden:
${task.forbiddenPaths.map((item) => `- ${item}`).join("\n") || "- None"}
Human Gate:
${task.humanGateRequiredPaths.map((item) => `- ${item}`).join("\n") || "- None"}
Checks:
${task.requiredChecks.map((item) => `- ${item}`).join("\n") || "- None"}
Coverage required:
${checkCoverageSummaryForAllowedPaths(readCheckCoveragePolicy(root).policy, task).required.map((item) => `- ${item}`).join("\n") || "- None"}
Coverage missing:
${checkCoverageSummaryForAllowedPaths(readCheckCoveragePolicy(root).policy, task).missing.map((item) => `- ${item}`).join("\n") || "- None"}
Next:
- npm run scwbs -- finish --task ${task.id}
- npm run scwbs -- block "reason" --task ${task.id}
`;
  }
  const wbs = readWbs(root);
  const node = findNode(wbs, task.wbsNodeId);
  if (!node) throw new Error(`${task.id} references missing WBS node: ${task.wbsNodeId}`);

  return `# Tiny Packet
Task: ${task.id}
Node: ${node.name}
Profile: ${profile}
Artifact dirs: ${artifactDirs.join(", ")}
Objective:
${task.doneCriteria.map((item) => `- ${item}`).join("\n") || "- Not specified"}
Allowed:
${task.allowedPaths.map((item) => `- ${item}`).join("\n") || "- None"}
Forbidden:
${task.forbiddenPaths.map((item) => `- ${item}`).join("\n") || "- None"}
Human Gate:
${task.humanGateRequiredPaths.map((item) => `- ${item}`).join("\n") || "- None"}
Checks:
${task.requiredChecks.map((item) => `- ${item}`).join("\n") || "- None"}
Coverage required:
${checkCoverageSummaryForAllowedPaths(readCheckCoveragePolicy(root).policy, task).required.map((item) => `- ${item}`).join("\n") || "- None"}
Coverage missing:
${checkCoverageSummaryForAllowedPaths(readCheckCoveragePolicy(root).policy, task).missing.map((item) => `- ${item}`).join("\n") || "- None"}
Next:
- npm run scwbs -- finish --task ${task.id}
- npm run scwbs -- block "reason" --task ${task.id}
`;
}

export function runAiPacket(root: string, taskId: string, relationDepth = 1, format: AiPacketFormat = "default"): number {
  try {
    process.stdout.write(buildAiPacket(root, taskId, relationDepth, format));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
