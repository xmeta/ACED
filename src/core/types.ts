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
  featureId?: string;
  relatedTask?: string;
};

export type Registry = {
  projectId: string;
  contracts: RegistryContract[];
};

export type TaskContract = {
  id: string;
  type: "task-contract";
  wbsNodeId: string;
  featureId: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  humanGateRequiredPaths: string[];
  requiredChecks: string[];
  doneCriteria: string[];
  evidenceRequired: string[];
};

export type EvidenceCheckStatus = "passed" | "failed" | "skipped";

export type Evidence = {
  id: string;
  type: "evidence";
  taskId: string;
  commit?: string;
  changedFiles: string[];
  checks: Array<{
    name: string;
    status: EvidenceCheckStatus;
    source?: string;
  }>;
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
