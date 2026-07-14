export type IssueSeverity = "error" | "warn";

export type Issue = {
  severity: IssueSeverity;
  code: string;
  message: string;
  fixCommand?: string;
};

export type RegistryContractType = "requirement" | "spec" | "spec-change" | "task" | "evidence" | "approval" | "review" | "block" | "adr";

export type RegistryContract = {
  id: string;
  type: RegistryContractType;
  path: string;
  status?: string;
  version?: string;
  featureId?: string;
  relatedTask?: string;
};

export type Registry = {
  projectId: string;
  contracts: RegistryContract[];
};

export type ApprovalStatus = "requested" | "approved" | "rejected";

export type SpecContractStatus = "draft" | "approved" | "superseded";
export type SpecChangeProposalStatus = "proposed" | "approved" | "rejected" | "superseded";

export type SpecContract = {
  id: string;
  type: "spec-contract";
  featureId: string;
  title: string;
  status: SpecContractStatus;
  version: string;
  summary?: string;
  sourcePaths?: string[];
  acceptanceCriteria: string[];
  approvedBy?: string;
  approvedAt?: string;
};

export type SpecChangeProposal = {
  id: string;
  type: "spec-change-proposal";
  status: SpecChangeProposalStatus;
  targetSpec: string;
  currentVersion: string;
  proposedVersion: string;
  taskId: string;
  level: 0 | 1 | 2;
  summary: string;
  rationale: string[];
  affectedPaths: string[];
  approval?: {
    required?: boolean;
    status?: ApprovalStatus;
  };
  risks?: string[];
  approvedBy?: string;
  approvedAt?: string;
};

export type TaskContract = {
  id: string;
  type: "task-contract";
  mode?: "lite";
  completionScope?: "node";
  completionTaskIds?: string[];
  wbsNodeId: string;
  featureId: string;
  branchName?: string;
  contractLock?: {
    lockVersion?: "2";
    wbsRevision?: string;
    wbsScopeRevision?: string;
    wbsGlobalRevision?: string;
    wbsNodeId?: string;
    specVersion?: string;
    specRevision?: string;
    createdAt?: string;
  };
  allowedPaths: string[];
  forbiddenPaths: string[];
  humanGateRequiredPaths: string[];
  stopIf?: string[];
  requiredChecks: string[];
  checkCoverageWaivers?: Array<{ check: string; reason: string }>;
  submoduleDependencies?: Array<{
    path: string;
    repository?: string;
    pullRequest?: string;
    upstreamRef?: string;
    checks?: Array<{
      name: string;
      status: string;
      url?: string;
    }>;
  }>;
  doneCriteria: string[];
  evidenceRequired: string[];
  /**
   * M2-019: concrete paths that are CLI-generated/managed contract files
   * (evidence, approvals, reviews, registry, the task's own contract file,
   * etc). Schema and semantic validation restrict these to known contracts.
   * These
   * are exempt from allowedPaths and the sensitive meta-file guard in
   * check-diff, because they are produced by trusted CLI commands rather
   * than free-form edits. This does not exempt forbiddenPaths or
   * humanGateRequiredPaths, which always take priority.
   */
  managedContractPaths?: string[];
};

export type CheckCoveragePolicy = {
  rules: Array<{ id: string; paths: string[]; requires: string[] }>;
};

export type EvidenceCheckStatus = "passed" | "failed" | "skipped";
export type EvidenceCheckSource = "ci" | "local" | "manual";

export type Evidence = {
  id: string;
  type: "evidence";
  taskId: string;
  commit?: string;
  subjectHeadCommit?: string;
  evidenceCommit?: string;
  diffHash?: string;
  git?: {
    branch?: string;
    base?: string;
    baseCommit?: string;
    changedFilesBasis?: "working-tree" | "branch-diff" | string;
    subjectHeadCommit?: string;
    diffHash?: string;
    headCommit?: string;
    pullRequest?: string;
  };
  changedFiles: string[];
  submodules?: Array<{
    path: string;
    repository: string;
    baseCommit: string;
    headCommit: string;
    changedFiles: string[];
    pullRequest?: string;
    upstreamRef: string;
    upstreamReachable: boolean;
    checks?: Array<{
      name: string;
      status: string;
      url?: string;
    }>;
  }>;
  checks: Array<{
    name: string;
    status: EvidenceCheckStatus;
    source?: EvidenceCheckSource | string;
    runId?: string;
    url?: string;
    command?: string;
    cacheKey?: string;
    exitStatus?: number;
    stdoutSummary?: string;
    stderrSummary?: string;
    executedAt?: string;
    verifiedBy?: string;
  }>;
  testQuality?: {
    assertionsAdded?: boolean;
    testsDisabled?: boolean;
    coverageDecreased?: boolean;
    notes?: string[];
  };
  notes?: string[];
};

export type ApprovalRecord = {
  id: string;
  type: "approval";
  taskId: string;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  headCommit?: string;
  diffHash?: string;
  pullRequest?: string;
  reason?: string;
  notes?: string[];
};

export type BlockRecord = {
  id: string;
  type: "block";
  taskId: string;
  status: "blocked" | "resolved";
  level: 1 | 2;
  category: "db" | "auth" | "permission" | "security" | "breaking-api" | "business-rule" | "human-gate" | "external-service" | "unknown";
  reason: string;
  requiredHumanDecision: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: "human";
  resolution?: string;
  history?: Array<{
    status: "blocked" | "resolved";
    at: string;
    reason: string;
    by: "ai-agent" | "human";
  }>;
};

export type ReviewRecord = {
  id: string;
  type: "review";
  taskId: string;
  status: "requested" | "approved" | "changes-requested" | "closed";
  reviewProfile: "self-review" | "independent-ai-review" | "human-review" | string;
  headCommit?: string;
  diffHash?: string;
  pullRequest?: string;
  groundTruth: string[];
  requestedReviewers?: Array<{
    role: string;
    user?: string;
    reason: string;
  }>;
  notes?: string[];
  reviewedBy?: string;
  reviewedAt?: string;
  findings?: string[];
};

export type Profile = "Lean" | "Standard" | "Strict";

export type Agent = "codex";

export type Language = "ja" | "en";

export type AiPacketFormat = "default" | "compact" | "codex" | "claude" | "cursor";

export type WbsNode = {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  type: "summary" | "deliverable" | "workPackage" | "activity" | "milestone";
  status?: "draft" | "planned" | "ready" | "inProgress" | "blocked" | "completed" | "cancelled";
  progressPercent?: number;
  outputs?: string[];
  owner?: string;
  assignees?: string[];
  acceptanceCriteria?: string[];
  tags?: string[];
  extensions?: Record<string, unknown>;
};

export type WbsRelation = {
  id: string;
  type: "dependsOn" | "blocks" | "produces" | "consumes" | "implementsRequirement" | "refinesBpmnTask" | "linkedToIssue" | "relatedTo";
  source: string;
  target: string;
  description?: string;
};

export type WbsArtifact = {
  id: string;
  name: string;
  type: string;
  uri?: string;
  description?: string;
};

export type WbsResource = {
  id: string;
  name: string;
  type: string;
};

export type WbsDocument = {
  schemaVersion: string;
  id: string;
  name: string;
  description?: string;
  rootId: string;
  nodes: WbsNode[];
  relations?: WbsRelation[];
  resources?: WbsResource[];
  artifacts?: WbsArtifact[];
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};
