import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { validateHumanGateApproval } from "../../src/core/human-gate.js";
import { headCommit } from "../../src/core/git.js";
import { makeTempRepo, sampleApproval, sampleEvidence, sampleTask, writeText } from "../helpers.js";

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

  test("selects only the human-gate slot from a complete v2 bundle", () => {
    const result = validateHumanGateApproval(
      task,
      { ...evidence, changedFiles: ["package.json"] },
      {
        id: "APR-WBS-001-004",
        type: "approval",
        taskId: "WBS-001-004",
        version: "scwbs.approval.v2",
        activeScope: "post-finish",
        scopeApprovals: {
          "human-gate": { status: "requested" },
          "post-finish": { status: "approved", approvedBy: "human", approvedAt: "2026-07-13T00:00:00.000Z", headCommit: "head123", diffHash: "diff123" }
        },
        status: "approved",
        approvedBy: "human",
        approvedAt: "2026-07-13T00:00:00.000Z",
        headCommit: "head123",
        diffHash: "diff123"
      }
    );
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "approval.status" })]));
  });

  test.each([
    ["headCommit", "stale-head", "approval.scope.headCommit"],
    ["diffHash", "stale-diff", "approval.scope.diffHash"],
    ["pullRequest", "#41", "approval.scope.pullRequest"]
  ] as const)("rejects v2 Human Gate %s drift", (field, value, code) => {
    const scopedEvidence = {
      ...evidence,
      changedFiles: ["package.json"],
      git: { ...evidence.git, pullRequest: "#42" }
    };
    const slot = {
      status: "approved" as const,
      approvedBy: "human",
      approvedAt: "2026-07-13T00:00:00.000Z",
      approvalMode: "human" as const,
      headCommit: "head123",
      diffHash: "diff123",
      pullRequest: "#42",
      reason: "Human reviewed the scoped Evidence",
      actorId: "human",
      actorSource: "tty",
      verifiedAt: "2026-07-13T00:00:00.000Z",
      verificationLevel: "lean"
    };
    const drifted = { ...slot, [field]: value };
    const result = validateHumanGateApproval(task, scopedEvidence, {
      id: "APR-WBS-001-004",
      type: "approval",
      taskId: "WBS-001-004",
      version: "scwbs.approval.v2",
      activeScope: "human-gate",
      scopeApprovals: { "human-gate": drifted },
      ...drifted
    });
    expect(result.issues.map((issue) => issue.code)).toContain(code);
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

  test("preserves Approval across metadata-only descendant commits", () => {
    const root = makeTempRepo();
    writeText(root, "README.md", "base\n");
    commitAll(root, "base");
    writeText(root, "package.json", "{}\n");
    const approvedHead = commitAll(root, "implementation");
    const subjectHead = addTaskMetadata(root, task.id);
    const scopedEvidence = { ...evidence, changedFiles: ["package.json"], subjectHeadCommit: subjectHead, diffHash: "same-diff" };
    const scopedApproval = sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-13T00:00:00.000Z",
      headCommit: approvedHead,
      diffHash: "same-diff"
    });

    expect(validateHumanGateApproval(task, scopedEvidence, scopedApproval, scopedEvidence.changedFiles, root))
      .toMatchObject({ required: true, approved: true, issues: [] });

    const unscopedEvidence = { ...scopedEvidence, diffHash: undefined, git: undefined };
    const unscopedApproval = { ...scopedApproval, diffHash: undefined };
    expect(validateHumanGateApproval(task, unscopedEvidence, unscopedApproval, unscopedEvidence.changedFiles, root).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "approval.scope.headCommit" })]));
  });

  test.each([
    ["Gate", "package.json"],
    ["implementation", "src/feature.ts"],
    ["test", "tests/feature.test.ts"],
    ["dependency", "package-lock.json"],
    ["submodule", "wjs/nested-change.txt"]
  ])("invalidates Approval after %s changes", (_kind, changedPath) => {
    const root = makeTempRepo();
    writeText(root, "README.md", "base\n");
    commitAll(root, "base");
    writeText(root, "package.json", "{}\n");
    const approvedHead = commitAll(root, "implementation");
    addTaskMetadata(root, task.id);
    writeText(root, changedPath, "changed\n");
    const subjectHead = commitAll(root, "non-metadata change");
    const scopedEvidence = { ...evidence, changedFiles: ["package.json"], subjectHeadCommit: subjectHead, diffHash: "same-diff" };
    const scopedApproval = sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-13T00:00:00.000Z",
      headCommit: approvedHead,
      diffHash: "same-diff"
    });

    expect(validateHumanGateApproval(task, scopedEvidence, scopedApproval, scopedEvidence.changedFiles, root).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "approval.scope.headCommit" })]));
  });

  test("rejects Approval heads that are not ancestors of Evidence", () => {
    const root = makeTempRepo();
    writeText(root, "README.md", "base\n");
    commitAll(root, "base");
    writeText(root, "package.json", "{}\n");
    const approvedHead = commitAll(root, "approved branch");
    execFileSync("git", ["switch", "-c", "other", "HEAD~1"], { cwd: root, stdio: "ignore" });
    const subjectHead = addTaskMetadata(root, task.id);
    const scopedEvidence = { ...evidence, changedFiles: ["package.json"], subjectHeadCommit: subjectHead, diffHash: "same-diff" };
    const scopedApproval = sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-13T00:00:00.000Z",
      headCommit: approvedHead,
      diffHash: "same-diff"
    });

    expect(validateHumanGateApproval(task, scopedEvidence, scopedApproval, scopedEvidence.changedFiles, root).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "approval.scope.headCommit" })]));
  });

  test("invalidates Approval when implementation changed and was later reverted", () => {
    const root = makeTempRepo();
    writeText(root, "README.md", "base\n");
    commitAll(root, "base");
    writeText(root, "package.json", "{}\n");
    const approvedHead = commitAll(root, "implementation");
    addTaskMetadata(root, task.id);
    writeText(root, "src/feature.ts", "changed\n");
    commitAll(root, "temporary implementation change");
    execFileSync("git", ["rm", "src/feature.ts"], { cwd: root, stdio: "ignore" });
    const subjectHead = commitAll(root, "revert implementation change");
    const scopedEvidence = { ...evidence, changedFiles: ["package.json"], subjectHeadCommit: subjectHead, diffHash: "same-diff" };
    const scopedApproval = sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-13T00:00:00.000Z",
      headCommit: approvedHead,
      diffHash: "same-diff"
    });

    expect(validateHumanGateApproval(task, scopedEvidence, scopedApproval, scopedEvidence.changedFiles, root).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "approval.scope.headCommit" })]));
  }, 15000);
});
