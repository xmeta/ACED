import { readTask } from "../core/contracts.js";
import { gitObject } from "../core/git.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, approvalDelegationTokenSha256, delegationPolicyFingerprint } from "../core/human-gate.js";
import { taskPath } from "../core/paths.js";
import { validateTaskContract, validateTaskContractSchema } from "../core/schema.js";
import type { ApprovalDelegationScope, ApprovalPolicy } from "../core/types.js";

export type ApprovalDelegationPrepareOptions = {
  scopes?: string;
  expiresAt?: string;
  source?: string;
  reason?: string;
  delegatedBy?: string;
};

type PrepareOutput = {
  version: "scwbs.approval-delegation-prepare.v1";
  taskId: string;
  policyPatch: { approvalPolicy: ApprovalPolicy };
  handoff: string[];
  governanceCostProxy: { manualInputsRequired: number; generatedFields: number; requiredContractOnlyCommits: 1; finishRetriesAdded: 0 };
};

function fail(message: string): number {
  console.error(`ERROR approval.delegation.prepare: ${message}`);
  return 1;
}

function parseScopes(value: string | undefined): ApprovalDelegationScope[] | undefined {
  if (!value) return undefined;
  const scopes = value.split(",").map((scope) => scope.trim()).filter(Boolean);
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) return undefined;
  if (!scopes.every((scope): scope is ApprovalDelegationScope => scope === "human-gate" || scope === "post-finish")) return undefined;
  return scopes;
}

export function buildApprovalDelegationPrepare(
  root: string,
  taskId: string,
  options: ApprovalDelegationPrepareOptions,
  token = process.env[APPROVAL_DELEGATION_TOKEN_ENV]
): { output?: PrepareOutput; error?: string } {
  const { task, issues } = readTask(root, taskId);
  if (!task) return { error: issues.map((issue) => issue.message).join("; ") };
  if (gitObject(root, "HEAD", taskPath(taskId)) !== undefined) {
    return { error: "Task Contract is already committed; prepare only before the contract-only creation commit" };
  }
  if (task.approvalPolicy?.mode === "delegated") return { error: "Task Contract already contains a delegated policy; existing authority is never changed" };
  if (!token) return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} is required from an external secret transport` };
  if (Buffer.byteLength(token, "utf8") < 32) return { error: `${APPROVAL_DELEGATION_TOKEN_ENV} must contain at least 32 UTF-8 bytes` };
  const scopes = parseScopes(options.scopes);
  if (!scopes) return { error: "--scopes must be a unique comma-separated subset of human-gate,post-finish" };
  const required = [options.expiresAt, options.source, options.reason, options.delegatedBy];
  if (required.some((value) => !value || value.trim().length === 0)) return { error: "--expires-at, --source, --reason, and --delegated-by are required" };
  const policy: ApprovalPolicy = {
    mode: "delegated",
    delegatedBy: options.delegatedBy!,
    delegatedTo: "ai-agent",
    scopes,
    source: options.source!,
    reason: options.reason!,
    expiresAt: options.expiresAt!,
    tokenSha256: approvalDelegationTokenSha256(token)
  };
  if (!Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= Date.now()) return { error: "--expires-at must be a future UTC timestamp" };
  const candidate = { ...task, approvalPolicy: policy };
  const validation = [...validateTaskContractSchema(candidate, taskPath(taskId)), ...validateTaskContract(candidate, taskPath(taskId))];
  if (validation.length > 0) return { error: `generated policy is invalid: ${validation.map((issue) => issue.message).join("; ")}` };
  const fingerprint = delegationPolicyFingerprint(candidate);
  return {
    output: {
      version: "scwbs.approval-delegation-prepare.v1",
      taskId,
      policyPatch: { approvalPolicy: policy },
      handoff: [
        "Apply policyPatch to the uncommitted Task Contract, then run task lock and make exactly one contract-only creation commit.",
        `Inject ${APPROVAL_DELEGATION_TOKEN_ENV} through shell, CI secret store, or an explicitly loaded .env transport; scwbs never auto-loads .env.`,
        `Reconfirm policy fingerprint sha256:${fingerprint} without exposing the token.`,
        `Human Gate: npm run scwbs -- approval approve --task ${taskId} --actor delegated-ai --scope human-gate`,
        `Post-finish: npm run scwbs -- approval approve --task ${taskId} --actor delegated-ai --scope post-finish`
      ],
      governanceCostProxy: { manualInputsRequired: 5, generatedFields: 3, requiredContractOnlyCommits: 1, finishRetriesAdded: 0 }
    }
  };
}

export function runApprovalDelegationPrepare(root: string, taskId: string, options: ApprovalDelegationPrepareOptions): number {
  const result = buildApprovalDelegationPrepare(root, taskId, options);
  if (!result.output) return fail(result.error ?? "could not prepare delegation");
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  return 0;
}
