export type IssueSeverity = "error" | "warn";

export type Issue = {
  severity: IssueSeverity;
  code: string;
  message: string;
};

export type RegistryContractType = "requirement" | "spec" | "task" | "evidence" | "approval" | "adr";

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

export type TaskContract = {
  id: string;
  type: "task-contract";
  wbsNodeId: string;
  featureId: string;
  branchName?: string;
  contractLock?: {
    wbsRevision?: string;
    wbsNodeId?: string;
    specVersion?: string;
    specRevision?: string;
    createdAt?: string;
  };
  allowedPaths: string[];
  forbiddenPaths: string[];
  humanGateRequiredPaths: string[];
  requiredChecks: string[];
  doneCriteria: string[];
  evidenceRequired: string[];
};

export type EvidenceCheckStatus = "passed" | "failed" | "skipped";
export type EvidenceCheckSource = "ci" | "local" | "manual";

export type Evidence = {
  id: string;
  type: "evidence";
  taskId: string;
  commit?: string;
  git?: {
    branch?: string;
    base?: string;
    headCommit?: string;
    pullRequest?: string;
  };
  changedFiles: string[];
  checks: Array<{
    name: string;
    status: EvidenceCheckStatus;
    source?: EvidenceCheckSource | string;
    runId?: string;
    url?: string;
    command?: string;
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
  pullRequest?: string;
  notes?: string[];
};

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
