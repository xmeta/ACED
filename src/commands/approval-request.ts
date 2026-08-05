import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readApproval, readEvidence, readTask } from "../core/contracts.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, authorizeDelegatedApproval, buildDelegationProof } from "../core/human-gate.js";
import { approvalPath, resolveFrom } from "../core/paths.js";
import { stringifySimpleYaml } from "../core/yaml.js";
import { syncRegistry } from "./registry-rebuild.js";
import type { ApprovalDelegationScope, ApprovalRecord, Evidence } from "../core/types.js";
import { detectCurrentPullRequest, normalizePullRequestNumber, pullRequestEvidenceCommand } from "./health.js";

export function buildApprovalRequest(taskId: string, options: { pullRequest?: string; note?: string; requestedAt?: string }): ApprovalRecord {
  return {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    status: "requested",
    requestedAt: options.requestedAt ?? new Date().toISOString(),
    ...(options.pullRequest ? { pullRequest: options.pullRequest } : {}),
    ...(options.note ? { notes: [options.note] } : {})
  };
}

export function buildApprovalRequestYaml(taskId: string, options: { pullRequest?: string; note?: string; requestedAt?: string }): string {
  return stringifySimpleYaml(buildApprovalRequest(taskId, options) as unknown as Record<string, unknown>);
}

export function buildApprovalApprove(taskId: string, options: { requestedAt?: string; pullRequest?: string; reason?: string; approvedBy?: string; approvedAt?: string; headCommit?: string; diffHash?: string; approvalMode?: "human" | "delegated"; actorId?: string; actorSource?: string; actorUrl?: string; verifiedAt?: string; verificationLevel?: string; delegationSource?: string; delegatedBy?: string; executedBy?: "ai-agent"; delegationScope?: ApprovalDelegationScope; delegationProof?: string }): ApprovalRecord {
  return {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
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
}

type TtyHumanProvenance = Pick<ApprovalRecord, "actorId" | "actorSource" | "verifiedAt" | "verificationLevel">;

function verifyTtyHumanProvenance(taskId: string, evidence: Evidence, reason?: string): TtyHumanProvenance {
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
  const confirmation = `CONFIRM TTY APPROVAL ${taskId} ${headCommit} ${diffHash}`;
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

export function runApprovalRequest(root: string, taskId: string, options: { pullRequest?: string; note?: string; force: boolean }): number {
  try {
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
    if (existsSync(fullPath) && !options.force) {
      console.error(`${relativePath} already exists`);
      return 1;
    }

    const yaml = buildApprovalRequestYaml(taskId, {
      ...options,
      ...(current ? { pullRequest: `#${current.number}` } : {})
    });
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    syncRegistry(root);
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runApprovalApprove(root: string, taskId: string, options: { pullRequest?: string; reason?: string; approvedBy?: string; force: boolean; actor?: string; scope?: string }): number {
  try {
    const resolvedActor = options.actor ?? process.env.SCWBS_AGENT_MODE;
    let delegatedSubject: { headCommit: string; diffHash: string } | undefined;
    let humanProvenance: TtyHumanProvenance | undefined;
    let approvalExecution: Pick<ApprovalRecord, "approvedBy" | "approvedAt" | "approvalMode" | "delegationSource" | "delegatedBy" | "executedBy" | "delegationScope" | "delegationProof"> = {
      approvedBy: options.approvedBy,
      approvalMode: "human"
    };
    if (resolvedActor === "delegated-ai") {
      if (options.scope !== "human-gate" && options.scope !== "post-finish") {
        console.error("delegated approval requires --scope human-gate or --scope post-finish");
        return 1;
      }
      const { task, issues: taskIssues } = readTask(root, taskId);
      if (!task) throw new Error(taskIssues.map((issue) => issue.message).join("\n"));
      const delegation = authorizeDelegatedApproval(task, options.scope, {
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
      if (options.scope === "post-finish") {
        const passedChecks = new Set(evidence.checks.filter((check) => check.status === "passed").map((check) => check.name));
        const missingChecks = task.requiredChecks.filter((check) => !passedChecks.has(check));
        if (missingChecks.length > 0) {
          console.error(`post-finish delegated approval requires passed Evidence checks: ${missingChecks.join(", ")}`);
          return 1;
        }
      }
      delegatedSubject = { headCommit: subject.headCommit, diffHash: subject.diffHash };
      const approvedAt = new Date().toISOString();
      const token = process.env[APPROVAL_DELEGATION_TOKEN_ENV]!;
      approvalExecution = {
        ...delegation.approval,
        approvedAt,
        delegationProof: buildDelegationProof(task, token, {
          approvedAt,
          headCommit: delegatedSubject.headCommit,
          diffHash: delegatedSubject.diffHash,
          scope: options.scope
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
    if (approval?.status === "approved" && !options.force) {
      console.error(`${relativePath} is already approved; rerun with --force to overwrite`);
      return 1;
    }
    if (approval?.status === "rejected" && !options.force) {
      console.error(`${relativePath} is rejected; rerun with --force to approve anyway`);
      return 1;
    }

    const evidencePullRequest = normalizePullRequestNumber(evidence?.git?.pullRequest);
    const evidenceHead = evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.git?.headCommit ?? evidence?.commit;
    const evidenceDiffHash = evidence?.diffHash ?? evidence?.git?.diffHash;
    if (resolvedActor === "human" && evidencePullRequest !== undefined && evidenceHead && evidenceDiffHash) {
      if (!evidence) throw new Error("Lean human approval requires Evidence");
      humanProvenance = verifyTtyHumanProvenance(taskId, evidence, options.reason);
      approvalExecution = {
        ...approvalExecution,
        approvedBy: humanProvenance.actorId
      };
    }
    const yaml = buildApprovalApproveYaml(taskId, {
      requestedAt: approval?.requestedAt,
      pullRequest: options.pullRequest ?? approval?.pullRequest,
      reason: options.reason,
      ...approvalExecution,
      ...(humanProvenance ?? {}),
      ...(delegatedSubject ?? evidenceSubject(root, taskId))
    });
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, yaml, "utf8");
    syncRegistry(root);
    process.stdout.write(yaml);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
