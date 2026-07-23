import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildApprovalApproveYaml, buildApprovalRequestYaml, runApprovalApprove, runApprovalRequest } from "../../src/commands/approval-request.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, approvalDelegationTokenSha256 } from "../../src/core/human-gate.js";
import { main } from "../../src/cli.js";
import { readApproval } from "../../src/core/contracts.js";
import { makeTempRepo, sampleTask, sampleEvidence, sampleApproval, writeScwbsProject, writeJson, writeYaml } from "../helpers.js";

const STRONG_TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_STRONG_TOKEN = "fedcba9876543210fedcba9876543210";

function captureOutput(action: () => number): { result: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalWrite = process.stdout.write;
  const originalError = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    return { result: action(), stdout: stdout.join(""), stderr: stderr.join("\n") };
  } finally {
    process.stdout.write = originalWrite;
    console.error = originalError;
  }
}

describe("approval", () => {
  test("approval request writes a requested approval record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#42", note: "Awaiting human review", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("status: requested");
    expect(actual).toContain("requestedAt:");
    expect(actual).toContain('pullRequest: "#42"');
  });

  test("approval request refuses to overwrite an existing record without force", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#99", note: "Updated", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#99", note: "Updated", force: true })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).not.toBe(before);
  });

  test("approval request CLI accepts multi-word notes", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "request", "--task", "WBS-001-004", "--pull-request", "#42", "--note", "Awaiting", "human", "review"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("  - Awaiting human review");
  });

  test("approval request CLI accepts inline note syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "request", "--task", "WBS-001-004", "--note=Awaiting human review"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("  - Awaiting human review");
  });

  test("approval approve writes a human approved record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);

    expect(runApprovalApprove(root, "WBS-001-004", { pullRequest: "#42", reason: "Evidence and PR reviewed", actor: "human", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("status: approved");
    expect(actual).toContain("approvedBy: human");
    expect(actual).toContain("approvedAt:");
    expect(actual).toContain("headCommit: abc1234");
    expect(actual).toContain("diffHash: diff1234");
    expect(actual).toContain('pullRequest: "#42"');
    expect(actual).toContain("reason: Evidence and PR reviewed");
  });

  test("approval approve preserves request time while legacy approval remains unobserved", () => {
    const requestedAt = "2026-07-23T00:00:00.000Z";
    expect(buildApprovalApproveYaml("WBS-001-004", {
      requestedAt,
      approvedAt: "2026-07-23T00:01:00.000Z"
    })).toContain(`requestedAt: "${requestedAt}"`);
    expect(buildApprovalApproveYaml("WBS-001-004", {
      approvedAt: "2026-07-23T00:01:00.000Z"
    })).not.toContain("requestedAt:");
  });

  test("approval approve rejects AI execution mode", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "AI should not approve", actor: "ai", force: false })).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve rejects when actor is not explicitly human", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    // Ensure SCWBS_AGENT_MODE is not set in the test environment
    delete process.env.SCWBS_AGENT_MODE;
    expect(runApprovalApprove(root, "WBS-001-004", { reason: "No actor specified", force: false })).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve writes a provenance-distinct delegated record for an authorized scope", () => {
    const root = makeTempRepo();
    const token = STRONG_TOKEN;
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      approvalPolicy: {
        mode: "delegated",
        delegatedBy: "xmeta",
        delegatedTo: "ai-agent",
        scopes: ["human-gate", "post-finish"],
        source: "https://github.com/xmeta/ACED/issues/222",
        reason: "Authorized unattended execution",
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSha256: approvalDelegationTokenSha256(token)
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    let output: ReturnType<typeof captureOutput>;
    process.env[APPROVAL_DELEGATION_TOKEN_ENV] = token;
    try {
      output = captureOutput(() => runApprovalApprove(root, "WBS-001-004", {
        reason: "Automated evidence review",
        actor: "delegated-ai",
        scope: "post-finish",
        force: false
      }));
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
    expect(output.result).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("approvalMode: delegated");
    expect(actual).toContain("delegationSource: https://github.com/xmeta/ACED/issues/222");
    expect(actual).toContain("delegatedBy: xmeta");
    expect(actual).toContain("executedBy: ai-agent");
    expect(actual).toContain("delegationScope: post-finish");
    expect(actual).toContain("delegationProof: hmac-sha256:");
    expect(actual).not.toContain(token);
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
  });

  test.each([
    { name: "missing policy", task: sampleTask(), token: STRONG_TOKEN, scope: "human-gate", error: "does not have a delegated approval policy" },
    { name: "missing token", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: undefined, scope: "human-gate", error: `${APPROVAL_DELEGATION_TOKEN_ENV} is required` },
    { name: "token mismatch", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: OTHER_STRONG_TOKEN, scope: "human-gate", error: "does not match the Task Contract delegation" },
    { name: "expired policy", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2020-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: STRONG_TOKEN, scope: "human-gate", error: "approval delegation is expired" },
    { name: "scope mismatch", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256(STRONG_TOKEN)
    } }), token: STRONG_TOKEN, scope: "post-finish", error: "delegation does not allow post-finish approval" },
    { name: "weak token", task: sampleTask({ approvalPolicy: {
      mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate"],
      source: "issue-222", reason: "automation", expiresAt: "2099-01-01T00:00:00.000Z",
      tokenSha256: approvalDelegationTokenSha256("short-token")
    } }), token: "short-token", scope: "human-gate", error: "at least 32 UTF-8 bytes" }
  ])("delegated approval fails closed for $name", ({ task, token, scope, error }) => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", task as unknown as Record<string, unknown>);
    if (token) process.env[APPROVAL_DELEGATION_TOKEN_ENV] = token;
    else delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    let output: ReturnType<typeof captureOutput>;
    try {
      output = captureOutput(() => runApprovalApprove(root, "WBS-001-004", { actor: "delegated-ai", scope, force: false }));
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
    expect(output.result).toBe(1);
    expect(output.stderr).toContain(error);
    if (token) {
      expect(output.stdout).not.toContain(token);
      expect(output.stderr).not.toContain(token);
    }
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve updates requested records and protects existing approvals", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Reviewed", actor: "human", force: false })).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Second approval", actor: "human", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
  });

  test("approval approve CLI accepts inline multi-word reason syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "approve", "--task", "WBS-001-004", "--actor", "human", "--pull-request", "#42", "--reason=Evidence and PR reviewed"], root)).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("reason: Evidence and PR reviewed");
  });

  test("approval approve helper can render deterministic YAML", () => {
    expect(buildApprovalApproveYaml("WBS-001-004", {
      pullRequest: "#42",
      reason: "Reviewed",
      approvedBy: "human",
      approvedAt: "2026-07-02T00:00:00.000Z"
    })).toContain('approvedAt: "2026-07-02T00:00:00.000Z"');
  });
});
