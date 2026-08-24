import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  APPROVAL_DELEGATION_TOKEN_ENV,
  approvalDelegationTokenSha256,
  authorizeDelegatedApproval,
  buildDelegationProof,
  buildHumanApprovalCommand,
  buildLeanHumanApprovalConfirmation,
  validateDelegatedApproval,
  validateHumanGateApproval
} from "../../src/core/human-gate.js";
import { headCommit } from "../../src/core/git.js";
import { makeTempRepo, sampleApproval, sampleEvidence, sampleTask, writeText } from "../helpers.js";
import type { ApprovalPolicy, ApprovalRecord, TaskContract } from "../../src/core/types.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "fedcba9876543210fedcba9876543210";
const APPROVED_AT = "2026-08-06T00:00:00.000Z";

type DelegatedPolicy = Extract<ApprovalPolicy, { mode: "delegated" }>;

function delegatedPolicy(overrides: Partial<DelegatedPolicy> = {}): DelegatedPolicy {
  return {
    mode: "delegated",
    delegatedBy: "xmeta",
    delegatedTo: "ai-agent",
    scopes: ["human-gate", "post-finish"],
    source: "issue-420",
    reason: "security unit coverage",
    expiresAt: "2026-12-31T00:00:00.000Z",
    tokenSha256: approvalDelegationTokenSha256(TOKEN),
    ...overrides
  };
}

function delegatedTask(overrides: Partial<TaskContract> = {}): TaskContract {
  return sampleTask({
    humanGateRequiredPaths: ["package.json", ".github/**"],
    approvalPolicy: delegatedPolicy(),
    ...overrides
  });
}

function delegatedApproval(task: TaskContract, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const approval = {
    id: `APR-${task.id}`,
    type: "approval" as const,
    taskId: task.id,
    status: "approved" as const,
    approvalMode: "delegated" as const,
    approvedBy: "delegated:xmeta",
    delegationSource: "issue-420",
    delegatedBy: "xmeta",
    executedBy: "ai-agent" as const,
    delegationScope: "human-gate" as const,
    approvedAt: APPROVED_AT,
    headCommit: "head123",
    diffHash: "diff123"
  };
  return {
    ...approval,
    delegationProof: buildDelegationProof(task, TOKEN, {
      approvedAt: approval.approvedAt,
      headCommit: approval.headCommit,
      diffHash: approval.diffHash,
      scope: approval.delegationScope
    }),
    ...overrides
  };
}

function commitAll(root: string, message: string): string {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
  return headCommit(root)!;
}

function addTaskMetadata(root: string, taskId: string): string {
  writeText(root, `contracts/evidence/${taskId}.yaml`, "metadata\n");
  writeText(root, `contracts/approvals/${taskId}.yaml`, "metadata\n");
  writeText(root, `contracts/reviews/${taskId}.yaml`, "metadata\n");
  writeText(root, "contracts/registry.yaml", "metadata\n");
  return commitAll(root, "metadata");
}

describe("Human Gate security logic", () => {
  test("builds the exact Evidence-bound Lean confirmation and fails closed without scope", () => {
    const evidence = sampleEvidence({ subjectHeadCommit: "head123", diffHash: "sha256:diff123" });
    expect(buildLeanHumanApprovalConfirmation("WBS-001-004", evidence)).toBe(
      "CONFIRM TTY APPROVAL WBS-001-004 head123 sha256:diff123"
    );
    expect(buildHumanApprovalCommand("WBS-001-004", evidence)).toBe(
      'npm run scwbs -- approval approve --task WBS-001-004 --actor human --reason "CONFIRM TTY APPROVAL WBS-001-004 head123 sha256:diff123"'
    );
    expect(buildHumanApprovalCommand("WBS-001-004", evidence, "approved")).toContain(" --force");
    expect(buildHumanApprovalCommand("WBS-001-004", evidence, "requested", "human-gate")).not.toContain(" --force");
    expect(buildHumanApprovalCommand("WBS-001-004", evidence, "approved", "human-gate")).toContain("--scope human-gate --force");
    expect(buildHumanApprovalCommand("WBS-001-004", sampleEvidence())).toBeUndefined();
    expect(buildLeanHumanApprovalConfirmation("WBS-001-004", undefined)).toBeUndefined();
  });

  test("authorizes a valid delegated approval with scoped provenance", () => {
    const result = authorizeDelegatedApproval(delegatedTask(), "human-gate", { token: TOKEN, now: new Date("2026-08-01T00:00:00.000Z") });

    expect(result).toEqual({
      approval: {
        approvalMode: "delegated",
        approvedBy: "delegated:xmeta",
        delegationSource: "issue-420",
        delegatedBy: "xmeta",
        executedBy: "ai-agent",
        delegationScope: "human-gate"
      }
    });
  });

  test.each([
    ["missing policy", sampleTask(), TOKEN, "human-gate", "does not have a delegated approval policy"],
    ["expired policy", delegatedTask({ approvalPolicy: delegatedPolicy({ expiresAt: "2026-01-01T00:00:00.000Z" }) }), TOKEN, "human-gate", "approval delegation is expired"],
    ["missing token", delegatedTask(), undefined, "human-gate", `${APPROVAL_DELEGATION_TOKEN_ENV} is required`],
    ["short token", delegatedTask(), "short-token", "human-gate", "at least 32 UTF-8 bytes"],
    ["scope mismatch", delegatedTask({ approvalPolicy: delegatedPolicy({ scopes: ["human-gate"] }) }), TOKEN, "post-finish", "does not allow post-finish approval"],
    ["token mismatch", delegatedTask(), OTHER_TOKEN, "human-gate", "does not match the Task Contract delegation"]
  ] as const)("fails closed for $0", (_name, task, token, scope, message) => {
    const result = authorizeDelegatedApproval(task, scope, { token, now: new Date("2026-08-01T00:00:00.000Z") });
    expect(result.approval).toBeUndefined();
    expect(result.error).toContain(message);
  });

  test("validates a delegated approval proof", () => {
    expect(validateDelegatedApproval(delegatedTask(), delegatedApproval(delegatedTask()), "human-gate", TOKEN)).toEqual([]);
  });

  test.each([
    ["provenance", { approvedBy: "human" }, "approval.delegation.provenance"],
    ["expiry", { approvedAt: "2027-01-01T00:00:00.000Z" }, "approval.delegation.expiry"],
    ["missing proof", { delegationProof: undefined }, "approval.delegation.proof"],
    ["tampered proof", { delegationProof: "hmac-sha256:tampered" }, "approval.delegation.proof"]
  ] as const)("rejects delegated approval with invalid $0", (_name, overrides, code) => {
    const issues = validateDelegatedApproval(delegatedTask(), delegatedApproval(delegatedTask(), overrides), "human-gate", TOKEN);
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  test("validates Human Gate status and exact Evidence scope", () => {
    const task = sampleTask({ humanGateRequiredPaths: ["package.json"] });
    const evidence = sampleEvidence({ changedFiles: ["package.json"], subjectHeadCommit: "head123", diffHash: "diff123" });

    expect(validateHumanGateApproval(task, evidence, undefined).issues[0]?.code).toBe("approval.missing");
    expect(validateHumanGateApproval(task, evidence, sampleApproval({ status: "requested" })).issues[0]?.code).toBe("approval.status");
    expect(validateHumanGateApproval(task, evidence, sampleApproval({ status: "approved", headCommit: "head123", diffHash: "diff123" })) ).toMatchObject({ approved: true, issues: [] });
    expect(validateHumanGateApproval(task, evidence, sampleApproval({ status: "approved", headCommit: "other", diffHash: "other" })).issues.map((issue) => issue.code)).toEqual([
      "approval.scope.headCommit",
      "approval.scope.diffHash"
    ]);
  });

  test("marks Human Gate remediation as human-owned and never auto-runnable", () => {
    const task = sampleTask({ humanGateRequiredPaths: ["package.json"] });
    const evidence = sampleEvidence({ changedFiles: ["package.json"] });
    const issue = validateHumanGateApproval(task, evidence, undefined).issues[0]!;
    expect(issue.remediation).toMatchObject({ kind: "command", owner: "human", safeToAutoRun: false });
    expect(issue.remediation).toMatchObject({ argv: ["npm", "run", "scwbs", "--", "approval", "request", "--task", task.id, "--scope", "human-gate"] });
  });

  test("preserves a matching Approval through metadata-only descendant commits", () => {
    const root = makeTempRepo();
    writeText(root, "README.md", "base\n");
    commitAll(root, "base");
    writeText(root, "package.json", "{}\n");
    const approvedHead = commitAll(root, "implementation");
    const subjectHead = addTaskMetadata(root, "WBS-001-004");
    const task = sampleTask({ humanGateRequiredPaths: ["package.json"] });
    const evidence = sampleEvidence({ changedFiles: ["package.json"], subjectHeadCommit: subjectHead, diffHash: "same-diff" });
    const approval = sampleApproval({ status: "approved", headCommit: approvedHead, diffHash: "same-diff" });

    expect(validateHumanGateApproval(task, evidence, approval, evidence.changedFiles, root)).toMatchObject({ required: true, approved: true, issues: [] });
  }, 15000);
});
