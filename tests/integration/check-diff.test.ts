import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectBranchIssues, collectDiffIssues, collectEvidenceGateIssues, runCheckDiff } from "../../src/commands/check-diff.js";
import { baseBranchStatus, branchChangedFiles, branchDiffHash, filesAddedOnBothSides, headCommit, workingTreeChangedFiles } from "../../src/core/git.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleEvidence, sampleApproval, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

describe("check-diff", () => {
  test("check-diff passes allowed files and flags forbidden files", () => {
    const root = makeTempRepo();
    const task = sampleTask();
    expect(collectDiffIssues(root, task, ["src/features/api/index.ts"])).toEqual([]);
    expect(collectDiffIssues(root, task, ["src/auth/session.ts"]).some((issue) => issue.code === "diff.forbiddenPaths")).toBe(true);
  });

  test("check-diff validates nested submodule paths and upstream provenance", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const task = sampleTask({
      allowedPaths: ["vendor/dependency", "vendor/dependency/secret.txt", "vendor/dependency/security/**"],
      forbiddenPaths: ["vendor/dependency/secret.txt"],
      humanGateRequiredPaths: ["vendor/dependency/security/**"],
      submoduleDependencies: [{ path: "vendor/dependency", repository: "example/dependency", pullRequest: "#4" }]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["vendor/dependency"],
      submodules: [{
        path: "vendor/dependency",
        repository: "example/dependency",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        changedFiles: ["secret.txt", "security/key.txt", "outside.txt"],
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/main",
        upstreamReachable: false,
        checks: [{ name: "upstream-ci", status: "failed" }]
      }]
    }) as unknown as Record<string, unknown>);

    const issues = collectDiffIssues(root, task, ["vendor/dependency"]);
    expect(issues.some((issue) => issue.code === "diff.forbiddenPaths" && issue.message.includes("vendor/dependency/secret.txt"))).toBe(true);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths" && issue.message.includes("vendor/dependency/outside.txt"))).toBe(true);
    expect(issues.some((issue) => issue.code === "diff.humanGate" && issue.message.includes("vendor/dependency/security/key.txt"))).toBe(true);
    expect(issues.some((issue) => issue.code === "diff.submodule.upstreamReachable")).toBe(true);
    expect(issues.some((issue) => issue.code === "diff.submodule.check")).toBe(true);
  });

  test("check-diff requires nested Evidence for configured changed gitlinks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const task = sampleTask({
      allowedPaths: ["vendor/dependency"],
      submoduleDependencies: [{ path: "vendor/dependency", repository: "example/dependency" }]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: ["vendor/dependency"] }) as unknown as Record<string, unknown>);
    expect(collectDiffIssues(root, task, ["vendor/dependency"]).some((issue) => issue.code === "diff.submodule.evidence.missing")).toBe(true);
  });

  test("check-diff enforces broad path policies with multiple required checks", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/check-coverage.yaml", {
      rules: [{ id: "broad", paths: ["wjs", "wjs/**", "src/commands/**"], requires: ["test:wjs", "test:integration"] }]
    });
    const task = sampleTask({ requiredChecks: ["test"] });
    const issues = collectDiffIssues(root, task, ["wjs", "src/commands/finish.ts"]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.checkCoverage.missing", message: expect.stringContaining("test:wjs") }),
      expect.objectContaining({ code: "diff.checkCoverage.missing", message: expect.stringContaining("test:integration") })
    ]));
  });

  test("check coverage waiver requires a reason and Human Approval scoped to Evidence", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/check-coverage.yaml", {
      rules: [{ id: "integration", paths: ["src/commands/**"], requires: ["test:integration"] }]
    });
    const task = sampleTask({
      requiredChecks: ["test"],
      checkCoverageWaivers: [{ check: "test:integration", reason: "External integration environment is unavailable" }]
    });
    expect(collectDiffIssues(root, task, ["src/commands/finish.ts"]).some((issue) => issue.code === "diff.checkCoverage.waiver.approval")).toBe(true);

    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/commands/finish.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    const subjectHead = headCommit(root)!;
    const subjectDiffHash = branchDiffHash(root, "base", [
      "contracts/evidence/WBS-001-004.yaml", "contracts/approvals/WBS-001-004.yaml", "contracts/reviews/WBS-001-004.yaml", "contracts/registry.yaml"
    ]);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: subjectHead, diffHash: subjectDiffHash, git: { base: "base", subjectHeadCommit: subjectHead, diffHash: subjectDiffHash }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved", approvedBy: "Human Reviewer", approvedAt: "2026-07-13T10:00:00Z", headCommit: subjectHead, diffHash: subjectDiffHash
    }) as unknown as Record<string, unknown>);
    expect(collectDiffIssues(root, task, ["src/commands/finish.ts"]).some((issue) => issue.code === "diff.checkCoverage.waiver.approval")).toBe(false);

    writeText(root, "src/commands/finish.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "implementation changed after approval"], { cwd: root, stdio: "ignore" });
    expect(collectDiffIssues(root, task, ["src/commands/finish.ts"]).some((issue) => issue.code === "diff.checkCoverage.waiver.approval")).toBe(true);
  });

  test("check-diff flags current branch mismatches", () => {
    const task = sampleTask({ branchName: "task/WBS-001-004-api-implementation" });
    expect(collectBranchIssues(task, "task/WBS-001-004-api-implementation")).toEqual([]);
    expect(collectBranchIssues(task, "task/OTHER").some((issue) => issue.code === "diff.branchName")).toBe(true);
  });

  test("check-diff requires evidence before PR readiness", () => {
    const root = makeTempRepo();
    const task = sampleTask();
    const missingIssues = collectEvidenceGateIssues(root, task);
    expect(missingIssues.some((issue) => issue.code === "diff.evidence.missing")).toBe(true);

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    expect(collectEvidenceGateIssues(root, task)).toEqual([]);
  });

  test("check-diff flags sensitive meta files unless they are explicitly allowed", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: ["src/**", "docs/**"],
      humanGateRequiredPaths: []
    });
    const issues = collectDiffIssues(root, task, ["package.json"]);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(true);
  });

  test("check-diff does not flag explicitly allowed sensitive meta files", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: ["src/**", "docs/**", "package.json"],
      humanGateRequiredPaths: []
    });
    const issues = collectDiffIssues(root, task, ["package.json"]);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff errors on human-gated sensitive meta files without approved approval", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate" && issue.severity === "error")).toBe(true);
    expect(issues.find((issue) => issue.code === "diff.humanGate")?.fixCommand).toContain("npm run scwbs -- approval request --task WBS-001-004");
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff accepts human-gated sensitive meta files with approved approval", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-05T14:30:00.000Z",
      headCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate")).toBe(false);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff rejects human-gate approvals that do not match evidence diff scope", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "abc1234",
      diffHash: "diff1234"
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-05T14:30:00.000Z",
      headCommit: "abc1234",
      diffHash: "old-diff"
    }) as unknown as Record<string, unknown>);
    const task = sampleTask({
      allowedPaths: [],
      humanGateRequiredPaths: ["tsconfig.json"]
    });
    const issues = collectDiffIssues(root, task, ["tsconfig.json"]);
    expect(issues.some((issue) => issue.code === "diff.humanGate" && issue.severity === "error")).toBe(true);
  });

  test("check-diff treats managedContractPaths as exempt from allowedPaths and the meta-file guard (M2-019)", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: ["src/**"],
      managedContractPaths: ["contracts/evidence/WBS-001-004.yaml", "package.json"]
    });
    const issues = collectDiffIssues(root, task, ["contracts/evidence/WBS-001-004.yaml", "package.json"]);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths")).toBe(false);
    expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(false);
  });

  test("check-diff never exempts forbiddenPaths via managedContractPaths (M2-019)", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      forbiddenPaths: ["src/auth/**"],
      managedContractPaths: ["src/auth/**"]
    });
    const issues = collectDiffIssues(root, task, ["src/auth/session.ts"]);
    expect(issues.some((issue) => issue.code === "diff.forbiddenPaths")).toBe(true);
  });

  test("check-diff issues always carry a fixCommand (M2-022)", () => {
    const root = makeTempRepo();
    const task = sampleTask();
    const issues = collectDiffIssues(root, task, ["src/unrelated/handler.ts"]);
    const errors = issues.filter((issue) => issue.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((issue) => typeof issue.fixCommand === "string" && issue.fixCommand.length > 0)).toBe(true);
  });

  test("check-diff can emit CI-friendly JSON output", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ branchName: "master" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({ status: "pass", taskId: "WBS-001-004", issues: [] });
  });

  test("check-diff requires a semantic WBS operation change set when WBS changes", () => {
    const root = makeTempRepo();
    const task = sampleTask({ allowedPaths: ["contracts/**"] });
    const issues = collectDiffIssues(root, task, ["contracts/wbs/project.wbs.json"]);
    expect(issues.some((issue) => issue.code === "diff.wbs.changeset.required")).toBe(true);
    const wbsIssue = issues.find((issue) => issue.code === "diff.wbs.changeset.required");
    expect(wbsIssue?.fixCommand).toContain("wbs apply contracts/changesets/");
    expect(wbsIssue?.message).toContain("WBS direct edit detected");
    expect(collectDiffIssues(root, task, ["contracts/wbs/project.wbs.json", "contracts/changesets/change.json"]).some((issue) => issue.code === "diff.wbs.changeset.required")).toBe(false);
  });

  test("check-diff validates WBS operation change sets with WJS validate", () => {
    const root = makeTempRepo();
    writeText(root, "wjs/tools/validate.ts", "if (process.argv.includes('--operations')) process.exit(1);");
    const task = sampleTask({ allowedPaths: ["contracts/**"] });
    const issues = collectDiffIssues(root, task, ["contracts/changesets/change.json"]);
    expect(issues.some((issue) => issue.code.startsWith("diff.wbsOperations."))).toBe(true);
  });

  test("git changed file helpers split working-tree and branch diff basis", () => {
    const root = makeTempRepo();
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "branch change"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/uncommitted.ts", "export const pending = true;\n");
    writeText(root, "src/features/api/untracked.ts", "export const extra = true;\n");

    expect(branchChangedFiles(root, "base")).toEqual(["src/features/api/index.ts"]);
    expect(workingTreeChangedFiles(root).sort()).toEqual([
      "src/features/api/uncommitted.ts",
      "src/features/api/untracked.ts"
    ]);
  });

  test("git helpers detect branch lag and same-path additions on base", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });

    execFileSync("git", ["switch", "-c", "feature"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/SCWBS-030.yaml", sampleTask({ id: "SCWBS-030", featureId: "F-OURS" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature task"], { cwd: root, stdio: "ignore" });

    execFileSync("git", ["switch", "-c", "upstream", "refs/remotes/origin/main"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/SCWBS-030.yaml", sampleTask({ id: "SCWBS-030", featureId: "F-THEIRS" }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "upstream task"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    execFileSync("git", ["switch", "feature"], { cwd: root, stdio: "ignore" });

    expect(baseBranchStatus(root).isBehind).toBe(true);
    expect(filesAddedOnBothSides(root)).toContain("contracts/tasks/SCWBS-030.yaml");
  }, 30000);

  test("check-diff uses branch diff files from the requested base", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ branchName }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    writeText(root, "src/auth/session.ts", "export const forbidden = true;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "forbidden branch change"], { cwd: root, stdio: "ignore" });

    expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base" })).toBe(1);
  });
});
