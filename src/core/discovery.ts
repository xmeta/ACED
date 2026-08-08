import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { headCommit } from "./git.js";
import { listActiveTasks, listSpecs } from "./contracts.js";
import { defaultWbsPath, resolveFrom } from "./paths.js";
import { readJsonFile } from "./json.js";
import type { DecisionReadiness, DownstreamInputQuality, Issue, SpecContract, WbsDiscoveryState, WbsDocument } from "./types.js";
import { parseSimpleYaml, stringifySimpleYaml } from "./yaml.js";
import { validateDiscoveryProbe } from "./schema/discovery.js";

export type DiscoveryStatus = "proposed" | "active" | "concluded" | "inconclusive";
export type DiscoveryProbe = {
  schemaVersion: "1.0.0";
  id: string;
  type: "discovery-probe";
  status: DiscoveryStatus;
  question: string;
  hypotheses: string[];
  activities: string[];
  evidenceExpected: string[];
  unknowns: string[];
  timebox: string;
  costLimit: string;
  exitConditions: string[];
  nextDecision: string;
  deliveryTaskId?: string;
  createdAt?: string;
  startedAt?: string;
  concludedAt?: string;
  exitConditionsMet?: boolean;
  factsLearned?: string[];
  hypothesesRejected?: string[];
  remainingUnknowns?: string[];
};

export function classifyDecisionReadiness(
  exitConditionsMet: boolean,
  openUnknowns: string[],
  blockingUnknowns: string[]
): DecisionReadiness {
  if (!exitConditionsMet || blockingUnknowns.length > 0) return "notReady";
  return openUnknowns.length > 0 ? "conditionallyReady" : "ready";
}

export function discoveryStateFromProbe(probe: DiscoveryProbe): WbsDiscoveryState {
  const openUnknowns = probe.status === "concluded" ? (probe.remainingUnknowns ?? []) : probe.unknowns;
  const blockingUnknowns = probe.status === "concluded" ? [] : openUnknowns;
  const exitConditionsMet = probe.exitConditionsMet === true;
  const decisionReadiness = classifyDecisionReadiness(exitConditionsMet, openUnknowns, blockingUnknowns);
  const downstreamInputQuality: DownstreamInputQuality = decisionReadiness === "ready" ? "reviewable" : "draft";
  return {
    factsLearned: probe.factsLearned ?? [],
    hypothesesRejected: probe.hypothesesRejected ?? [],
    openUnknowns,
    blockingUnknowns,
    decisionReadiness,
    downstreamInputQuality,
    exitConditions: probe.exitConditions,
    exitConditionsMet,
    nextDecision: probe.nextDecision
  };
}

export function discoveryNextLine(id: string, state: Pick<WbsDiscoveryState, "decisionReadiness" | "blockingUnknowns" | "nextDecision">): string {
  return `- ${id} | ${state.decisionReadiness} | blockingUnknowns=${state.blockingUnknowns.length} | nextDecision=${state.nextDecision}`;
}

export const discoveryDirectory = "contracts/discovery";
const ID = /^PROBE-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function discoveryPath(id: string): string {
  if (!ID.test(id)) throw new Error("Invalid Discovery Probe id; expected PROBE-<safe-id>");
  return `${discoveryDirectory}/${id}.yaml`;
}

export function readDiscoveryProbe(root: string, id: string): { probe?: DiscoveryProbe; issues: Issue[] } {
  const relativePath = discoveryPath(id);
  const fullPath = resolveFrom(root, relativePath);
  if (!existsSync(fullPath)) {
    return { issues: [{ severity: "error", code: "discovery.missing", message: `${relativePath} does not exist` }] };
  }
  const value = parseSimpleYaml(readFileSync(fullPath, "utf8"));
  const issues = validateDiscoveryProbe(value, relativePath);
  return issues.length > 0 ? { issues } : { probe: value as DiscoveryProbe, issues };
}

export function listDiscoveryProbes(root: string): Array<{ path: string; probe?: DiscoveryProbe; issues: Issue[] }> {
  const directory = resolveFrom(root, discoveryDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".yaml")).sort().map((file) => {
    const relativePath = `${discoveryDirectory}/${file}`;
    const value = parseSimpleYaml(readFileSync(resolveFrom(root, relativePath), "utf8"));
    const issues = validateDiscoveryProbe(value, relativePath);
    return issues.length > 0 ? { path: relativePath, issues } : {
      path: relativePath,
      probe: value as DiscoveryProbe,
      issues
    };
  });
}

export function discoveryIssues(root: string): Issue[] {
  return listDiscoveryProbes(root).flatMap((entry) => [
    ...entry.issues,
    ...(entry.probe?.deliveryTaskId && entry.probe.status !== "concluded"
      ? [{
        severity: "error" as const,
        code: "discovery.delivery.blocked",
        message: `${entry.probe.deliveryTaskId} is blocked by ${entry.probe.id} status ${entry.probe.status}`
      }]
      : [])
  ]);
}

export function probesForTask(root: string, taskId: string): DiscoveryProbe[] {
  return listDiscoveryProbes(root)
    .flatMap((entry) => entry.probe ? [entry.probe] : [])
    .filter((probe) => probe.deliveryTaskId === taskId);
}

export function writeDiscoveryProbe(root: string, probe: DiscoveryProbe, overwrite = false): string {
  const relativePath = discoveryPath(probe.id);
  const fullPath = resolveFrom(root, relativePath);
  if (!overwrite && existsSync(fullPath)) throw new Error(`${relativePath} already exists`);
  const issues = validateDiscoveryProbe(probe, relativePath);
  if (issues.length > 0) throw new Error(issues.map((item) => item.message).join("\n"));
  mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporary = `${fullPath}.tmp-${process.pid}`;
  writeFileSync(temporary, stringifySimpleYaml(probe as unknown as Record<string, unknown>), "utf8");
  renameSync(temporary, fullPath);
  return relativePath;
}

export type DiscoveryRouteOutcome = "extend-existing" | "direct-candidate" | "single-spec" | "multi-spec" | "mixed" | "unknown";
export type DiscoveryRouteConfidence = "low" | "medium" | "high";
export type DiscoveryIssueReference = { id: string; status: "open" | "closed" | "unknown" };

export type DiscoveryRouteOptions = {
  parts?: string[];
  candidatePaths?: string[];
  issueReferences?: string[];
  dependencies?: string[];
};

type DiscoveryRouteSlice = {
  id: string;
  title: string;
  kind: Exclude<DiscoveryRouteOutcome, "unknown" | "multi-spec" | "mixed">;
  ownership: string;
  specId?: string;
  interfaces: string[];
  dependencies: string[];
  sharedAcceptance: string[];
  revalidationTrigger: string;
};

export type DiscoveryRoutingReport = {
  version: "scwbs.discovery-routing.v1";
  status: "proposal";
  goal: string;
  outcome: DiscoveryRouteOutcome;
  confidence: DiscoveryRouteConfidence;
  inventory: {
    specs: Array<{ id: string; title: string; status: string; sourcePaths: string[] }>;
    activeTasks: Array<{ id: string; wbsNodeId: string; branchName: string; status: string }>;
    wbsNodes: Array<{ id: string; code?: string; name: string; status: string }>;
    issueReferences: DiscoveryIssueReference[];
  };
  selectionReasons: string[];
  blockingUnknowns: string[];
  brief: {
    goal: string;
    inScope: string[];
    outOfScope: string[];
    unknowns: string[];
    boundaryCandidates: string[];
    existingReferences: string[];
    recommendedOutcome: DiscoveryRouteOutcome;
  };
  roadmap: {
    slices: DiscoveryRouteSlice[];
    sharedAcceptance: string[];
    revalidationTriggers: string[];
  };
  review: {
    contradictions: string[];
    duplicateResponsibilities: string[];
    cyclicDependencies: string[];
    interfaceMismatches: string[];
    unownedAcceptanceCriteria: string[];
  };
  provenance: {
    sourceHeadCommit: string | null;
    inventoryHash: string;
    inputHash: string;
    sourcePaths: string[];
  };
  nextAction: string;
};

const routeStopWords = new Set(["a", "an", "and", "for", "from", "into", "of", "or", "the", "to", "with"]);
const directCandidatePattern = /\b(cleanup|docs?|documentation|format|lint|rename|read[- ]?only|small|typo|warning)\b/i;
const riskyRoutePattern = /\b(auth|authentication|authorization|credential|database|external|human\s+gate|migration|release|breaking\s+api|payment|schema)\b/i;

function routeTokens(value: string): string[] {
  return Array.from(new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !routeStopWords.has(token))));
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function issueReferences(values: string[] = []): DiscoveryIssueReference[] {
  return values.map((value): DiscoveryIssueReference => {
    const match = value.trim().match(/^#?(\d+)(?::(open|closed))?$/i);
    const status: DiscoveryIssueReference["status"] = match?.[2]?.toLowerCase() === "open"
      ? "open"
      : match?.[2]?.toLowerCase() === "closed"
        ? "closed"
        : "unknown";
    return match ? { id: `#${match[1]}`, status } : { id: value.trim(), status: "unknown" };
  }).filter((reference) => reference.id.length > 0).sort((a, b) => a.id.localeCompare(b.id));
}

function specText(spec: SpecContract): string {
  return [spec.id, spec.title, spec.summary ?? "", spec.featureId, ...(spec.sourcePaths ?? [])].join(" ").toLowerCase();
}

function matchingSpecs(specs: SpecContract[], text: string): SpecContract[] {
  const tokens = routeTokens(text);
  return specs.filter((spec) => {
    const searchable = specText(spec);
    const matches = tokens.filter((token) => searchable.includes(token));
    return matches.length >= Math.max(1, Math.ceil(tokens.length / 4));
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function readWbsInventory(root: string): { nodes: Array<{ id: string; code?: string; name: string; status: string }>; issues: string[] } {
  const fullPath = resolveFrom(root, defaultWbsPath);
  if (!existsSync(fullPath)) return { nodes: [], issues: [`${defaultWbsPath} is missing`] };
  try {
    const wbs = readJsonFile<WbsDocument>(fullPath);
    return {
      nodes: wbs.nodes.map((node) => ({ id: node.id, ...(node.code ? { code: node.code } : {}), name: node.name, status: node.status ?? "unknown" })).sort((a, b) => a.id.localeCompare(b.id)),
      issues: []
    };
  } catch (error) {
    return { nodes: [], issues: [`${defaultWbsPath} could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function dependencyGraph(edges: string[] = [], sliceIds: string[]): { graph: Map<string, string[]>; unknowns: string[] } {
  const known = new Set(sliceIds);
  const graph = new Map(sliceIds.map((id) => [id, [] as string[]]));
  const unknowns: string[] = [];
  edges.forEach((edge) => {
    const [from, to] = edge.split(":").map((item) => item.trim());
    if (!from || !to || !known.has(from) || !known.has(to)) {
      unknowns.push(`Unknown roadmap dependency edge: ${edge}`);
      return;
    }
    graph.get(from)?.push(to);
  });
  return { graph, unknowns };
}

function cycleNodes(graph: Map<string, string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      cycles.add(id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    graph.get(id)?.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  graph.forEach((_dependencies, id) => visit(id));
  return Array.from(cycles).sort();
}

function acceptanceOverlap(left: string, right: string): number {
  const leftTokens = new Set(routeTokens(left));
  return routeTokens(right).filter((token) => leftTokens.has(token)).length;
}

export function buildDiscoveryRoutingReport(root: string, goal: string, options: DiscoveryRouteOptions = {}): DiscoveryRoutingReport {
  const normalizedGoal = goal.trim();
  const specEntries = listSpecs(root);
  const taskEntries = listActiveTasks(root);
  const wbs = readWbsInventory(root);
  const specs = specEntries.flatMap((entry) => entry.spec ? [entry.spec] : []).sort((a, b) => a.id.localeCompare(b.id));
  const activeTasks = taskEntries.flatMap((entry) => entry.task ? [{ id: entry.task.id, wbsNodeId: entry.task.wbsNodeId, branchName: entry.task.branchName ?? "", status: "active" }] : []).sort((a, b) => a.id.localeCompare(b.id));
  const references = issueReferences(options.issueReferences);
  const providedParts = (options.parts ?? []).map((part) => part.trim()).filter(Boolean);
  const parts = providedParts.length > 0 ? providedParts : normalizedGoal ? [normalizedGoal] : [];
  const blockingUnknowns = [...wbs.issues];
  if (normalizedGoal.length < 8) blockingUnknowns.push("Goal is too short to determine a bounded route");
  if (/\b(unknown|unclear|tbd|not sure)\b/i.test(normalizedGoal)) blockingUnknowns.push("Goal contains an unresolved routing unknown");
  const slices: DiscoveryRouteSlice[] = parts.map((part, index) => {
    const matches = matchingSpecs(specs, part);
    const kind: DiscoveryRouteSlice["kind"] = matches.length > 0 ? "extend-existing" : directCandidatePattern.test(part) && !riskyRoutePattern.test(part) ? "direct-candidate" : "single-spec";
    return {
      id: `slice-${index + 1}`,
      title: part,
      kind,
      ownership: kind === "extend-existing" ? matches.map((spec) => spec.id).join(", ") : kind === "direct-candidate" ? "delivery Task after human route review" : "new Spec proposal after human route review",
      ...(matches[0] ? { specId: matches[0].id } : {}),
      interfaces: Array.from(new Set(matches.flatMap((spec) => spec.sourcePaths ?? []).concat(options.candidatePaths ?? []))).sort(),
      dependencies: [],
      sharedAcceptance: matches.flatMap((spec) => spec.acceptanceCriteria).sort(),
      revalidationTrigger: "Re-run inventory and route hash after Spec, Task, WBS, or repository HEAD changes"
    };
  });
  const kinds = new Set(slices.map((slice) => slice.kind));
  let outcome: DiscoveryRouteOutcome = parts.length === 0 || blockingUnknowns.length > 0 ? "unknown" : slices.length > 1 ? kinds.size > 1 ? "mixed" : "multi-spec" : slices[0]?.kind ?? "unknown";
  const { graph, unknowns: dependencyUnknowns } = dependencyGraph(options.dependencies, slices.map((slice) => slice.id));
  const cycles = cycleNodes(graph);
  blockingUnknowns.push(...dependencyUnknowns);
  if (cycles.length > 0) {
    outcome = "unknown";
    blockingUnknowns.push(`Roadmap dependency cycle: ${cycles.join(", ")}`);
  }
  const matchedSpecs = Array.from(new Set(slices.flatMap((slice) => slice.specId ? [slice.specId] : []))).map((id) => specs.find((spec) => spec.id === id)).filter((spec): spec is SpecContract => Boolean(spec));
  const duplicateResponsibilities = matchedSpecs.flatMap((left, index) => matchedSpecs.slice(index + 1).flatMap((right) => {
    const sharedPaths = (left.sourcePaths ?? []).filter((sourcePath) => (right.sourcePaths ?? []).includes(sourcePath));
    return sharedPaths.length > 0 ? [`${left.id} and ${right.id} both own ${sharedPaths.join(", ")}`] : [];
  })).sort();
  const contradictions = matchedSpecs.flatMap((left, index) => matchedSpecs.slice(index + 1).flatMap((right) => left.acceptanceCriteria.flatMap((leftCriterion) => right.acceptanceCriteria.filter((rightCriterion) => {
    const leftNegative = /\b(must not|shall not|cannot|never)\b/i.test(leftCriterion);
    const rightNegative = /\b(must not|shall not|cannot|never)\b/i.test(rightCriterion);
    return leftNegative !== rightNegative && acceptanceOverlap(leftCriterion, rightCriterion) >= 2;
  }).map((rightCriterion) => `${left.id} and ${right.id} have conflicting acceptance: ${leftCriterion} / ${rightCriterion}`)))).sort();
  const interfaceMismatches = options.candidatePaths && new Set(options.candidatePaths).size !== options.candidatePaths.length
    ? ["Candidate interface paths contain duplicates"]
    : [];
  const ownedAcceptance = new Set(slices.flatMap((slice) => slice.sharedAcceptance));
  const unownedAcceptanceCriteria = matchedSpecs.flatMap((spec) => spec.acceptanceCriteria.filter((criterion) => !ownedAcceptance.has(criterion)).map((criterion) => `${spec.id}: ${criterion}`)).sort();
  const selectionReasons = outcome === "unknown"
    ? ["Routing is advisory only; resolve blocking unknowns with a bounded Probe before delivery"]
    : slices.map((slice) => slice.kind === "extend-existing" ? `${slice.title} matches existing Spec ${slice.specId}` : `${slice.title} classified as ${slice.kind} by bounded lexical routing signals`);
  const boundaryCandidates = Array.from(new Set([...slices.flatMap((slice) => slice.interfaces), ...(options.candidatePaths ?? [])])).sort();
  const existingReferences = matchedSpecs.map((spec) => spec.id).sort();
  const inventory = {
    specs: specs.map((spec) => ({ id: spec.id, title: spec.title, status: spec.status, sourcePaths: (spec.sourcePaths ?? []).slice().sort() })),
    activeTasks,
    wbsNodes: wbs.nodes,
    issueReferences: references
  };
  const input = { goal: normalizedGoal, parts, candidatePaths: (options.candidatePaths ?? []).slice().sort(), issueReferences: references, dependencies: (options.dependencies ?? []).slice().sort() };
  const roadmapSlices = slices.map((slice) => ({ ...slice, dependencies: graph.get(slice.id) ?? [] }));
  const brief = {
    goal: normalizedGoal,
    inScope: parts,
    outOfScope: ["Automatic Spec, Task, WBS, Approval, or Human Gate mutation", "External service, credential, and remote Git operations"],
    unknowns: blockingUnknowns,
    boundaryCandidates,
    existingReferences,
    recommendedOutcome: outcome
  };
  return {
    version: "scwbs.discovery-routing.v1",
    status: "proposal",
    goal: normalizedGoal,
    outcome,
    confidence: outcome === "unknown" ? "low" : blockingUnknowns.length > 0 ? "medium" : slices.length > 1 ? "high" : "medium",
    inventory,
    selectionReasons,
    blockingUnknowns,
    brief,
    roadmap: {
      slices: roadmapSlices,
      sharedAcceptance: Array.from(new Set(roadmapSlices.flatMap((slice) => slice.sharedAcceptance))).sort(),
      revalidationTriggers: ["Repository HEAD changes", "Referenced Spec, Task, WBS, or Issue state changes"]
    },
    review: {
      contradictions,
      duplicateResponsibilities,
      cyclicDependencies: cycles,
      interfaceMismatches,
      unownedAcceptanceCriteria
    },
    provenance: {
      sourceHeadCommit: headCommit(root) ?? null,
      inventoryHash: hashValue(inventory),
      inputHash: hashValue(input),
      sourcePaths: [defaultWbsPath, "contracts/specs", "contracts/tasks", "contracts/tasks/index.yaml"]
    },
    nextAction: outcome === "unknown"
      ? "Create or continue a bounded Discovery Probe; do not create a delivery Spec or Task"
      : outcome === "direct-candidate"
        ? "Human-review this low-risk route, then create a normal Task Contract before implementation"
        : "Human-review the route and boundaries, then create or update Spec proposals before delivery Tasks"
  };
}

export function runDiscoveryRoute(root: string, goal: string, options: DiscoveryRouteOptions & { json?: boolean } = {}): number {
  const report = buildDiscoveryRoutingReport(root, goal, options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log([
      `Discovery route: ${report.outcome} (${report.confidence})`,
      `Goal: ${report.goal}`,
      `Existing Specs: ${report.inventory.specs.map((spec) => spec.id).join(", ") || "none"}`,
      `Blocking unknowns: ${report.blockingUnknowns.length}`,
      `Next: ${report.nextAction}`,
      "No Spec, Task, WBS, Approval, or Human Gate files were changed."
    ].join("\n"));
  }
  return report.outcome === "unknown" ? 2 : 0;
}
