import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { validateApprovalRecord } from "../core/schema.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, authorizeDelegatedApproval, buildDelegationProof, buildHumanApprovalCommand } from "../core/human-gate.js";
import { approvalPath, defaultRegistryPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { syncRegistry } from "./registry-rebuild.js";
import { APPROVAL_V2_VERSION, type ApprovalDelegationScope, type ApprovalRecord, type ApprovalScopeRecord, type Evidence } from "../core/types.js";
import { detectCurrentPullRequest, normalizePullRequestNumber, pullRequestEvidenceCommand } from "./health.js";

export function buildApprovalRequest(taskId: string, options: { pullRequest?: string; note?: string; requestedAt?: string; scope?: ApprovalDelegationScope }): ApprovalRecord {
  const slot: ApprovalScopeRecord = {
    status: "requested",
    requestedAt: options.requestedAt ?? new Date().toISOString(),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.note ? { notes: [options.note] } : {})
  };
  if (options.scope) return buildV2Approval(taskId, options.scope, slot);
  return {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    status: "requested",
    requestedAt: slot.requestedAt,
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.note ? { notes: [options.note] } : {})
  };
}

function scopeSlot(approval: ApprovalRecord | undefined, scope: ApprovalDelegationScope): ApprovalScopeRecord | undefined {
  if (!approval) return undefined;
  if (approval.version === APPROVAL_V2_VERSION) return approval.scopeApprovals?.[scope];
  if (approval.approvalMode !== "delegated" || approval.delegationScope !== scope) return undefined;
  const excluded = new Set(["id", "type", "taskId", "version", "activeScope", "scopeApprovals"]);
  return Object.fromEntries(Object.entries(approval).filter(([key]) => !excluded.has(key))) as ApprovalScopeRecord;
}

function buildV2Approval(taskId: string, scope: ApprovalDelegationScope, slot: ApprovalScopeRecord, other: Partial<Record<ApprovalDelegationScope, ApprovalScopeRecord>> = {}): ApprovalRecord {
  return {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    version: APPROVAL_V2_VERSION,
    activeScope: scope,
    scopeApprovals: { ...other, [scope]: slot },
    ...slot
  };
}

function scopedApprovalSummary(approval: ApprovalRecord, scope: ApprovalDelegationScope): Record<string, unknown> {
  const slot = scopeSlot(approval, scope);
  if (!slot) throw new Error(`${approval.taskId} has no ${scope} Approval slot`);
  return {
    approvalId: approval.id,
    taskId: approval.taskId,
    version: APPROVAL_V2_VERSION,
    activeScope: scope,
    status: slot.status,
    ...(slot.requestedAt ? { requestedAt: slot.requestedAt } : {}),
    ...(slot.approvedAt ? { approvedAt: slot.approvedAt } : {}),
    ...(slot.pullRequest ? { pullRequest: slot.pullRequest } : {})
  };
}

function scopedSlots(existing: ApprovalRecord | undefined): Partial<Record<ApprovalDelegationScope, ApprovalScopeRecord>> {
  if (!existing) return {};
  if (existing.version === APPROVAL_V2_VERSION) return { ...(existing.scopeApprovals ?? {}) };
  if (existing.approvalMode !== "delegated" || !existing.delegationScope) return {};
  const imported = scopeSlot(existing, existing.delegationScope);
  return imported ? { [existing.delegationScope]: imported } : {};
}

export function buildApprovalRequestYaml(taskId: string, options: { pullRequest?: string; note?: string; requestedAt?: string; scope?: ApprovalDelegationScope }): string {
  return stringifySimpleYaml(buildApprovalRequest(taskId, options) as unknown as Record<string, unknown>);
}

const APPROVAL_REQUEST_JSON_VERSION = "scwbs.approval-request.v1" as const;
const MAX_JSON_NOTES = 3;
const MAX_JSON_NOTE_LENGTH = 512;
const MAX_JSON_ACTION_LENGTH = 512;

export type ApprovalRequestJson = {
  version: typeof APPROVAL_REQUEST_JSON_VERSION;
  approvalId: string;
  taskId: string;
  status: "requested";
  requestedAt: string;
  notes: string[];
  nextActionOwner: "human";
  nextAction: string;
  scope?: ApprovalDelegationScope;
  pullRequest?: string;
};

function boundedNotes(notes: string[] | undefined): string[] {
  return (notes ?? [])
    .slice(0, MAX_JSON_NOTES)
    .map((note) => note.slice(0, MAX_JSON_NOTE_LENGTH));
}

export function buildApprovalRequestJson(approval: ApprovalRecord, evidence?: Evidence): ApprovalRequestJson {
  const requestedAt = approval.requestedAt;
  if (!requestedAt) throw new Error("Approval request is missing requestedAt");
  const approvalCommand = buildHumanApprovalCommand(approval.taskId, evidence, approval.status, approval.version === APPROVAL_V2_VERSION ? approval.activeScope : undefined);
  const nextAction = approvalCommand
    ? `Review Evidence and diff, then run: ${approvalCommand}`
    : `Collect current Evidence with: npm run scwbs -- evidence collect --task ${approval.taskId} --force; then use the exact approval command printed by scwbs.`;
  return {
    version: APPROVAL_REQUEST_JSON_VERSION,
    approvalId: approval.id,
    taskId: approval.taskId,
    status: "requested",
    requestedAt,
    notes: boundedNotes(approval.notes),
    nextActionOwner: "human",
    nextAction: nextAction.slice(0, MAX_JSON_ACTION_LENGTH),
    ...(approval.version === APPROVAL_V2_VERSION && approval.activeScope ? { scope: approval.activeScope } : {}),
    ...(approval.pullRequest ? { pullRequest: approval.pullRequest } : {})
  };
}

type ApprovalRegistryAfterSync = (root: string) => void;

function writeApprovalAndSync(root: string, fullPath: string, yaml: string, afterRegistrySync?: ApprovalRegistryAfterSync): void {
  const registryPath = resolveFrom(root, defaultRegistryPath);
  const approvalExisted = existsSync(fullPath);
  const registryExisted = existsSync(registryPath);
  const previousApproval = approvalExisted ? readFileSync(fullPath, "utf8") : undefined;
  const previousRegistry = registryExisted ? readFileSync(registryPath, "utf8") : undefined;
  mkdirSync(path.dirname(fullPath), { recursive: true });
  try {
    writeFileSync(fullPath, yaml, "utf8");
    syncRegistry(root);
    afterRegistrySync?.(root);
  } catch (error) {
    if (approvalExisted && previousApproval !== undefined) writeFileSync(fullPath, previousApproval, "utf8");
    else if (existsSync(fullPath)) unlinkSync(fullPath);
    if (registryExisted && previousRegistry !== undefined) writeFileSync(registryPath, previousRegistry, "utf8");
    else if (existsSync(registryPath)) unlinkSync(registryPath);
    throw error;
  }
}

export function buildApprovalApprove(taskId: string, options: { scope?: ApprovalDelegationScope; requestedAt?: string; pullRequest?: string; reason?: string; approvedBy?: string; approvedAt?: string; headCommit?: string; diffHash?: string; approvalMode?: "human" | "delegated"; actorId?: string; actorSource?: string; actorUrl?: string; verifiedAt?: string; verificationLevel?: string; delegationSource?: string; delegatedBy?: string; executedBy?: "ai-agent"; delegationScope?: ApprovalDelegationScope; delegationProof?: string }): ApprovalRecord {
  const slot: ApprovalScopeRecord = {
    status: "approved",
    ...(options.requestedAt ? { requestedAt: options.requestedAt } : {}),
    approvedBy: options.approvedBy ?? "human",
    approvedAt: options.approvedAt ?? new Date().toISOString(),
    approvalMode: options.approvalMode ?? "human",
    ...(options.headCommit ? { headCommit: options.headCommit } : {}),
    ...(options.diffHash ? { diffHash: options.diffHash } : {}),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(options.actorSource ? { actorSource: options.actorSource } : {}),
    ...(options.actorUrl ? { actorUrl: options.actorUrl } : {}),
    ...(options.verifiedAt ? { verifiedAt: options.verifiedAt } : {}),
    ...(options.verificationLevel ? { verificationLevel: options.verificationLevel } : {}),
    ...(options.delegationSource ? { delegationSource: options.delegationSource } : {}),
    ...(options.delegatedBy ? { delegatedBy: options.delegatedBy } : {}),
    ...(options.executedBy ? { executedBy: options.executedBy } : {}),
    ...(options.delegationScope ? { delegationScope: options.delegationScope } : {}),
    ...(options.delegationProof ? { delegationProof: options.delegationProof } : {})
  };
  if (options.scope) return buildV2Approval(taskId, options.scope, slot);
  return { id: `APR-${taskId}`, type: "approval", taskId, ...slot };
}

type TtyHumanProvenance = Pick<ApprovalRecord, "actorId" | "actorSource" | "verifiedAt" | "verificationLevel">;

function verifyScopedHumanRejection(taskId: string, reason: string | undefined, scope: ApprovalDelegationScope): TtyHumanProvenance {
  if (!reason?.trim()) throw new Error("Human Approval rejection requires --reason");
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("Scoped human Approval rejection requires an interactive TTY");
  }
  let actorId: string;
  try {
    actorId = os.userInfo().username.trim();
  } catch {
    throw new Error(`Unable to verify the current OS user for ${taskId} ${scope} Approval rejection`);
  }
  if (!actorId) throw new Error(`The current OS user is unavailable for ${taskId} ${scope} Approval rejection`);
  return { actorId, actorSource: "tty", verifiedAt: new Date().toISOString(), verificationLevel: "lean" };
}

function verifyTtyHumanProvenance(taskId: string, evidence: Evidence, reason?: string, scope?: ApprovalDelegationScope): TtyHumanProvenance {
  const headCommit = evidence.subjectHeadCommit ?? evidence.git?.subjectHeadCommit ?? evidence.git?.headCommit ?? evidence.commit;
  const diffHash = evidence.diffHash ?? evidence.git?.diffHash;
  if (!headCommit || !diffHash) {
    throw new Error("Lean human approval requires Evidence subjectHeadCommit and diffHash");
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("Lean human approval requires an interactive TTY; approval remains unapproved");
  }
  let actorId: string;
  try {
    actorId = os.userInfo().username.trim();
  } catch {
    throw new Error("Unable to verify the current OS user for Lean human approval; approval remains unapproved");
  }
  if (!actorId) {
    throw new Error("The current OS user is unavailable for Lean human approval; approval remains unapproved");
  }
  const confirmation = scope
    ? `CONFIRM TTY APPROVAL ${taskId} ${scope} ${headCommit} ${diffHash}`
    : `CONFIRM TTY APPROVAL ${taskId} ${headCommit} ${diffHash}`;
  if (reason !== confirmation) {
    throw new Error(`Lean human approval requires exact TTY confirmation in --reason: ${confirmation}`);
  }
  return {
    actorId,
    actorSource: "tty",
    verifiedAt: new Date().toISOString(),
    verificationLevel: "lean"
  };
}

export function buildApprovalApproveYaml(taskId: string, options: Parameters<typeof buildApprovalApprove>[1]): string {
  return stringifySimpleYaml(buildApprovalApprove(taskId, options) as unknown as Record<string, unknown>);
}

function evidenceSubject(root: string, taskId: string): { headCommit?: string; diffHash?: string } {
  const { evidence } = readEvidence(root, taskId);
  return {
    headCommit: evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit,
    diffHash: evidence?.diffHash ?? evidence?.git?.diffHash
  };
}

export function runApprovalRequest(root: string, taskId: string, options: { pullRequest?: string; note?: string; force: boolean; json?: boolean; scope?: ApprovalDelegationScope; afterRegistrySync?: ApprovalRegistryAfterSync }): number {
  try {
    if (options.scope !== undefined && options.scope !== "human-gate" && options.scope !== "post-finish") {
      console.error("approval scope must be human-gate or post-finish");
      return 1;
    }
    const current = detectCurrentPullRequest(root);
    const evidencePullRequest = normalizePullRequestNumber(readEvidence(root, taskId).evidence?.git?.pullRequest);
    const requestedPullRequest = normalizePullRequestNumber(options.pullRequest);
    if (current && evidencePullRequest !== current.number) {
      console.error(`${taskId} current branch already has PR #${current.number}, but Evidence records ${evidencePullRequest ? `PR #${evidencePullRequest}` : "no PR"}`);
      console.error(`fixCommand: ${pullRequestEvidenceCommand(taskId, current.number)}`);
      return 1;
    }
    if (current && requestedPullRequest !== undefined && requestedPullRequest !== current.number) {
      console.error(`${taskId} approval request PR #${requestedPullRequest} does not match current branch PR #${current.number}`);
      console.error(`fixCommand: ${pullRequestEvidenceCommand(taskId, current.number)}`);
      return 1;
    }
    const relativePath = approvalPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const existingResult = readApproval(root, taskId);
    const existing = existingResult.approval;
    if (existingResult.issues.some((issue) => issue.code !== "approval.missing")) {
      console.error(existingResult.issues.map((issue) => issue.message).join("\n"));
      return 1;
    }
    if (existing?.version === APPROVAL_V2_VERSION && !options.scope) {
      console.error(`${relativePath} is a scoped Approval bundle; --scope is required`);
      return 1;
    }
    const selectedV2Slot = existing?.version === APPROVAL_V2_VERSION && options.scope ? existing.scopeApprovals?.[options.scope] : undefined;
    if (existsSync(fullPath) && !options.force && (!existing || existing.version !== APPROVAL_V2_VERSION || selectedV2Slot)) {
      console.error(`${relativePath} already exists`);
      return 1;
    }

    const requested = buildApprovalRequest(taskId, {
      ...options,
      ...(current ? { pullRequest: `#${current.number}` } : {})
    });
    const approval = options.scope
      ? buildV2Approval(taskId, options.scope, scopeSlot(requested, options.scope)!, scopedSlots(existing))
      : requested;
    const approvalIssues = validateApprovalRecord(approval, relativePath);
    if (approvalIssues.length > 0) throw new Error(approvalIssues.map((issue) => issue.message).join("\n"));
    const yaml = stringifySimpleYaml(approval as unknown as Record<string, unknown>);
    writeApprovalAndSync(root, fullPath, yaml, options.afterRegistrySync);
    const { evidence } = readEvidence(root, taskId);
    const outputApproval = options.scope
      ? scopedApprovalSummary(approval, options.scope)
      : approval;
    const jsonApproval = options.scope
      ? buildV2Approval(taskId, options.scope, scopeSlot(approval, options.scope)!)
      : approval;
    process.stdout.write(options.json
      ? `${JSON.stringify(buildApprovalRequestJson(jsonApproval, evidence), null, 2)}\n`
      : stringifySimpleYaml(outputApproval));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runApprovalApprove(root: string, taskId: string, options: { pullRequest?: string; reason?: string; approvedBy?: string; force: boolean; actor?: string; scope?: string; afterRegistrySync?: ApprovalRegistryAfterSync }): number {
  try {
    const resolvedActor = options.actor ?? process.env.SCWBS_AGENT_MODE;
    const scope = options.scope === "human-gate" || options.scope === "post-finish" ? options.scope : undefined;
    if (options.scope !== undefined && !scope) {
      console.error("approval scope must be human-gate or post-finish");
      return 1;
    }
    let delegatedSubject: { headCommit: string; diffHash: string; pullRequest: string } | undefined;
    let humanProvenance: TtyHumanProvenance | undefined;
    let approvalExecution: Pick<ApprovalRecord, "approvedBy" | "approvedAt" | "approvalMode" | "delegationSource" | "delegatedBy" | "executedBy" | "delegationScope" | "delegationProof"> = {
      approvedBy: options.approvedBy,
      approvalMode: "human"
    };
    if (resolvedActor === "delegated-ai") {
      if (!scope) {
        console.error("delegated approval requires --scope human-gate or --scope post-finish");
        return 1;
      }
      const { task, issues: taskIssues } = readTask(root, taskId);
      if (!task) throw new Error(taskIssues.map((issue) => issue.message).join("\n"));
      const delegation = authorizeDelegatedApproval(task, scope, {
        token: process.env[APPROVAL_DELEGATION_TOKEN_ENV]
      });
      if (!delegation.approval) {
        console.error(delegation.error ?? "delegated approval was not authorized");
        return 1;
      }
      const { evidence, issues: evidenceIssues } = readEvidence(root, taskId);
      if (!evidence) throw new Error(evidenceIssues.map((issue) => issue.message).join("\n"));
      const subject = evidenceSubject(root, taskId);
      if (!subject.headCommit || !subject.diffHash) {
        console.error("delegated approval requires Evidence subjectHeadCommit and diffHash");
        return 1;
      }
      const evidencePullRequest = normalizePullRequestNumber(evidence.git?.pullRequest);
      if (evidencePullRequest === undefined) {
        console.error("delegated approval requires Evidence pull request metadata");
        return 1;
      }
      if (scope === "post-finish") {
        const passedChecks = new Set(evidence.checks.filter((check) => check.status === "passed").map((check) => check.name));
        const missingChecks = task.requiredChecks.filter((check) => !passedChecks.has(check));
        if (missingChecks.length > 0) {
          console.error(`post-finish delegated approval requires passed Evidence checks: ${missingChecks.join(", ")}`);
          return 1;
        }
      }
      delegatedSubject = { headCommit: subject.headCommit, diffHash: subject.diffHash, pullRequest: `#${evidencePullRequest}` };
      const approvedAt = new Date().toISOString();
      const token = process.env[APPROVAL_DELEGATION_TOKEN_ENV]!;
      approvalExecution = {
        ...delegation.approval,
        approvedAt,
        delegationProof: buildDelegationProof(task, token, {
          approvedAt,
          headCommit: delegatedSubject.headCommit,
          diffHash: delegatedSubject.diffHash,
          scope
        })
      };
    } else if (resolvedActor === "ai") {
      console.error("AI execution mode cannot approve human gates; request human approval instead");
      return 1;
    } else if (resolvedActor !== "human") {
      console.error("approval approve requires --actor human or an authorized --actor delegated-ai execution");
      return 1;
    }
    const relativePath = approvalPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const { approval, issues } = readApproval(root, taskId);
    const { evidence } = readEvidence(root, taskId);
    const missingApprovalOnly = issues.length === 1 && issues[0]?.code === "approval.missing";
    if (!missingApprovalOnly && !approval) {
      throw new Error(issues.map((issue) => issue.message).join("\n"));
    }
    if (approval?.version === APPROVAL_V2_VERSION && !scope) {
      console.error(`${relativePath} is a scoped Approval bundle; --scope is required`);
      return 1;
    }
    const selectedExisting = scopeSlot(approval, scope ?? "post-finish");
    const currentForMutation = scope ? selectedExisting : approval;
    if (currentForMutation?.status === "approved" && !options.force) {
      console.error(`${relativePath} is already approved; rerun with --force to overwrite`);
      return 1;
    }
    if (currentForMutation?.status === "rejected" && !options.force) {
      console.error(`${relativePath} is rejected; rerun with --force to approve anyway`);
      return 1;
    }

    const evidencePullRequest = normalizePullRequestNumber(evidence?.git?.pullRequest);
    const evidenceHead = evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit;
    const evidenceDiffHash = evidence?.diffHash ?? evidence?.git?.diffHash;
    if (resolvedActor === "human" && scope) {
      if (!evidence) throw new Error("Lean human approval requires Evidence");
      if (evidencePullRequest === undefined || !evidenceHead || !evidenceDiffHash) {
        throw new Error("Scoped human approval requires Evidence pull request, subjectHeadCommit, and diffHash");
      }
      humanProvenance = verifyTtyHumanProvenance(taskId, evidence, options.reason, scope);
      approvalExecution = {
        ...approvalExecution,
        approvedBy: humanProvenance.actorId
      };
    } else if (resolvedActor === "human" && evidencePullRequest !== undefined && evidenceHead && evidenceDiffHash) {
      if (!evidence) throw new Error("Lean human approval requires Evidence");
      humanProvenance = verifyTtyHumanProvenance(taskId, evidence, options.reason, scope);
      approvalExecution = {
        ...approvalExecution,
        approvedBy: humanProvenance.actorId
      };
    }
    const built = buildApprovalApprove(taskId, {
      scope,
      requestedAt: currentForMutation?.requestedAt,
      pullRequest: options.pullRequest ?? currentForMutation?.pullRequest ?? delegatedSubject?.pullRequest ?? (scope && evidencePullRequest !== undefined ? `#${evidencePullRequest}` : undefined),
      reason: options.reason,
      ...approvalExecution,
      ...(humanProvenance ?? {}),
      ...(delegatedSubject ?? evidenceSubject(root, taskId))
    });
    const finalApproval = scope
      ? buildV2Approval(taskId, scope, scopeSlot(built, scope)!, scopedSlots(approval))
      : built;
    const approvalIssues = validateApprovalRecord(finalApproval, relativePath);
    if (approvalIssues.length > 0) throw new Error(approvalIssues.map((issue) => issue.message).join("\n"));
    const yaml = stringifySimpleYaml(finalApproval as unknown as Record<string, unknown>);
    writeApprovalAndSync(root, fullPath, yaml, options.afterRegistrySync);
    const outputApproval = scope
      ? scopedApprovalSummary(finalApproval, scope)
      : finalApproval;
    process.stdout.write(stringifySimpleYaml(outputApproval as unknown as Record<string, unknown>));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runApprovalReject(root: string, taskId: string, options: { reason?: string; force: boolean; actor?: string; scope?: string; afterRegistrySync?: ApprovalRegistryAfterSync }): number {
  try {
    if (options.actor !== "human") {
      console.error("approval reject requires --actor human");
      return 1;
    }
    const scope = options.scope === "human-gate" || options.scope === "post-finish" ? options.scope : undefined;
    if (options.scope !== undefined && !scope) {
      console.error("approval scope must be human-gate or post-finish");
      return 1;
    }
    const relativePath = approvalPath(taskId);
    const fullPath = resolveFrom(root, relativePath);
    const existingResult = readApproval(root, taskId);
    if (existingResult.issues.some((issue) => issue.code !== "approval.missing")) {
      console.error(existingResult.issues.map((issue) => issue.message).join("\n"));
      return 1;
    }
    const existing = existingResult.approval;
    if (!existing) {
      console.error(existingResult.issues.map((issue) => issue.message).join("\n") || `${relativePath} does not exist`);
      return 1;
    }
    if (existing.version === APPROVAL_V2_VERSION && !scope) {
      console.error(`${relativePath} is a scoped Approval bundle; --scope is required`);
      return 1;
    }
    const selectedExisting = scope ? scopeSlot(existing, scope) : existing;
    if (!selectedExisting) {
      console.error(`${taskId} has no existing Approval slot for ${scope}`);
      return 1;
    }
    if ((selectedExisting.status === "approved" || selectedExisting.status === "rejected") && !options.force) {
      console.error(`${relativePath} ${selectedExisting.status}; rerun with --force to reject it`);
      return 1;
    }
    const provenance = scope ? verifyScopedHumanRejection(taskId, options.reason, scope) : undefined;
    const withoutDelegation = Object.fromEntries(Object.entries(selectedExisting).filter(([key]) => ![
      "delegationSource", "delegatedBy", "executedBy", "delegationScope", "delegationProof"
    ].includes(key))) as unknown as ApprovalScopeRecord;
    const rejectedSlot: ApprovalScopeRecord = {
      ...withoutDelegation,
      status: "rejected",
      reason: options.reason,
      approvalMode: "human",
      ...(provenance ?? {}),
      ...(provenance ? { approvedBy: provenance.actorId, approvedAt: provenance.verifiedAt } : {})
    };
    const finalApproval = scope
      ? buildV2Approval(taskId, scope, rejectedSlot, scopedSlots(existing))
      : { ...existing, ...rejectedSlot };
    const approvalIssues = validateApprovalRecord(finalApproval, relativePath);
    if (approvalIssues.length > 0) throw new Error(approvalIssues.map((issue) => issue.message).join("\n"));
    const yaml = stringifySimpleYaml(finalApproval as unknown as Record<string, unknown>);
    writeApprovalAndSync(root, fullPath, yaml, options.afterRegistrySync);
    const outputApproval = scope ? scopedApprovalSummary(finalApproval, scope) : finalApproval;
    process.stdout.write(stringifySimpleYaml(outputApproval as unknown as Record<string, unknown>));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
