import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildHealthJsonOutput, buildHealthText, collectHealthIssues, collectTaskHealthIssues, runHealth } from "../../src/commands/health.js";
import type { Issue } from "../../src/core/types.js";
import { main } from "../../src/cli.js";
import { headCommit } from "../../src/core/git.js";
import { readEvidence } from "../../src/core/contracts.js";
import { buildCollectedEvidence } from "../../src/commands/evidence-collect.js";
import { makeTempRepo, sampleTask, sampleEvidence, sampleApproval, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

describe("health", () => {
  test("health JSON keeps every issue in a versioned schema", () => {
    const root = makeTempRepo();
    const issues: Issue[] = Array.from({ length: 100 }, (_, index) => ({
      severity: "warn",
      code: "health.example.repeated",
      message: `example ${index + 1}`
    }));
    const report = buildHealthJsonOutput(root, issues);
    expect(report).toMatchObject({
      version: "scwbs.health.v1",
      status: "warn",
      repository: { shallow: false, commitReachability: "evaluated" },
      summary: {
        total: 100,
        errors: 0,
        warnings: 100,
        byCode: [{ code: "health.example.repeated", severity: "warn", count: 100 }]
      }
    });
    expect(report.issues).toHaveLength(100);
  });

  test("health CLI accepts --json", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(main(["health", "--json"], root)).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      version: "scwbs.health.v1",
      status: "warn",
      issues: expect.any(Array)
    });
  });

  test("health default output aggregates repeated issues within a fixed budget", () => {
    const root = makeTempRepo();
    const issues: Issue[] = Array.from({ length: 100 }, (_, index) => ({
      severity: "warn",
      code: "health.example.repeated",
      message: `example ${index + 1}`
    }));
    const output = buildHealthText(root, issues);
    expect(output).toContain("health.example.repeated (count=100)");
    expect(output).toContain("98 more omitted");
    expect(output.split("\n").filter(Boolean).length).toBeLessThanOrEqual(6);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(500);
    expect(buildHealthText(root, issues, { verbose: true }).split("\n").filter(Boolean)).toHaveLength(101);
  });

  test("health prioritizes errors, Human Gate, and actionable warnings", () => {
    const root = makeTempRepo();
    const output = buildHealthText(root, [
      { severity: "warn", code: "health.z.general", message: "general" },
      { severity: "warn", code: "health.approval.status", message: "approval" },
      { severity: "error", code: "health.failure", message: "failure", fixCommand: "fix failure" },
      { severity: "warn", code: "health.actionable", message: "action", fixCommand: "fix action" }
    ]);
    expect(output.indexOf("health.failure")).toBeLessThan(output.indexOf("health.approval.status"));
    expect(output.indexOf("health.approval.status")).toBeLessThan(output.indexOf("health.actionable"));
    expect(output).toContain("fixCommand: fix action");
  });

  test("health marks commit reachability not-evaluated in a shallow clone", () => {
    const source = makeTempRepo();
    writeScwbsProject(source, "completed");
    execFileSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: source, stdio: "ignore" });
    writeText(source, "README.md", "latest\n");
    execFileSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "latest"], { cwd: source, stdio: "ignore" });
    const clone = mkdtempSync(path.join(os.tmpdir(), "scwbs-shallow-"));
    execFileSync("git", ["clone", "--depth", "1", `file://${source}`, clone], { stdio: "ignore" });

    const issues = collectHealthIssues(clone);
    const report = buildHealthJsonOutput(clone, issues);
    expect(report.repository).toEqual({ shallow: true, commitReachability: "not-evaluated" });
    expect(issues.some((issue) => issue.code.endsWith(".unknown"))).toBe(false);
    expect(buildHealthText(clone, issues)).toContain("commit reachability=not-evaluated");
  });

  test("health warns when evidence has only low-trust checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.lowTrust")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.evidence.check.lowTrust")).toBe(true);
  });

  test("health accepts CI evidence with run id as Level A", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        checks: [
          { name: "test", status: "passed", source: "ci", runId: "github-actions-123456" },
          { name: "typecheck", status: "passed", source: "ci", runId: "github-actions-123456" }
        ]
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.lowTrust")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.check.lowTrust")).toBe(false);
  });

  test("health accepts local evidence with command and timestamp as Level B", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        checks: [
          { name: "test", status: "passed", source: "local", command: "npm test", executedAt: "2026-06-27T10:00:00+09:00" },
          { name: "typecheck", status: "passed", source: "local", command: "npm run typecheck", executedAt: "2026-06-27T10:00:00+09:00" }
        ]
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.lowTrust")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.check.lowTrust")).toBe(false);
  });

  test("health errors when evidence changed files touch forbidden paths", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({ changedFiles: ["src/auth/session.ts"] }) as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.changedFiles.forbiddenPaths")).toBe(true);
    expect(runHealth(root)).toBe(1);
  });

  test("health treats managed contract paths as allowed path exceptions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({
        allowedPaths: ["src/**"],
        managedContractPaths: ["contracts/changesets/WBS-001-004-link-wbs-node.json"]
      }) as unknown as Record<string, unknown>
    );
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["contracts/changesets/WBS-001-004-link-wbs-node.json"]
      }) as unknown as Record<string, unknown>
    );

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.changedFiles.allowedPaths")).toBe(false);
  });

  test("health treats empty allowedPaths as deny-all", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/tasks/WBS-001-004.yaml",
      sampleTask({ allowedPaths: [], managedContractPaths: ["contracts/evidence/WBS-001-004.yaml"] }) as unknown as Record<string, unknown>
    );
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({ changedFiles: ["src/outside.ts", "contracts/evidence/WBS-001-004.yaml"] }) as unknown as Record<string, unknown>
    );

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.changedFiles.allowedPaths" && issue.message.includes("src/outside.ts"))).toBe(true);
    expect(issues.some((issue) => issue.code === "health.evidence.changedFiles.allowedPaths" && issue.message.includes("contracts/evidence"))).toBe(false);
  });

  test("health warns when evidence commit is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.commit.missing")).toBe(true);
    expect(runHealth(root)).toBe(0);
  });

  test("health warns when evidence git metadata is missing for review workflow", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation"
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.subjectHeadCommit.missing")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.evidence.git.pullRequest.missing")).toBe(true);
  });

  test("evidence git provenance fields are validated as strings", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          baseCommit: "abc1234",
          changedFilesBasis: false as unknown as string,
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    const { issues } = readEvidence(root, "WBS-001-004");
    expect(issues.some((issue) => issue.code === "evidence.git")).toBe(true);
  });

  test("health warns when evidence provenance basis is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.changedFilesBasis.missing")).toBe(true);
  });

  test("health warns when evidence head commit is stale", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["switch", "-c", "task/WBS-001-004-api-implementation"], { cwd: root, stdio: "ignore" });
    const oldHead = headCommit(root) ?? "";
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: oldHead,
          changedFilesBasis: "branch-diff",
          headCommit: oldHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.subjectHeadCommit.stale")).toBe(true);
  }, 15000);

  test("health ignores historical stale evidence on other branches", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const oldHead = headCommit(root) ?? "";
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "later-work"], { cwd: root, stdio: "ignore" });
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: oldHead,
          changedFilesBasis: "branch-diff",
          headCommit: oldHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.headCommit.stale")).toBe(false);
  });

  test("health accepts post-evidence metadata-only commits", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const evidenceHead = headCommit(root) ?? "";
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: evidenceHead,
          changedFilesBasis: "branch-diff",
          headCommit: evidenceHead
        }
      }) as unknown as Record<string, unknown>
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "evidence"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        },
        {
          id: "EVD-WBS-001-004",
          type: "evidence",
          path: "contracts/evidence/WBS-001-004.yaml",
          relatedTask: "WBS-001-004"
        }
      ]
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "registry"], { cwd: root, stdio: "ignore" });
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.headCommit.stale")).toBe(false);
  }, 30000);

  test("health accepts post-evidence metadata-only commits with subjectHeadCommit", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", evidence as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "evidence"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/registry.yaml", {
      projectId: "test-wbs",
      contracts: [
        {
          id: "TASK-WBS-001-004",
          type: "task",
          path: "contracts/tasks/WBS-001-004.yaml",
          featureId: "F001"
        },
        {
          id: "EVD-WBS-001-004",
          type: "evidence",
          path: "contracts/evidence/WBS-001-004.yaml",
          relatedTask: "WBS-001-004"
        }
      ]
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "registry"], { cwd: root, stdio: "ignore" });
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.subjectHeadCommit.stale")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.diffHash.stale")).toBe(false);
  }, 30000);

  test("health ignores missing diffHash on historical evidence from other branches", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const oldHead = headCommit(root) ?? "";
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: oldHead,
          changedFilesBasis: "branch-diff",
          subjectHeadCommit: oldHead,
          headCommit: oldHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.diffHash.missing")).toBe(false);
  });

  test("health warns when active branch evidence has no diffHash", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    execFileSync("git", ["switch", "-c", "task/WBS-001-004-api-implementation"], { cwd: root, stdio: "ignore" });
    const evidenceHead = headCommit(root) ?? "";
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "base",
          baseCommit: evidenceHead,
          changedFilesBasis: "branch-diff",
          subjectHeadCommit: evidenceHead,
          headCommit: evidenceHead
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.diffHash.missing")).toBe(true);
  });

  test("health accepts approval pull request metadata when evidence pull request is missing", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        git: {
          branch: "task/WBS-001-004-api-implementation",
          base: "main",
          headCommit: "abc1234"
        }
      }) as unknown as Record<string, unknown>
    );
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", sampleApproval() as unknown as Record<string, unknown>);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.git.pullRequest.missing")).toBe(false);
  });

  test("health warns when tracked text files contain CRLF line endings", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "README.md", "title\r\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    const issues = collectHealthIssues(root);
    const issue = issues.find((item) => item.code === "health.workingTree.crlf" && item.message.includes("README.md"));
    expect(issue).toBeDefined();
    expect(issue?.fixCommand).toContain(".gitattributes");
    expect(issue?.fixCommand).toContain("git add --renormalize README.md");
  });

  test("health warns when current branch is behind base and contract paths collide", () => {
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

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.git.baseBehind")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.git.addedPathCollision" && issue.message.includes("contracts/tasks/SCWBS-030.yaml"))).toBe(true);
  }, 15000);

  test("health warns when a submodule worktree is dirty", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    mkdirSync(path.join(root, "wjs"), { recursive: true });
    execFileSync("git", ["init"], { cwd: path.join(root, "wjs"), stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path.join(root, "wjs") });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: path.join(root, "wjs") });
    writeText(root, "wjs/README.md", "clean\n");
    execFileSync("git", ["add", "README.md"], { cwd: path.join(root, "wjs") });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: path.join(root, "wjs"), stdio: "ignore" });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "./wjs", "vendor/wjs"], { cwd: root, stdio: "ignore" });
    writeText(root, "vendor/wjs/README.md", "dirty\n");
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.submodule.dirty" && issue.message.includes("vendor/wjs"))).toBe(true);
  }, 15000);

  test("health warns when task contract has no contract lock", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.task.contractLock.missing")).toBe(true);
  });

  test("health warns when changed test files lack test quality metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"]
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.missing")).toBe(true);
  });

  test("evidence test quality notes are accepted", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"],
        testQuality: {
          assertionsAdded: true,
          testsDisabled: false,
          coverageDecreased: false,
          notes: ["API success case asserts response body"]
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "evidence.testQuality")).toBe(false);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.missing")).toBe(false);
  });

  test("health accepts explained test maintenance without new assertions", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"],
        testQuality: {
          assertionsAdded: false,
          testsDisabled: false,
          coverageDecreased: false,
          notes: ["Only increased timeout for an existing git-heavy test."]
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.assertions")).toBe(false);
  });

  test("health warns when test changes add no assertions without rationale", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "completed");
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: ["tests/features/api/api.test.ts"],
        testQuality: {
          assertionsAdded: false,
          testsDisabled: false,
          coverageDecreased: false
        }
      }) as unknown as Record<string, unknown>
    );
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.evidence.testQuality.assertions")).toBe(true);
  });

  test("task-scoped health excludes warnings from other tasks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({ id: "WBS-001-005" }) as unknown as Record<string, unknown>);

    const issues = collectTaskHealthIssues(root, "WBS-001-004");
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => !issue.message.includes("WBS-001-005"))).toBe(true);
  });

  test("task-scoped health detects Review scope drift and returns a fix command", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "evidence-head",
      diffHash: "sha256:evidence",
      git: { pullRequest: "#42", subjectHeadCommit: "evidence-head", diffHash: "sha256:evidence" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "independent-ai-review",
      headCommit: "stale-head",
      diffHash: "sha256:stale",
      pullRequest: "#41",
      groundTruth: ["contracts/tasks/WBS-001-004.yaml", "contracts/evidence/WBS-001-004.yaml"]
    });

    const issues = collectTaskHealthIssues(root, "WBS-001-004");
    expect(issues.some((issue) => issue.code === "health.review.scope.headCommit")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.review.scope.diffHash")).toBe(true);
    expect(issues.some((issue) => issue.code === "health.review.scope.pullRequest")).toBe(true);
    expect(issues.find((issue) => issue.code === "health.review.scope.diffHash")?.fixCommand).toContain("review request --task WBS-001-004");
  });
});
