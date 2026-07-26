import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectBranchIssues, collectDiffIssues, collectEvidenceGateIssues, runCheckDiff } from "../../src/commands/check-diff.js";
import { baseBranchStatus, branchChangedFiles, branchDiffHash, filesAddedOnBothSides, headCommit, workingTreeChangedFiles, workingTreeState } from "../../src/core/git.js";
import { changedTaskAuthorityFields, collectTaskAuthorityIssues } from "../../src/core/task-authority.js";
import { makeTempRepo, sampleTask, sampleWbs, sampleEvidence, sampleApproval, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

const standardHumanGatePaths = ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", ".github/**"];

function safeNewTask(taskId = "SCWBS-DRAFT-NEW") {
  return sampleTask({
    id: taskId,
    featureId: "F-NEW",
    wbsNodeId: "node-governance-maintenance",
    branchName: `task/${taskId}-safe`,
    allowedPaths: ["src/core/safe.ts", "tests/integration/safe.test.ts"],
    forbiddenPaths: ["wjs/**"],
    humanGateRequiredPaths: standardHumanGatePaths,
    requiredChecks: ["test", "test:integration", "typecheck", "build"],
    managedContractPaths: [
      `contracts/tasks/${taskId}.yaml`,
      "contracts/tasks/index.yaml",
      "contracts/registry.yaml",
      `contracts/evidence/${taskId}.yaml`,
      `contracts/approvals/${taskId}.yaml`
    ],
    contractLock: {
      lockVersion: "2",
      wbsScopeRevision: "scope",
      wbsGlobalRevision: "global",
      wbsNodeId: "node-governance-maintenance",
      createdAt: "2026-07-14T00:00:00.000Z"
    }
  });
}

describe("check-diff", () => {
  test("authority comparison detects every scope field but ignores contractLock refresh metadata", () => {
    const base = sampleTask({ managedContractPaths: ["contracts/evidence/WBS-001-004.yaml"] });
    const refreshed = sampleTask({
      managedContractPaths: ["contracts/evidence/WBS-001-004.yaml"],
      contractLock: { lockVersion: "2", wbsScopeRevision: "new", createdAt: "2026-07-14T00:00:00.000Z" }
    });
    expect(changedTaskAuthorityFields(base, refreshed)).toEqual([]);

    const weakened = sampleTask({
      allowedPaths: [...base.allowedPaths, "src/outside.ts"],
      forbiddenPaths: [],
      humanGateRequiredPaths: [],
      requiredChecks: ["test"],
      managedContractPaths: [...(base.managedContractPaths ?? []), "contracts/registry.yaml"],
      checkCoverageWaivers: [{ check: "test:integration", reason: "skip" }],
      submoduleDependencies: [{
        path: "vendor/dependency",
        authorityMode: "upstream-release",
        repository: "example/dependency",
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/main",
        checks: [{ name: "upstream-ci", status: "passed" }]
      }],
      approvalPolicy: {
        mode: "delegated",
        delegatedBy: "owner",
        delegatedTo: "ai-agent",
        scopes: ["human-gate"],
        source: "issue-222",
        reason: "automation",
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSha256: `sha256:${"a".repeat(64)}`
      }
    });
    expect(changedTaskAuthorityFields(base, weakened)).toEqual([
      "allowedPaths",
      "forbiddenPaths",
      "humanGateRequiredPaths",
      "requiredChecks",
      "managedContractPaths",
      "checkCoverageWaivers",
      "submoduleDependencies",
      "approvalPolicy"
    ]);
  });

  test("check-diff rejects self-expanded allowedPaths instead of accepting the widened head contract", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    const baseTask = sampleTask({
      branchName,
      managedContractPaths: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", baseTask as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", {
      ...baseTask,
      allowedPaths: [...baseTask.allowedPaths, "src/outside.ts"]
    });
    writeText(root, "src/outside.ts", "export const outside = true;\n");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: ["contracts/tasks/WBS-001-004.yaml", "src/outside.ts"] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "self widen"], { cwd: root, stdio: "ignore" });

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n")).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.taskAuthority.change", message: expect.stringContaining("allowedPaths") })
    ]));
  });

  test("check-diff also rejects an uncommitted Task Contract expansion", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    const baseTask = sampleTask({
      branchName,
      managedContractPaths: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", baseTask as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/outside.ts", "export const outside = true;\n");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: ["src/outside.ts"] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "outside change"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", { ...baseTask, allowedPaths: [...baseTask.allowedPaths, "src/outside.ts"] });

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n")).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.taskAuthority.change", message: expect.stringContaining("allowedPaths") })
    ]));
  });

  test("authority changes accept current-scope Human Approval without creating approval records", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const baseTask = sampleTask({ managedContractPaths: ["contracts/tasks/WBS-001-004.yaml"] });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", baseTask as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", { ...baseTask, requiredChecks: ["test"] });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "authority change"], { cwd: root, stdio: "ignore" });
    const subjectHead = headCommit(root)!;
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: subjectHead,
      diffHash: "approved-authority-diff",
      changedFiles: ["contracts/tasks/WBS-001-004.yaml"]
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval({
      status: "approved",
      approvedBy: "Human Reviewer",
      approvedAt: "2026-07-14T00:00:00.000Z",
      headCommit: subjectHead,
      diffHash: "approved-authority-diff"
    }) as unknown as Record<string, unknown>);
    const headTask = { ...baseTask, requiredChecks: ["test"] };
    expect(collectTaskAuthorityIssues(root, headTask, "base", ["contracts/tasks/WBS-001-004.yaml"])).toEqual([]);
  });

  test("a separate existing governance task can change another task authority", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const target = sampleTask({ id: "TARGET", featureId: "F-TARGET" });
    const governance = sampleTask({
      id: "GOVERNANCE",
      featureId: "F-GOV",
      wbsNodeId: "node-governance-maintenance",
      allowedPaths: ["contracts/tasks/TARGET.yaml"],
      managedContractPaths: ["contracts/tasks/GOVERNANCE.yaml"]
    });
    writeYaml(root, "contracts/tasks/TARGET.yaml", target as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/GOVERNANCE.yaml", governance as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeYaml(root, "contracts/tasks/TARGET.yaml", { ...target, allowedPaths: [...target.allowedPaths, "src/new.ts"] });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "governed scope change"], { cwd: root, stdio: "ignore" });
    expect(collectTaskAuthorityIssues(root, governance, "base", ["contracts/tasks/TARGET.yaml"])).toEqual([]);
  });

  test("a safe contract-only first commit is the fail-closed trust root for a new task", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    const task = safeNewTask();
    writeYaml(root, "contracts/tasks/SCWBS-DRAFT-NEW.yaml", task as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "new task contract"], { cwd: root, stdio: "ignore" });
    expect(collectTaskAuthorityIssues(root, task, "base", ["contracts/tasks/SCWBS-DRAFT-NEW.yaml"])).toEqual([]);
  });

  test("new task trust fails for uncommitted, mixed, broad, and shallow creation states", () => {
    const uncommittedRoot = makeTempRepo();
    writeScwbsProject(uncommittedRoot);
    execFileSync("git", ["add", "."], { cwd: uncommittedRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: uncommittedRoot, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: uncommittedRoot });
    const task = safeNewTask();
    writeYaml(uncommittedRoot, "contracts/tasks/SCWBS-DRAFT-NEW.yaml", task as unknown as Record<string, unknown>);
    expect(collectTaskAuthorityIssues(uncommittedRoot, task, "base", ["contracts/tasks/SCWBS-DRAFT-NEW.yaml"]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "diff.taskAuthority.newTask.uncommitted" })]));

    const mixedRoot = makeTempRepo();
    writeScwbsProject(mixedRoot);
    execFileSync("git", ["add", "."], { cwd: mixedRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: mixedRoot, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: mixedRoot });
    const broad = safeNewTask();
    broad.allowedPaths = ["src/**"];
    writeYaml(mixedRoot, "contracts/tasks/SCWBS-DRAFT-NEW.yaml", broad as unknown as Record<string, unknown>);
    writeText(mixedRoot, "src/core/safe.ts", "export const mixed = true;\n");
    execFileSync("git", ["add", "."], { cwd: mixedRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "mixed broad creation"], { cwd: mixedRoot, stdio: "ignore" });
    expect(collectTaskAuthorityIssues(mixedRoot, broad, "base", ["contracts/tasks/SCWBS-DRAFT-NEW.yaml"]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "diff.taskAuthority.newTask.mixedCommit" }),
        expect.objectContaining({ code: "diff.taskAuthority.newTask.broadScope" })
      ]));

    writeText(mixedRoot, ".git/shallow", `${headCommit(mixedRoot)}\n`);
    expect(collectTaskAuthorityIssues(mixedRoot, broad, "base", ["contracts/tasks/SCWBS-DRAFT-NEW.yaml"]))
      .toEqual([expect.objectContaining({ code: "diff.taskAuthority.git.shallow" })]);
  });

  test("authority comparison fails closed when the base ref cannot be resolved", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    expect(collectTaskAuthorityIssues(root, sampleTask(), "missing-base", ["contracts/tasks/WBS-001-004.yaml"]))
      .toEqual([expect.objectContaining({ code: "diff.taskAuthority.git.mergeBase" })]);
  });

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

  test("check-diff authorizes a verified upstream release by gitlink while retaining nested coverage", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/check-coverage.yaml", {
      rules: [{ id: "upstream-wjs", paths: ["vendor/dependency/**"], requires: ["test:wjs"] }]
    });
    const declaration = {
      path: "vendor/dependency",
      authorityMode: "upstream-release" as const,
      repository: "example/dependency",
      pullRequest: "#4",
      upstreamRef: "refs/remotes/origin/main",
      checks: [{ name: "upstream-ci", status: "passed", url: "https://example.test/check/4" }]
    };
    const task = sampleTask({
      allowedPaths: ["vendor/dependency"],
      forbiddenPaths: ["vendor/dependency/**"],
      humanGateRequiredPaths: [],
      requiredChecks: ["test:wjs"],
      submoduleDependencies: [declaration]
    });
    const evidence = sampleEvidence({
      changedFiles: ["vendor/dependency"],
      submodules: [{
        path: "vendor/dependency",
        repository: declaration.repository,
        baseCommit: "1".repeat(40),
        headCommit: "2".repeat(40),
        changedFiles: ["schema/operation.json"],
        pullRequest: declaration.pullRequest,
        upstreamRef: declaration.upstreamRef,
        upstreamReachable: true,
        checks: declaration.checks
      }]
    });

    const issues = collectDiffIssues(root, task, ["vendor/dependency"], evidence);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths" || issue.code === "diff.forbiddenPaths")).toBe(false);
    expect(issues.some((issue) => issue.code === "diff.checkCoverage.missing")).toBe(false);
    expect(issues.some((issue) => issue.code === "diff.submodule.upstreamRelease")).toBe(false);
  });

  test("check-diff keeps mismatched upstream release nested files under forbidden path authority", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const task = sampleTask({
      allowedPaths: ["vendor/dependency"],
      forbiddenPaths: ["vendor/dependency/**"],
      humanGateRequiredPaths: [],
      submoduleDependencies: [{
        path: "vendor/dependency",
        authorityMode: "upstream-release",
        repository: "example/dependency",
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/main",
        checks: [{ name: "upstream-ci", status: "passed" }]
      }]
    });
    const evidence = sampleEvidence({
      changedFiles: ["vendor/dependency"],
      submodules: [{
        path: "vendor/dependency",
        repository: "attacker/dependency",
        baseCommit: "1".repeat(40),
        headCommit: "2".repeat(40),
        changedFiles: ["secret.txt"],
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/main",
        upstreamReachable: true,
        checks: [{ name: "upstream-ci", status: "passed" }]
      }]
    });

    const issues = collectDiffIssues(root, task, ["vendor/dependency"], evidence);
    expect(issues.some((issue) => issue.code === "diff.submodule.upstreamRelease")).toBe(true);
    expect(issues.some((issue) => issue.code === "diff.forbiddenPaths" && issue.message.includes("vendor/dependency/secret.txt"))).toBe(true);
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

  test("check-diff requires integration coverage for Git and Human Gate core modules", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core"],
      rules: [{
        id: "core-safety",
        classification: "behavior-critical",
        rationale: "Git and Human Gate validation determine workflow safety.",
        paths: ["src/core/git.ts", "src/core/human-gate.ts"],
        requires: ["test:integration"]
      }]
    });
    const task = sampleTask({ allowedPaths: ["src/core/**"], requiredChecks: ["test"] });
    const issues = collectDiffIssues(root, task, ["src/core/git.ts", "src/core/human-gate.ts"]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.checkCoverage.missing", message: expect.stringContaining("src/core/git.ts, src/core/human-gate.ts") })
    ]));
  });

  test("check-diff rejects an unclassified core implementation path", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core"],
      rules: [{
        id: "known-core",
        classification: "behavior-critical",
        rationale: "Known core behavior is covered by integration tests.",
        paths: ["src/core/git.ts"],
        requires: ["test:integration"]
      }]
    });
    const task = sampleTask({ allowedPaths: ["src/core/**"], requiredChecks: ["test", "test:integration"] });
    expect(collectDiffIssues(root, task, ["src/core/new-module.ts"])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.checkCoverage.unclassified", message: expect.stringContaining("src/core/new-module.ts") })
    ]));
  });

  test("check coverage waiver requires a reason and Human Approval scoped to Evidence", () => {
    const root = makeTempRepo();
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src/core"],
      rules: [{
        id: "core-safety",
        classification: "behavior-critical",
        rationale: "Git and Human Gate validation determine workflow safety.",
        paths: ["src/core/git.ts", "src/core/human-gate.ts"],
        requires: ["test:integration"]
      }]
    });
    const task = sampleTask({
      requiredChecks: ["test"],
      checkCoverageWaivers: [{ check: "test:integration", reason: "External integration environment is unavailable" }]
    });
    expect(collectDiffIssues(root, task, ["src/core/git.ts", "src/core/human-gate.ts"]).some((issue) => issue.code === "diff.checkCoverage.waiver.approval")).toBe(true);

    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/core/git.ts", "export const value = 1;\n");
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
    expect(collectDiffIssues(root, task, ["src/core/git.ts"]).some((issue) => issue.code === "diff.checkCoverage.waiver.approval")).toBe(false);

    writeText(root, "src/core/git.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "implementation changed after approval"], { cwd: root, stdio: "ignore" });
    expect(collectDiffIssues(root, task, ["src/core/git.ts"]).some((issue) => issue.code === "diff.checkCoverage.waiver.approval")).toBe(true);
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

  test("check-diff treats an empty allowedPaths array as deny-all", () => {
    const root = makeTempRepo();
    const task = sampleTask({ allowedPaths: [], humanGateRequiredPaths: [] });
    const issues = collectDiffIssues(root, task, ["src/outside.ts"]);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths" && issue.severity === "error")).toBe(true);
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

  test("check-diff exempts only known managed contract files from deny-all", () => {
    const root = makeTempRepo();
    const task = sampleTask({
      allowedPaths: [],
      managedContractPaths: ["contracts/evidence/WBS-001-004.yaml"]
    });
    const issues = collectDiffIssues(root, task, ["contracts/evidence/WBS-001-004.yaml"]);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths")).toBe(false);
  });

  test.each(["package.json", "package-lock.json", "tsconfig.json", ".github/workflows/ci.yml"])(
    "check-diff does not trust sensitive managedContractPaths bypass %s",
    (file) => {
      const root = makeTempRepo();
      const task = sampleTask({ allowedPaths: ["src/**"], humanGateRequiredPaths: [], managedContractPaths: [file] });
      const issues = collectDiffIssues(root, task, [file]);
      expect(issues.some((issue) => issue.code === "diff.allowedPaths")).toBe(true);
      expect(issues.some((issue) => issue.code === "diff.metaFile")).toBe(true);
    }
  );

  test("check-diff does not trust broad contracts globs as managed paths", () => {
    const root = makeTempRepo();
    const task = sampleTask({ allowedPaths: [], managedContractPaths: ["contracts/**"] });
    const issues = collectDiffIssues(root, task, ["contracts/unmanaged/value.yaml"]);
    expect(issues.some((issue) => issue.code === "diff.allowedPaths")).toBe(true);
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
    writeText(root, "src/features/api/staged.ts", "export const staged = 1;\n");
    writeText(root, "src/features/api/unstaged.ts", "export const unstaged = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "branch change"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/staged.ts", "export const staged = 2;\n");
    execFileSync("git", ["add", "src/features/api/staged.ts"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/unstaged.ts", "export const unstaged = 2;\n");
    writeText(root, "src/features/api/untracked.ts", "export const extra = true;\n");

    expect(branchChangedFiles(root, "base")).toEqual(["src/features/api/index.ts"]);
    expect(workingTreeChangedFiles(root).sort()).toEqual([
      "src/features/api/staged.ts",
      "src/features/api/unstaged.ts",
      "src/features/api/untracked.ts"
    ]);
    expect(workingTreeState(root)).toMatchObject({
      staged: ["src/features/api/staged.ts"],
      unstaged: ["src/features/api/unstaged.ts"],
      untracked: ["src/features/api/untracked.ts"],
      submodules: []
    });
  });

  test("check-diff rejects staged, unstaged, untracked, and human-gated working tree changes with structured JSON", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName,
      allowedPaths: ["src/**"],
      humanGateRequiredPaths: ["src/security/**"]
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: [] }) as unknown as Record<string, unknown>);
    writeText(root, "src/staged.ts", "export const staged = 1;\n");
    writeText(root, "src/unstaged.ts", "export const unstaged = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/staged.ts", "export const staged = 2;\n");
    execFileSync("git", ["add", "src/staged.ts"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/unstaged.ts", "export const unstaged = 2;\n");
    writeText(root, "src/security/untracked.ts", "export const gated = true;\n");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    const result = JSON.parse(output.join("\n"));
    expect(result.workingTree).toMatchObject({
      staged: ["src/staged.ts"],
      unstaged: ["src/unstaged.ts"],
      untracked: ["src/security/untracked.ts"],
      submodules: []
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.workingTree.tracked", fixCommand: expect.stringContaining("git stash push") }),
      expect.objectContaining({ code: "diff.workingTree.untracked", fixCommand: expect.stringContaining("src/security/untracked.ts") })
    ]));
  });

  test("check-diff rejects a dirty submodule working tree", () => {
    const root = makeTempRepo();
    const submoduleRoot = makeTempRepo();
    writeText(submoduleRoot, "version.txt", "one\n");
    execFileSync("git", ["add", "."], { cwd: submoduleRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "submodule base"], { cwd: submoduleRoot, stdio: "ignore" });
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ branchName, allowedPaths: ["vendor/**"] }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", submoduleRoot, "vendor/dependency"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "vendor/dependency/version.txt", "dirty\n");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    const result = JSON.parse(output.join("\n"));
    expect(result.workingTree.submodules).toEqual(["vendor/dependency"]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "diff.workingTree.submodule", fixCommand: expect.stringContaining("git -C 'vendor/dependency' stash") })
    ]));
  }, 30000);

  test("check-diff permits only task-scoped lifecycle metadata to remain dirty", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const branchName = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ branchName }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: [] }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004", type: "approval", taskId: "WBS-001-004", status: "requested"
    });
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "REV-WBS-001-004", type: "review", taskId: "WBS-001-004", status: "requested"
    });
    writeYaml(root, "contracts/registry.yaml", { projectId: "test", contracts: [] });

    expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base" })).toBe(0);
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

  test("check-diff text output shows diff hash and AI stop message for human gate", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "master",
      allowedPaths: ["src/**"],
      humanGateRequiredPaths: ["src/security/**"],
      requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/security/secret.ts", "export const secret = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "human gate change"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/security/secret.ts"],
      diffHash: "test-diff-hash",
      git: { diffHash: "test-diff-hash" }
    }) as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base" })).toBe(1);
    } finally {
      console.log = originalLog;
    }

    const text = output.join("\n");
    expect(text).toContain("Human approval required.");
    expect(text).toContain("Changed human-gated paths:");
    expect(text).toContain("  - src/security/secret.ts");
    expect(text).toContain("Current diff hash:");
    expect(text).toContain("Next action for human reviewer:");
    expect(text).toContain("AI agents must stop here.");
    expect(text).toContain("Do not approve this task yourself.");
  }, 30000);

  test("check-diff JSON output includes requiresHumanApproval and nextAction", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "master",
      allowedPaths: ["src/**"],
      humanGateRequiredPaths: ["src/security/**"],
      requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/security/secret.ts", "export const secret = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "human gate change"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      changedFiles: ["src/security/secret.ts"],
      diffHash: "test-diff-hash",
      git: { diffHash: "test-diff-hash" }
    }) as unknown as Record<string, unknown>);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runCheckDiff(root, "WBS-001-004", { baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }

    const result = JSON.parse(output.join("\n"));
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.nextAction).toBe(`npm run scwbs -- approval approve --task WBS-001-004 --actor human --reason "Evidence and diff reviewed"`);
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
