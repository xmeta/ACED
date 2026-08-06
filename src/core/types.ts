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
  active?: boolean;
  archivedAt?: string;
  version?: string;
  featureId?: string;
  relatedTask?: string;
};

export type Registry = {
  projectId: string;
  contracts: RegistryContract[];
};

export type TaskLifecycleStatus = "planned" | "active" | "blocked" | "reviewed" | "completed" | "cancelled" | "archived";

export type TaskPriority = "high" | "medium" | "low";

export type TaskIndexEntry = {
  id: string;
  path: string;
  branchName: string;
  wbsNodeId: string;
  status: TaskLifecycleStatus;
  dependsOn: string[];
  archivedAt?: string;
};

export type TaskIndex = {
  tasks: TaskIndexEntry[];
};

export type ApprovalStatus = "requested" | "approved" | "rejected";
export type ApprovalDelegationScope = "human-gate" | "post-finish";

export type ApprovalPolicy =
  | { mode: "human-only" }
  | {
      mode: "delegated";
      delegatedBy: string;
      delegatedTo: "ai-agent";
      scopes: ApprovalDelegationScope[];
      source: string;
      reason: string;
      expiresAt: string;
      tokenSha256: string;
    };

export type SpecContractStatus = "draft" | "approved" | "superseded";
export type SpecChangeProposalStatus = "proposed" | "approved" | "rejected" | "superseded";

export type PlanningWorkItem = {
  id: string;
  title: string;
  paths: string[];
  requiredChecks?: string[];
  doneCriteria?: string[];
};

export type SpecPlanning = {
  unresolvedDecisions?: string[];
  dependencies?: string[];
  gates?: string[];
  uncertainty?: "low" | "medium" | "high";
  probeIds?: string[];
  readyWindow?: PlanningWorkItem[];
  approachCandidates?: string[];
};

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
  planning?: SpecPlanning;
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
  priority?: TaskPriority;
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
    authorityMode?: "upstream-release";
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
  approvalPolicy?: ApprovalPolicy;
};

export type CheckCoverageClassification = "behavior-critical" | "unit-only";

export type CheckCoveragePolicy = {
  implementationRoots?: string[];
  rules: Array<{
    id: string;
    paths: string[];
    requires: string[];
    classification?: CheckCoverageClassification;
    rationale?: string;
  }>;
};

export type EvidenceCheckStatus = "passed" | "failed" | "skipped";
export type EvidenceCheckSource = "ci" | "local" | "manual";

export type CiReceiptJob = {
  name: string;
  checkNames: string[];
  jobId: string;
  conclusion: "success";
  url: string;
  workflowRunId: string;
  workflowPath: string;
};

export type CiReceipt = {
  schemaVersion: "1.0.0";
  repository: string;
  pullRequest: string;
  taskId: string;
  headCommit: string;
  baseRef: string;
  baseCommit: string;
  diffHash: string;
  authorityFingerprint: string;
  workflowPath: string;
  workflowRunId: string;
  workflowRunUrl: string;
  trustedCommit: string;
  retrievedAt: string;
  verifiedBy: "github-actions-provenance";
  jobs: CiReceiptJob[];
};

export type CoverageMetric = {
  total: number;
  covered: number;
  skipped: number;
  percent: number;
};

export type CoverageTestCounts = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
};

export type CoverageReceipt = {
  schemaVersion: "1.0.0";
  command: string;
  scope: string;
  repository?: string;
  taskId?: string;
  pullRequest?: string;
  subjectHeadCommit: string;
  workflowPath: ".github/workflows/scwbs.yml";
  workflowRunId: string;
  workflowRunUrl: string;
  artifactName: string;
  artifactDigest?: string;
  payloadDigest: string;
  testFiles: CoverageTestCounts;
  tests: CoverageTestCounts;
  metrics: {
    statements: CoverageMetric;
    branches: CoverageMetric;
    functions: CoverageMetric;
    lines: CoverageMetric;
  };
  skippedTests: Array<{ name: string; reason: string }>;
  generatedAt: string;
};

export type Evidence = {
  id: string;
  type: "evidence";
  taskId: string;
  commit?: string;
  subjectHeadCommit?: string;
  evidenceCommit?: string;
  diffHash?: string;
  provenance?: {
    schemaVersion: "1.0.0";
    subject: {
      commit: string;
      treeHash: string;
      diffHash: string;
      canonicalization: "git-diff-binary-v1";
    };
    retention: {
      mode: "git-object" | "patch-artifact" | "bundle";
      locator: string;
      manifestHash?: string;
    };
  };
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
  ciReceipt?: CiReceipt;
  coverageReceipt?: CoverageReceipt;
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
    durationMilliseconds?: number;
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
  requestedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  headCommit?: string;
  diffHash?: string;
  pullRequest?: string;
  reason?: string;
  approvalMode?: "human" | "delegated";
  actorId?: string;
  actorSource?: "github-review" | string;
  actorUrl?: string;
  verifiedAt?: string;
  verificationLevel?: "standard" | string;
  delegationSource?: string;
  delegatedBy?: string;
  executedBy?: "ai-agent";
  delegationScope?: ApprovalDelegationScope;
  delegationProof?: string;
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
  workMode?: "discovery" | "delivery";
  discovery?: WbsDiscoveryState;
  outputs?: string[];
  owner?: string;
  assignees?: string[];
  acceptanceCriteria?: string[];
  tags?: string[];
  extensions?: Record<string, unknown>;
};

export type DecisionReadiness = "notReady" | "conditionallyReady" | "ready";
export type DownstreamInputQuality = "draft" | "reviewable" | "approved";

export type WbsDiscoveryState = {
  factsLearned: string[];
  hypothesesRejected: string[];
  openUnknowns: string[];
  blockingUnknowns: string[];
  decisionReadiness: DecisionReadiness;
  downstreamInputQuality: DownstreamInputQuality;
  exitConditions: string[];
  exitConditionsMet: boolean;
  nextDecision: string;
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
