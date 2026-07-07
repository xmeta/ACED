import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildApprovalApproveYaml, buildApprovalRequestYaml, runApprovalApprove, runApprovalRequest } from "../../src/commands/approval-request.js";
import { main } from "../../src/cli.js";
import { readApproval } from "../../src/core/contracts.js";
import { makeTempRepo, sampleTask, sampleEvidence, sampleApproval, writeScwbsProject, writeJson, writeYaml } from "../helpers.js";

describe("approval", () => {
  test("approval request writes a requested approval record", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalRequest(root, "WBS-001-004", { pullRequest: "#42", note: "Awaiting human review", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toBe(buildApprovalRequestYaml("WBS-001-004", { pullRequest: "#42", note: "Awaiting human review" }));
    expect(actual).toContain("status: requested");
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

    expect(runApprovalApprove(root, "WBS-001-004", { pullRequest: "#42", reason: "Evidence and PR reviewed", force: false })).toBe(0);
    const actual = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(actual).toContain("status: approved");
    expect(actual).toContain("approvedBy: human");
    expect(actual).toContain("approvedAt:");
    expect(actual).toContain("headCommit: abc1234");
    expect(actual).toContain("diffHash: diff1234");
    expect(actual).toContain('pullRequest: "#42"');
    expect(actual).toContain("reason: Evidence and PR reviewed");
  });

  test("approval approve rejects AI execution mode", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "AI should not approve", actor: "ai", force: false })).toBe(1);
    expect(readApproval(root, "WBS-001-004").approval).toBeUndefined();
  });

  test("approval approve updates requested records and protects existing approvals", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);

    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Reviewed", force: false })).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(runApprovalApprove(root, "WBS-001-004", { reason: "Second approval", force: false })).toBe(1);
    expect(readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8")).toBe(before);
  });

  test("approval approve CLI accepts inline multi-word reason syntax", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);

    expect(main(["approval", "approve", "--task", "WBS-001-004", "--pull-request", "#42", "--reason=Evidence and PR reviewed"], root)).toBe(0);
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
