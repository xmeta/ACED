import { describe, expect, test } from "vitest";
import {
  validateApprovalRecordSchema,
  validateBlockRecordSchema,
  validateEvidenceSchema,
  validateReviewRecordSchema,
} from "../../src/core/schema/records.js";

describe("core-docs-samples: docs YAML examples pass current schema", () => {
  test("Approval sample from 03-minimal-artifacts.md passes schema", () => {
    const approval = {
      id: "APR-WBS-001",
      type: "approval",
      taskId: "WBS-001",
      status: "approved",
      approvedBy: "human",
      approvedAt: "2026-07-03T10:00:00+09:00",
      reason: "レビュー済み",
      pullRequest: "#42",
      headCommit: "abc1234",
      diffHash: "sha256:...",
    };
    const issues = validateApprovalRecordSchema(approval, "docs/03-minimal-artifacts.md");
    expect(issues).toEqual([]);
  });

  test("Approval sample from 05-diff-evidence-approval.md passes schema", () => {
    const approval = {
      id: "APR-WBS-001",
      type: "approval",
      taskId: "WBS-001",
      status: "approved",
      pullRequest: "#42",
      headCommit: "abc1234",
      diffHash: "sha256:...",
    };
    const issues = validateApprovalRecordSchema(approval, "docs/05-diff-evidence-approval.md");
    expect(issues).toEqual([]);
  });

  test("Approval sample from 10-decisions.md DEC-005 passes schema", () => {
    const approval = {
      id: "APR-WBS-001",
      type: "approval",
      taskId: "WBS-001",
      status: "approved",
      pullRequest: "#42",
      headCommit: "abc1234",
      diffHash: "sha256:...",
    };
    const issues = validateApprovalRecordSchema(approval, "docs/10-decisions.md");
    expect(issues).toEqual([]);
  });

  test("Block sample from 03-minimal-artifacts.md passes schema", () => {
    const block = {
      id: "BLK-WBS-001",
      type: "block",
      taskId: "WBS-001",
      status: "blocked",
      level: 2,
      category: "db",
      reason: "DB schema change is required",
      requiredHumanDecision: "staff_availability table を追加してよいか",
      createdAt: "2026-07-03T10:00:00+09:00",
      history: [
        {
          status: "blocked",
          at: "2026-07-03T10:00:00+09:00",
          reason: "DB schema change is required",
          by: "ai-agent",
        },
      ],
    };
    const issues = validateBlockRecordSchema(block, "docs/03-minimal-artifacts.md");
    expect(issues).toEqual([]);
  });

  test("Evidence sample passes schema", () => {
    const evidence = {
      id: "EVD-WBS-001",
      type: "evidence",
      taskId: "WBS-001",
      changedFiles: ["src/index.ts"],
      git: {
        branch: "task/WBS-001",
        base: "main",
        headCommit: "abc1234",
        subjectHeadCommit: "abc1234",
        diffHash: "sha256:...",
      },
      checks: [
        { name: "test", status: "passed" },
        { name: "typecheck", status: "passed" },
        { name: "build", status: "passed" },
      ],
    };
    const issues = validateEvidenceSchema(evidence, "docs/evidence-sample");
    expect(issues).toEqual([]);
  });

  test("Review sample passes schema", () => {
    const review = {
      id: "REV-WBS-001",
      type: "review",
      taskId: "WBS-001",
      status: "approved",
      reviewProfile: "independent-ai-review",
      groundTruth: ["Task Contract", "Packet", "Spec Slice", "actual diff", "Evidence"],
      reviewedBy: "reviewer-ai",
      reviewedAt: "2026-07-03T10:00:00+09:00",
    };
    const issues = validateReviewRecordSchema(review, "docs/review-sample");
    expect(issues).toEqual([]);
  });
});
