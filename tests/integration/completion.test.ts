import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildCompletionPreview, runCompletionApply } from "../../src/commands/completion.js";
import { readApproval } from "../../src/core/contracts.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleEvidence, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

describe("completion apply", () => {
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
    writeJson(root, "wjs/package.json", {
      scripts: {
        apply: "node tools/apply.cjs"
      }
    });
  }

  function writeApprovedApproval(root: string, taskId: string, overrides: Record<string, unknown> = {}): void {
    writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
      id: `APR-${taskId}`,
      type: "approval",
      taskId,
      status: "approved",
      approvedBy: "human",
      approvedAt: "2026-07-14T00:00:00.000Z",
      headCommit: "abc1234",
      diffHash: "sha256:fake-diff-hash",
      pullRequest: "#42",
      reason: "Reviewed and accepted",
      ...overrides
    });
  }

  function sampleEvidenceWithGit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return sampleEvidence({
      git: {
        branch: "task/WBS-001-004-api-implementation",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#42",
        diffHash: "sha256:fake-diff-hash"
      },
      ...overrides
    }) as unknown as Record<string, unknown>;
  }

  function readWbs(root: string): { nodes: Array<{ id: string; status: string }> } {
    return JSON.parse(readFileSync(path.join(root, "contracts/wbs/project.wbs.json"), "utf8"));
  }

  test("completion apply dry-run previews approved records and WBS changeset operations", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeApprovedApproval(root, "WBS-001-004");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());

    const preview = buildCompletionPreview(root, " WBS-001-004 ", "WBS-001-999", { reason: "Reviewed and accepted", allowRoot: false });
    expect(preview).toContain("Completion apply dry-run:");
    expect(preview).toContain("- WBS-001-004: 1.1 API Implementation -> completed");
    expect(preview).toContain("approval: approved record validated");
    expect(preview).toContain("changeset: contracts/changesets/WBS-001-999-complete-reviewed-work.json");
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
  });

  test("completion apply dry-run previews node-level completion targets", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      wbsNodeId: "node-api",
      branchName: "codex/wbs-001-006-node-completion",
      completionScope: "node",
      completionTaskIds: ["WBS-001-004", "WBS-001-005"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeApprovedApproval(root, "WBS-001-004", { pullRequest: "#41" });
    writeApprovedApproval(root, "WBS-001-005", { headCommit: "abc1235", pullRequest: "#42" });
    writeApprovedApproval(root, "WBS-001-006", { headCommit: "abc1236", pullRequest: "#43" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      id: "EVD-001-004",
      taskId: "WBS-001-004",
      git: {
        branch: "codex/wbs-001-004-api",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#41",
        diffHash: "sha256:fake-diff-hash"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005",
      git: {
        branch: "codex/wbs-001-005-api",
        base: "main",
        headCommit: "abc1235",
        pullRequest: "#42",
        diffHash: "sha256:fake-diff-hash"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-006.yaml", sampleEvidence({
      id: "EVD-001-006",
      taskId: "WBS-001-006",
      git: {
        branch: "codex/wbs-001-006-node-completion",
        base: "main",
        headCommit: "abc1236",
        pullRequest: "#43",
        diffHash: "sha256:fake-diff-hash"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-005.yaml", {
      id: "RVW-WBS-001-005",
      type: "review",
      taskId: "WBS-001-005",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-005.yaml", "contracts/evidence/WBS-001-005.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-006.yaml", {
      id: "RVW-WBS-001-006",
      type: "review",
      taskId: "WBS-001-006",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#43",
      groundTruth: ["contracts/tasks/WBS-001-006.yaml", "contracts/evidence/WBS-001-006.yaml"]
    });

    const preview = buildCompletionPreview(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed and accepted", allowRoot: false });
    expect(preview).toContain("Completion apply dry-run:");
    expect(preview).toContain("- WBS-001-006: 1.1 API Implementation -> completed");
    expect(preview).toContain("completionTargets:");
    expect(preview).toContain("- WBS-001-004: 1.1 API Implementation");
    expect(preview).toContain("- WBS-001-005: 1.1 API Implementation");
    expect(preview).toContain("approval: approved record validated");
  });

  test("completion apply rejects root node completion by default", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ wbsNodeId: "node-root" }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004");

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
  });

  test("completion apply writes approvals applies WBS changeset and rebuilds registry", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004");

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed and accepted", apply: true, allowRoot: false })).toBe(0);
    expect(readApproval(root, "WBS-001-004").approval?.status).toBe("approved");
    expect(readFileSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"), "utf8")).toContain("\"nodeId\": \"node-api\"");
    const wbs = readWbs(root);
    expect(wbs.nodes.find((node) => node.id === "node-api")?.status).toBe("completed");
    const registry = readFileSync(path.join(root, "contracts/registry.yaml"), "utf8");
    expect(registry).toContain("id: APR-WBS-001-004");
    expect(registry).toContain("type: approval");
  });

  test("completion apply writes approvals for node-level completion tasks and completes the shared node", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-006.yaml", sampleTask({
      id: "WBS-001-006",
      wbsNodeId: "node-api",
      branchName: "codex/wbs-001-006-node-completion",
      completionScope: "node",
      completionTaskIds: ["WBS-001-004", "WBS-001-005"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeApprovedApproval(root, "WBS-001-004", { pullRequest: "#41" });
    writeApprovedApproval(root, "WBS-001-005", { headCommit: "abc1235", pullRequest: "#42" });
    writeApprovedApproval(root, "WBS-001-006", { headCommit: "abc1236", pullRequest: "#43" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      id: "EVD-001-004",
      taskId: "WBS-001-004",
      git: {
        branch: "codex/wbs-001-004-api",
        base: "main",
        headCommit: "abc1234",
        pullRequest: "#41",
        diffHash: "sha256:fake-diff-hash"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-005.yaml", sampleEvidence({
      id: "EVD-001-005",
      taskId: "WBS-001-005",
      git: {
        branch: "codex/wbs-001-005-api",
        base: "main",
        headCommit: "abc1235",
        pullRequest: "#42",
        diffHash: "sha256:fake-diff-hash"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-006.yaml", sampleEvidence({
      id: "EVD-001-006",
      taskId: "WBS-001-006",
      git: {
        branch: "codex/wbs-001-006-node-completion",
        base: "main",
        headCommit: "abc1236",
        pullRequest: "#43",
        diffHash: "sha256:fake-diff-hash"
      }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-005.yaml", {
      id: "RVW-WBS-001-005",
      type: "review",
      taskId: "WBS-001-005",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#42",
      groundTruth: ["contracts/tasks/WBS-001-005.yaml", "contracts/evidence/WBS-001-005.yaml"]
    });
    writeYaml(root, "contracts/reviews/WBS-001-006.yaml", {
      id: "RVW-WBS-001-006",
      type: "review",
      taskId: "WBS-001-006",
      status: "requested",
      reviewProfile: "independent-ai-review",
      pullRequest: "#43",
      groundTruth: ["contracts/tasks/WBS-001-006.yaml", "contracts/evidence/WBS-001-006.yaml"]
    });

    expect(runCompletionApply(root, "WBS-001-006", "WBS-001-999", { reason: "Reviewed and accepted", apply: true, allowRoot: false })).toBe(0);
    expect(readApproval(root, "WBS-001-006").approval?.status).toBe("approved");
    expect(readFileSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"), "utf8")).toContain("\"nodeId\": \"node-api\"");
    const wbs = readWbs(root);
    expect(wbs.nodes.find((node) => node.id === "node-api")?.status).toBe("completed");
    const registry = readFileSync(path.join(root, "contracts/registry.yaml"), "utf8");
    expect(registry).toContain("id: APR-WBS-001-006");
    expect(registry).toContain("type: approval");
  });

  test("completion apply fails when no approval exists", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
    const wbs = readWbs(root);
    expect(wbs.nodes.find((node) => node.id === "node-api")?.status).toBe("ready");
  });

  test("completion apply fails when approval is requested", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004", { status: "requested" });

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("completion apply fails when approval is rejected", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004", { status: "rejected" });

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("completion apply fails on headCommit mismatch", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004", { headCommit: "different-commit" });

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("completion apply fails on diffHash mismatch", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004", { diffHash: "sha256:different-hash" });

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: true, allowRoot: false })).toBe(1);
    expect(existsSync(path.join(root, "contracts/changesets/WBS-001-999-complete-reviewed-work.json"))).toBe(false);
  });

  test("completion apply does not modify approval file", () => {
    const root = makeTempRepo();
    writeFakeWjsApply(root);
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());
    writeApprovedApproval(root, "WBS-001-004", { approvedBy: "original-human", reason: "Original approval" });
    const before = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed and accepted", apply: true, allowRoot: false })).toBe(0);

    const after = readFileSync(path.join(root, "contracts/approvals/WBS-001-004.yaml"), "utf8");
    expect(after).toBe(before);
    expect(readApproval(root, "WBS-001-004").approval?.approvedBy).toBe("original-human");
    expect(readApproval(root, "WBS-001-004").approval?.reason).toBe("Original approval");
  });

  test("completion apply dry-run fails when no approval exists", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "ready");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidenceWithGit());

    expect(runCompletionApply(root, "WBS-001-004", "WBS-001-999", { reason: "Reviewed", apply: false, allowRoot: false })).toBe(1);
  });
});
