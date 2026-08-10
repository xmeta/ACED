import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { matchesAny } from "./glob.js";
import { changedFilesBetween, isCommitAncestor } from "./git.js";
import { taskLifecycleMetadataPaths } from "./managed-contract-paths.js";
import { commandRemediation } from "./report.js";
import type { ApprovalDelegationScope, ApprovalRecord, Evidence, Issue, TaskContract } from "./types.js";

export const APPROVAL_DELEGATION_TOKEN_ENV = "SCWBS_APPROVAL_DELEGATION_TOKEN";

export type DelegatedApproval = {
  approvalMode: "delegated";
  approvedBy: string;
  delegationSource: string;
  delegatedBy: string;
  executedBy: "ai-agent";
  delegationScope: ApprovalDelegationScope;
};

type DelegationProofInput = {
  approvedAt: string;
  headCommit: string;
  diffHash: string;
  scope: ApprovalDelegationScope;
};

export function approvalDelegationTokenSha256(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function hashesEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function delegationPolicyFingerprint(task: TaskContract): string {
  const policy = task.approvalPolicy;
  if (!policy || policy.mode !== "delegated") return "human-only";
  return createHash("sha256").update(JSON.stringify({
    ...policy,
    scopes: [...policy.scopes].sort()
  }), "utf8").digest("hex");
}

function proofPayload(task: TaskContract, input: DelegationProofInput): string {
  return ["scwbs-delegated-approval-v1", task.id, input.scope, input.headCommit, input.diffHash, input.approvedAt, delegationPolicyFingerprint(task)].join("\0");
}

export function buildDelegationProof(task: TaskContract, token: string, input: DelegationProofInput): string {
  return `hmac-sha256:${createHmac("sha256", token).update(proofPayload(task, input), "utf8").digest("hex")}`;
}

export function authorizeDelegatedApproval(
  task: TaskContract,
  scope: ApprovalDelegationScope | undefined,
  options: { token?: string; now?: Date } = {}
): { approval?: DelegatedApproval; error?: string } {
  const policy = task.approvalPolicy;
  if (!policy || policy.mode !== "delegated") return { error: `${task.id} does not have a delegated approval policy` };
  if (!scope) return { error: "delegated approval requires --scope human-gate or --scope post-finish" };
  if (!policy.scopes.includes(scope)) return { error: `${task.id} delegation does not allow ${scope} approval` };
  const expiresAt = Date.parse(policy.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? new Date()).getTime()) return { error: `${task.id} approval delegation is expired` };
  if (!options.token) return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} is required for delegated approval` };
  if (Buffer.byteLength(options.token, "utf8") < 32) return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} must contain at least 32 UTF-8 bytes` };
  const actualHash = approvalDelegationTokenSha256(options.token);
  if (!hashesEqual(actualHash, policy.tokenSha256)) return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} does not match the Task Contract delegation` };
  return {
    approval: {
      approvalMode: "delegated",
      approvedBy: `delegated:${policy.delegatedBy}`,
      delegationSource: policy.source,
      delegatedBy: policy.delegatedBy,
      executedBy: "ai-agent",
      delegationScope: scope
    }
  };
}

export function validateDelegatedApproval(
  task: TaskContract,
  approval: ApprovalRecord,
  requiredScope: ApprovalDelegationScope,
  token = process.env[APPROVAL_DELEGATION_TOKEN_ENV]
): Issue[] {
  if (approval.approvalMode !== "delegated") return [];
  const policy = task.approvalPolicy;
  const issues: Issue[] = [];
  const add = (code: string, message: string): void => { issues.push({ severity: "error", code, message }); };
  if (!policy || policy.mode !== "delegated") {
    add("approval.delegation.policy", `${task.id} delegated Approval has no delegated Task policy`);
    return issues;
  }
  if (approval.delegationScope !== requiredScope || !policy.scopes.includes(requiredScope)) add("approval.delegation.scope", `${task.id} requires delegated ${requiredScope} approval`);
  if (approval.delegationSource !== policy.source || approval.delegatedBy !== policy.delegatedBy || approval.executedBy !== "ai-agent" || approval.approvedBy !== `delegated:${policy.delegatedBy}`) {
    add("approval.delegation.provenance", `${task.id} delegated Approval does not match its Task policy provenance`);
  }
  const approvedAt = approval.approvedAt ? Date.parse(approval.approvedAt) : Number.NaN;
  const expiresAt = Date.parse(policy.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > expiresAt) add("approval.delegation.expiry", `${task.id} delegated Approval was not issued within its policy lifetime`);
  if (!approval.headCommit || !approval.diffHash || !approval.approvedAt || !approval.delegationScope || !approval.delegationProof) {
    add("approval.delegation.proof", `${task.id} delegated Approval is missing its scoped proof fields`);
    return issues;
  }
  const authorization = authorizeDelegatedApproval(task, requiredScope, { token, now: new Date(approvedAt) });
  if (!authorization.approval || !token) {
    add("approval.delegation.token", authorization.error ?? `${APPROVAL_DELEGATION_TOKEN_ENV} is required to validate delegated Approval`);
    return issues;
  }
  const expectedProof = buildDelegationProof(task, token, {
    approvedAt: approval.approvedAt,
    headCommit: approval.headCommit,
    diffHash: approval.diffHash,
    scope: approval.delegationScope
  });
  if (!hashesEqual(approval.delegationProof, expectedProof)) add("approval.delegation.proof", `${task.id} delegated Approval proof is invalid`);
  return issues;
}

export type HumanGateValidation = {
  required: boolean;
  requiredFiles: string[];
  approved: boolean;
  issues: Issue[];
};

export function validateHumanApprovalProvenance(approval: ApprovalRecord, required: boolean): Issue[] {
  if (!required || approval.approvalMode === "delegated") return [];
  const provenanceKeys = ["actorId", "actorSource", "actorUrl", "verifiedAt", "verificationLevel"] as const;
  // Existing approved records predate Standard provenance. Preserve those immutable
  // historical records; any newly written PR-bound Approval is verified at creation.
  if (!provenanceKeys.some((key) => approval[key] !== undefined)) return [];
  const issues: Issue[] = [];
  const add = (code: string, message: string): void => { issues.push({ severity: "error", code, message }); };
  for (const key of ["actorId", "actorSource", "verifiedAt", "verificationLevel"] as const) {
    if (!approval[key]) add("approval.provenance.missing", `Human Approval is missing verified ${key}`);
  }
  if (approval.actorSource !== "tty" || approval.verificationLevel !== "lean") {
    add("approval.provenance.level", "Human Approval requires lean interactive TTY provenance");
  }
  if (approval.actorId && approval.approvedBy !== approval.actorId) {
    add("approval.provenance.actor", "approvedBy must match the verified human actorId");
  }
  return issues;
}

function evidenceHead(evidence: Evidence): string | undefined {
  return evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit ?? evidence.commit;
}

function evidenceDiffHash(evidence: Evidence): string | undefined {
  return evidence.diffHash ?? evidence.git?.diffHash;
}

function isApprovalMetadataFile(taskId: string, file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return taskLifecycleMetadataPaths(taskId).includes(normalized);
}

export function validateHumanGateApproval(
  task: TaskContract,
  evidence: Evidence | undefined,
  approval: ApprovalRecord | undefined,
  changedFiles: string[] = evidence?.changedFiles ?? [],
  root?: string
): HumanGateValidation {
  const requiredFiles = changedFiles.filter((file) => matchesAny(file, task.humanGateRequiredPaths));
  if (requiredFiles.length === 0) {
    return { required: false, requiredFiles, approved: true, issues: [] };
  }

  const approvalCommand = `npm run scwbs -- approval approve --task ${task.id} --actor human --reason "Evidence and diff reviewed"`;
  const approvalRequestRemediation = commandRemediation(
    ["npm", "run", "scwbs", "--", "approval", "request", "--task", task.id],
    { owner: "human", safeToAutoRun: false }
  );
  const approvalRemediation = commandRemediation(
    ["npm", "run", "scwbs", "--", "approval", "approve", "--task", task.id, "--actor", "human", "--reason", "Evidence and diff reviewed"],
    { owner: "human", safeToAutoRun: false }
  );
  if (!approval) {
    return {
      required: true,
      requiredFiles,
      approved: false,
      issues: [{
        severity: "error",
        code: "approval.missing",
        message: `${task.id} changes Human Gate files but no approval record was found: ${requiredFiles.join(", ")}`,
        fixCommand: `npm run scwbs -- approval request --task ${task.id}`,
        remediation: approvalRequestRemediation
      }]
    };
  }

  if (approval.status !== "approved") {
    return {
      required: true,
      requiredFiles,
      approved: false,
      issues: [{
        severity: "error",
        code: "approval.status",
        message: `${task.id} changes Human Gate files but approval status is ${approval.status}`,
        fixCommand: approvalCommand,
        remediation: approvalRemediation
      }]
    };
  }

  const issues: Issue[] = [];
  issues.push(...validateHumanApprovalProvenance(approval, Boolean(evidence?.git?.pullRequest)));
  if (approval.approvalMode === "delegated") {
    issues.push(...validateDelegatedApproval(task, approval, "human-gate"));
  }
  const subjectHead = evidence ? evidenceHead(evidence) : undefined;
  const subjectDiffHash = evidence ? evidenceDiffHash(evidence) : undefined;
  const legacyUnscoped = evidence?.git?.changedFilesBasis === "legacy-recorded" || !subjectHead || !subjectDiffHash;
  if ((!approval.headCommit || !subjectHead) && !legacyUnscoped) {
    issues.push({
      severity: "error",
      code: "approval.scope.headCommit",
      message: `${task.id} approval and Evidence must record matching headCommit scope`,
      fixCommand: approvalCommand
    });
  } else if (approval.headCommit && subjectHead && approval.headCommit !== subjectHead) {
    let metadataOnlyDescendant = false;
    const matchingAuditableDiff = !legacyUnscoped
      && Boolean(approval.diffHash)
      && approval.diffHash === subjectDiffHash;
    if (root && matchingAuditableDiff && isCommitAncestor(root, approval.headCommit, subjectHead)) {
      try {
        const interveningFiles = changedFilesBetween(root, approval.headCommit, subjectHead);
        metadataOnlyDescendant = interveningFiles.every((file) => isApprovalMetadataFile(task.id, file));
      } catch {
        metadataOnlyDescendant = false;
      }
    }
    if (!metadataOnlyDescendant) {
      issues.push({
        severity: "error",
        code: "approval.scope.headCommit",
        message: `${task.id} approved headCommit is not a metadata-only ancestor of Evidence subjectHeadCommit`,
        fixCommand: approvalCommand
      });
    }
  }
  if ((!approval.diffHash || !subjectDiffHash) && !legacyUnscoped) {
    issues.push({
      severity: "error",
      code: "approval.scope.diffHash",
      message: `${task.id} approval and Evidence must record matching diffHash scope`,
      fixCommand: approvalCommand
    });
  } else if (approval.diffHash && subjectDiffHash && approval.diffHash !== subjectDiffHash) {
    issues.push({
      severity: "error",
      code: "approval.scope.diffHash",
      message: `${task.id} approved diffHash does not match Evidence diffHash`,
      fixCommand: approvalCommand
    });
  }

  return {
    required: true,
    requiredFiles,
    approved: issues.length === 0,
    issues: issues.map((issue) => issue.fixCommand === approvalCommand ? { ...issue, remediation: approvalRemediation } : issue)
  };
}
