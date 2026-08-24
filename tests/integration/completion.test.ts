import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { buildCompletionPreview, runCompletionApply } from "../../src/commands/completion.js";
import { runApprovalApprove } from "../../src/commands/approval-request.js";
import { APPROVAL_DELEGATION_TOKEN_ENV, approvalDelegationTokenSha256 } from "../../src/core/human-gate.js";
import { readApproval } from "../../src/core/contracts.js";
import { makeTempRepo, sampleEvidence, sampleTask, writeJson, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

const SUBJECT = { pullRequest: "#42", headCommit: "abc1234", diffHash: "sha256:fake-diff-hash" };
const DELEGATION_TOKEN = "0123456789abcdef0123456789abcdef";

function writeEvidence(root: string, taskId: string, subject = SUBJECT, changedFiles = ["src/features/api/index.ts"]): void {
  writeYaml(root, `contracts/evidence/${taskId}.yaml`, sampleEvidence({
    id: `EVD-${taskId}`,
    taskId,
    changedFiles,
    git: { branch: `task/${taskId}`, base: "main", ...subject }
  }) as unknown as Record<string, unknown>);
}

function writeReview(root: string, taskId: string, subject = SUBJECT, overrides: Record<string, unknown> = {}): void {
  writeYaml(root, `contracts/reviews/${taskId}.yaml`, {
    id: `RVW-${taskId}`,
    type: "review",
    taskId,
    status: "approved",
    reviewProfile: "independent-ai-review",
    pullRequest: subject.pullRequest,
    headCommit: subject.headCommit,
    diffHash: subject.diffHash,
    groundTruth: [`contracts/tasks/${taskId}.yaml`, `contracts/evidence/${taskId}.yaml`],
    reviewedBy: "sol",
    reviewedAt: "2026-08-24T00:00:00.000Z",
    ...overrides
  });
}

function writePostFinishApproval(root: string, taskId: string, subject = SUBJECT, overrides: Record<string, unknown> = {}): void {
  writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    status: "approved",
    approvedBy: "human",
    approvedAt: "2026-08-24T00:00:00.000Z",
    headCommit: subject.headCommit,
    diffHash: subject.diffHash,
    pullRequest: subject.pullRequest,
    reason: "Reviewed and accepted",
    ...overrides
  });
}

function writeLifecycle(root: string, taskId: string, subject = SUBJECT, changedFiles?: string[]): void {
  writeEvidence(root, taskId, subject, changedFiles);
  writeReview(root, taskId, subject);
  writePostFinishApproval(root, taskId, subject);
}

function writeV2Approval(root: string, taskId: string, subject = SUBJECT, scopes: { humanGateStatus?: string; postFinishStatus?: string; approvalOverrides?: Record<string, unknown> } = {}): void {
  const base = {
    status: "approved",
    approvedBy: "human",
    approvedAt: "2026-08-24T00:00:00.000Z",
    approvalMode: "human",
    headCommit: subject.headCommit,
    diffHash: subject.diffHash,
    pullRequest: subject.pullRequest,
    reason: "Human reviewed the scoped subject",
    actorId: "human",
    actorSource: "tty",
    verifiedAt: "2026-08-24T00:00:00.000Z",
    verificationLevel: "lean",
    ...scopes.approvalOverrides
  };
  const slot = (status: string): Record<string, unknown> => status === "requested"
    ? { status, requestedAt: "2026-08-24T00:00:00.000Z", pullRequest: subject.pullRequest }
    : { ...base, status };
  const humanGate = slot(scopes.humanGateStatus ?? "approved");
  const postFinish = slot(scopes.postFinishStatus ?? "approved");
  writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
    id: `APR-${taskId}`,
    type: "approval",
    taskId,
    version: "scwbs.approval.v2",
    activeScope: "human-gate",
    scopeApprovals: { "human-gate": humanGate, "post-finish": postFinish },
    ...humanGate
  });
}

function writeNodeFixture(root: string): void {
  writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({ id: "WBS-001-005", humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({ id: "WBS-001-006", completionScope: "node", completionTaskIds: ["WBS-001-004", "WBS-001-005"], humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>);
  writeLifecycle(root, "WBS-001-004", { pullRequest: "#41", headCommit: "abc1234", diffHash: SUBJECT.diffHash });
  writeLifecycle(root, "WBS-001-005", { pullRequest: "#42", headCommit: "abc1235", diffHash: SUBJECT.diffHash });
  writeLifecycle(root, "WBS-001-006", { pullRequest: "#43", headCommit: "abc1236", diffHash: SUBJECT.diffHash });
  writeV2Approval(root, "WBS-001-004", { pullRequest: "#41", headCommit: "abc1234", diffHash: SUBJECT.diffHash });
  writeV2Approval(root, "WBS-001-005", { pullRequest: "#42", headCommit: "abc1235", diffHash: SUBJECT.diffHash });
  writeV2Approval(root, "WBS-001-006", { pullRequest: "#43", headCommit: "abc1236", diffHash: SUBJECT.diffHash });
}

function delegatedTask(): ReturnType<typeof sampleTask> {
  return sampleTask({ approvalPolicy: {
    mode: "delegated", delegatedBy: "xmeta", delegatedTo: "ai-agent", scopes: ["human-gate", "post-finish"],
    source: "https://github.com/xmeta/ACED/issues/222", reason: "Authorized unattended execution", expiresAt: "2099-01-01T00:00:00.000Z", tokenSha256: approvalDelegationTokenSha256(DELEGATION_TOKEN)
  } });
}

function writeFakeWjsApply(root: string): void {
  mkdirSync(path.join(root, "wjs/tools"), { recursive: true });
  writeText(root, "wjs/tools/apply.ts", "// marker file for the WJS apply tool\n");
  writeText(root, "wjs/tools/apply.cjs", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const wbsPath = args[0];
const changeSetPath = args[1];
const outputIndex = args.indexOf("-o");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : wbsPath;
const wbs = JSON.parse(fs.readFileSync(wbsPath, "utf8"));
const changeSet = JSON.parse(fs.readFileSync(changeSetPath, "utf8"));
for (const operation of changeSet.operations) {
  const node = wbs.nodes.find((item) => item.id === operation.nodeId);
  if (node) node.status = operation.status;
}
fs.writeFileSync(outputPath, JSON.stringify(wbs, null, 2) + "\\n");
`);
  writeJson(root, "wjs/package.json", { scripts: { apply: "node tools/apply.cjs" } });
}

describe("completion apply", () => {
  test("ordinary dry-run evaluates Evidence and post-finish Approval without Review output", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeLifecycle(root, "WBS-001-004");

    const preview = buildCompletionPreview(root, " WBS-001-004 ", "WBS-001-999", { reason: "Reviewed", allowRoot: false });
    expect(preview).toContain("Completion apply dry-run:");
    expect(preview).toContain("- WBS-001-004: 1.1 API Implementation -> completed");
    expect(preview).not.toContain("review: approved record validated");
    expect(preview).toContain("post-finish approval: approved record validated");
    expect(preview).toContain("operations: 1");
  });

  test("ordinary completion remains compatible without a Review record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeEvidence(root, "WBS-001-004");
    writePostFinishApproval(root, "WBS-001-004");
    const preview = buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false });
    expect(preview).toContain("Completion apply dry-run:");
    expect(preview).not.toContain("review: approved record validated");
  });

  test.each([
    ["requested", "Review status is requested"],
    ["changes-requested", "Review status is changes-requested"]
  ] as const)("rejects non-approved Review status %s", (status, message) => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeNodeFixture(root);
    writeReview(root, "WBS-001-006", { pullRequest: "#43", headCommit: "abc1236", diffHash: SUBJECT.diffHash }, { status });
    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
    expect(buildCompletionPreview(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain(message);
  });

  test.each([
    ["pullRequest", "#41", "Review pullRequest does not match Evidence"],
    ["headCommit", "stale-head", "Review headCommit does not match Evidence"],
    ["diffHash", "sha256:stale", "Review diffHash does not match Evidence"]
  ] as const)("rejects Review %s mismatch", (field, value, message) => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeNodeFixture(root);
    writeReview(root, "WBS-001-006", { pullRequest: "#43", headCommit: "abc1236", diffHash: SUBJECT.diffHash }, { [field]: value });
    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
    expect(buildCompletionPreview(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain(message);
  });

  test("uses one bounded evaluator for primary and unique completionTaskIds", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeNodeFixture(root);

    const preview = buildCompletionPreview(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", allowRoot: false });
    expect(preview).toContain("completionTargets:");
    expect(preview).toContain("review: approved record validated");
    expect(preview).toContain("- WBS-001-004: 1.1 API Implementation");
    expect(preview).toContain("- WBS-001-005: 1.1 API Implementation");
    expect(preview).not.toMatch(/WBS-001-004:.*WBS-001-004/);
  });

  test.each(["requested", "changes-requested"] as const)("node primary rejects %s Review", (status) => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeNodeFixture(root);
    writeReview(root, "WBS-001-006", { pullRequest: "#43", headCommit: "abc1236", diffHash: SUBJECT.diffHash }, { status });
    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("node primary and approved targets apply WBS completion and registry update", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeNodeFixture(root);
    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(0);
    const wbs = JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8")) as { nodes: Array<{ id: string; status: string }> };
    expect(wbs.nodes.find((node) => node.id === "node-api")?.status).toBe("completed");
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toContain("id: APR-WBS-001-006");
  });

  test("blocks a target with changes-requested Review and does not create a changeset", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({ id: "WBS-001-005", humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({ id: "WBS-001-006", completionScope: "node", completionTaskIds: ["WBS-001-004", "WBS-001-005"], humanGateRequiredPaths: [] }) as unknown as Record<string, unknown>);
    writeLifecycle(root, "WBS-001-004");
    writeLifecycle(root, "WBS-001-005");
    writeLifecycle(root, "WBS-001-006");
    writeReview(root, "WBS-001-005", SUBJECT, { status: "changes-requested" });
    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("selects the exact post-finish slot without falling back to human-gate", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeLifecycle(root, "WBS-001-004");
    writeV2Approval(root, "WBS-001-004", SUBJECT, { postFinishStatus: "requested" });
    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
    expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("post-finish Approval status is requested");
  });

  test("accepts a canonical v2 Approval with both scopes approved", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeLifecycle(root, "WBS-001-004");
    writeV2Approval(root, "WBS-001-004");
    expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("Completion apply dry-run:");
  });

  test.each([
    ["rejected", "post-finish Approval status is rejected"],
    ["requested", "post-finish Approval status is requested"]
  ] as const)("rejects v1 post-finish Approval status %s", (status, message) => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeEvidence(root, "WBS-001-004");
    writePostFinishApproval(root, "WBS-001-004", SUBJECT, { status });
    expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain(message);
  });

  test.each([
    ["pullRequest", "#41"],
    ["headCommit", "stale-head"],
    ["diffHash", "sha256:stale"]
  ] as const)("rejects stale post-finish Approval %s", (field, value) => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeEvidence(root, "WBS-001-004");
    writePostFinishApproval(root, "WBS-001-004", SUBJECT, { [field]: value });
    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
  });

  test("rejects incomplete v2 human provenance", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeLifecycle(root, "WBS-001-004");
    writeV2Approval(root, "WBS-001-004", SUBJECT, { approvalOverrides: { actorSource: "github-review" } });
    expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("post-finish Approval unavailable (approval.v2.provenance)");
  });

  test("reuses canonical Human Gate validation for changed Human Gate files", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ humanGateRequiredPaths: ["src/security/**"] }) as unknown as Record<string, unknown>);
    writeLifecycle(root, "WBS-001-004", SUBJECT, ["src/security/policy.ts"]);
    writeV2Approval(root, "WBS-001-004", SUBJECT, { humanGateStatus: "requested" });
    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
    expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("Human Gate Approval invalid (approval.status)");
  });

  test("accepts valid delegated post-finish proof", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", delegatedTask() as unknown as Record<string, unknown>);
    writeEvidence(root, "WBS-001-004");
    process.env[APPROVAL_DELEGATION_TOKEN_ENV] = DELEGATION_TOKEN;
    try {
      expect(runApprovalApprove(root, "WBS-001-004", { actor: "delegated-ai", scope: "post-finish", reason: "Delegated completion review", force: false })).toBe(0);
      expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("Completion apply dry-run:");
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
  });

  test("rejects delegated wrong scope and tampered proof", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", delegatedTask() as unknown as Record<string, unknown>);
    writeEvidence(root, "WBS-001-004");
    process.env[APPROVAL_DELEGATION_TOKEN_ENV] = DELEGATION_TOKEN;
    try {
      expect(runApprovalApprove(root, "WBS-001-004", { actor: "delegated-ai", scope: "human-gate", reason: "Delegated gate review", force: false })).toBe(0);
      expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("post-finish Approval unavailable");
      expect(runApprovalApprove(root, "WBS-001-004", { actor: "delegated-ai", scope: "post-finish", reason: "Delegated completion review", force: false })).toBe(0);
      const approval = readApproval(root, "WBS-001-004").approval!;
      const tamperedProof = `hmac-sha256:${"a".repeat(64)}`;
      writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
        ...approval,
        delegationProof: tamperedProof,
        scopeApprovals: { ...approval.scopeApprovals, "post-finish": { ...approval.scopeApprovals?.["post-finish"], delegationProof: tamperedProof } }
      } as unknown as Record<string, unknown>);
      expect(buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false })).toContain("post-finish Approval invalid");
    } finally {
      delete process.env[APPROVAL_DELEGATION_TOKEN_ENV];
    }
  });

  test("dry-run and apply expose the identical bounded blocker set", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeEvidence(root, "WBS-001-004");
    writePostFinishApproval(root, "WBS-001-004", SUBJECT, { diffHash: "sha256:stale" });
    const preview = buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false });
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
      expect(writeSpy.mock.calls.at(-1)?.[0]).toBe(preview);
    } finally {
      writeSpy.mockRestore();
    }
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("applies the same validated plan and rebuilds the registry", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeLifecycle(root, "WBS-001-004");
    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"), "utf8")).toContain("\"nodeId\": \"node-api\"");
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toContain("id: APR-WBS-001-004");
  });

  test("does not write a changeset when Evidence or Approval is missing", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeEvidence(root, "WBS-001-004");
    writeReview(root, "WBS-001-004");
    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("does not mutate an existing Approval record", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeLifecycle(root, "WBS-001-004");
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
  });

  test("returns bounded blocker output for root-node completion", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "node-root" }) as unknown as Record<string, unknown>);
    writeLifecycle(root, "WBS-001-004");
    const preview = buildCompletionPreview(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", allowRoot: false });
    expect(preview).toContain("Completion apply blocked:");
    expect(preview).toContain("--allow-root is required");
    expect(preview).not.toContain("approvedAt");
  });
});
