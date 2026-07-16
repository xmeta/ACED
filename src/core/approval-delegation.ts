import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ApprovalDelegationScope, ApprovalRecord, Issue, TaskContract } from "./types.js";

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

function policyFingerprint(task: TaskContract): string {
  const policy = task.approvalPolicy;
  if (!policy || policy.mode !== "delegated") return "human-only";
  return createHash("sha256").update(JSON.stringify({
    ...policy,
    scopes: [...policy.scopes].sort()
  }), "utf8").digest("hex");
}

function proofPayload(task: TaskContract, input: DelegationProofInput): string {
  return ["scwbs-delegated-approval-v1", task.id, input.scope, input.headCommit, input.diffHash, input.approvedAt, policyFingerprint(task)].join("\0");
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
  if (!policy || policy.mode !== "delegated") {
    return { error: `${task.id} does not have a delegated approval policy` };
  }
  if (!scope) {
    return { error: "delegated approval requires --scope human-gate or --scope post-finish" };
  }
  if (!policy.scopes.includes(scope)) {
    return { error: `${task.id} delegation does not allow ${scope} approval` };
  }
  const expiresAt = Date.parse(policy.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= (options.now ?? new Date()).getTime()) {
    return { error: `${task.id} approval delegation is expired` };
  }
  if (!options.token) {
    return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} is required for delegated approval` };
  }
  if (Buffer.byteLength(options.token, "utf8") < 32) {
    return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} must contain at least 32 UTF-8 bytes` };
  }
  const actualHash = approvalDelegationTokenSha256(options.token);
  if (!hashesEqual(actualHash, policy.tokenSha256)) {
    return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} does not match the Task Contract delegation` };
  }
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
  if (approval.delegationScope !== requiredScope || !policy.scopes.includes(requiredScope)) {
    add("approval.delegation.scope", `${task.id} requires delegated ${requiredScope} approval`);
  }
  if (approval.delegationSource !== policy.source || approval.delegatedBy !== policy.delegatedBy || approval.executedBy !== "ai-agent" || approval.approvedBy !== `delegated:${policy.delegatedBy}`) {
    add("approval.delegation.provenance", `${task.id} delegated Approval does not match its Task policy provenance`);
  }
  const approvedAt = approval.approvedAt ? Date.parse(approval.approvedAt) : Number.NaN;
  const expiresAt = Date.parse(policy.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt) || approvedAt > expiresAt) {
    add("approval.delegation.expiry", `${task.id} delegated Approval was not issued within its policy lifetime`);
  }
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
  if (!hashesEqual(approval.delegationProof, expectedProof)) {
    add("approval.delegation.proof", `${task.id} delegated Approval proof is invalid`);
  }
  return issues;
}
