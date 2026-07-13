import { describe, expect, test } from "vitest";
import { validateHumanGateApproval } from "../../src/core/human-gate.js";
import { sampleApproval, sampleEvidence, sampleTask } from "../helpers.js";

describe("Human Gate approval scope", () => {
  const task = sampleTask({ humanGateRequiredPaths: ["package.json", ".github/**"] });
  const evidence = sampleEvidence({
    changedFiles: ["src/feature.ts"],
    subjectHeadCommit: "head123",
    diffHash: "diff123"
  });

  test("does not require Approval when Evidence has no Human Gate files", () => {
    expect(validateHumanGateApproval(task, evidence, undefined)).toMatchObject({
      required: false,
      approved: true,
      issues: []
    });
  });

  test.each(["requested", "rejected"] as const)("rejects %s Approval for Human Gate files", (status) => {
    const result = validateHumanGateApproval(
      task,
      { ...evidence, changedFiles: ["package.json"] },
      sampleApproval({ status })
    );
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "approval.status", severity: "error" })
    ]));
  });

  test("requires Approval when Evidence has Human Gate files", () => {
    const result = validateHumanGateApproval(task, { ...evidence, changedFiles: [".github/workflows/ci.yml"] }, undefined);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "approval.missing", severity: "error" })
    ]));
  });

  test("rejects approved records outside the Evidence head and diff scope", () => {
    const result = validateHumanGateApproval(
      task,
      { ...evidence, changedFiles: ["package.json"] },
      sampleApproval({
        status: "approved",
        approvedBy: "Human Reviewer",
        approvedAt: "2026-07-13T00:00:00.000Z",
        headCommit: "old-head",
        diffHash: "old-diff"
      })
    );
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "approval.scope.headCommit",
      "approval.scope.diffHash"
    ]);
  });

  test("accepts approved records matching the Evidence head and diff scope", () => {
    const result = validateHumanGateApproval(
      task,
      { ...evidence, changedFiles: ["package.json"] },
      sampleApproval({
        status: "approved",
        approvedBy: "Human Reviewer",
        approvedAt: "2026-07-13T00:00:00.000Z",
        headCommit: "head123",
        diffHash: "diff123"
      })
    );
    expect(result).toMatchObject({ required: true, approved: true, issues: [] });
  });

  test("rejects current approved records without recorded scope", () => {
    const result = validateHumanGateApproval(
      task,
      { ...evidence, changedFiles: ["package.json"] },
      sampleApproval({
        status: "approved",
        approvedBy: "Human Reviewer",
        approvedAt: "2026-07-13T00:00:00.000Z"
      })
    );
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "approval.scope.headCommit",
      "approval.scope.diffHash"
    ]);
  });

  test("keeps explicitly legacy-recorded approved scope compatible", () => {
    const result = validateHumanGateApproval(
      task,
      {
        ...evidence,
        changedFiles: ["package.json"],
        git: { ...evidence.git, changedFilesBasis: "legacy-recorded" }
      },
      sampleApproval({
        status: "approved",
        approvedBy: "Human Reviewer",
        approvedAt: "2026-07-13T00:00:00.000Z"
      })
    );
    expect(result).toMatchObject({ required: true, approved: true, issues: [] });
  });

  test("keeps Evidence created before subject scope fields compatible", () => {
    const result = validateHumanGateApproval(
      task,
      {
        ...evidence,
        changedFiles: ["package.json"],
        subjectHeadCommit: undefined,
        diffHash: undefined,
        git: undefined
      },
      sampleApproval({
        status: "approved",
        approvedBy: "Human Reviewer",
        approvedAt: "2026-07-13T00:00:00.000Z"
      })
    );
    expect(result).toMatchObject({ required: true, approved: true, issues: [] });
  });
});
