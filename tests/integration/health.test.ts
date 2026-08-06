import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildHealthJsonOutput, buildHealthText, collectEvidenceTrustIssues, collectHealthIssues, collectTaskHealthIssues, runHealth } from "../../src/commands/health.js";
import type { Issue } from "../../src/core/types.js";
import { main } from "../../src/cli.js";
import { headCommit, latestCommitTimestampsForFiles } from "../../src/core/git.js";
import { readEvidence } from "../../src/core/contracts.js";
import { buildCollectedEvidence } from "../../src/commands/evidence-collect.js";
import { runEvidenceCollect } from "../../src/commands/evidence-collect.js";
import { verifyPatchArtifact } from "../../src/core/git.js";
import { makeTempRepo, sampleTask, sampleEvidence, sampleApproval, sampleWbs, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

describe("health", () => {
  test("health warns when the current branch PR is absent from Evidence", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/xmeta/ACED.git"], { cwd: root });
    const gh = path.join(root, "bin/gh");
    writeText(root, "bin/gh", "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ number: 42 }));\n");
    chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${path.dirname(gh)}:${previousPath ?? ""}`;
    try {
      const task = sampleTask({ requiredChecks: [], branchName: "master" });
      const issues = collectEvidenceTrustIssues(root, sampleWbs("planned"), task, sampleEvidence());
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "health.evidence.git.pullRequest.currentBranch",
          fixCommand: expect.stringContaining("--pull-request 42 --force")
        })
      ]));
    } finally {
      process.env.PATH = previousPath;
    }
  });
  test("patch provenance fails closed for missing, tampered, unsafe, or inconsistent artifacts", () => {
    const root = makeTempRepo();
    const task = sampleTask({ requiredChecks: [] });
    writeScwbsProject(root);
    writeYaml(root, `contracts/tasks/${task.id}.yaml`, task as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/index.ts", "export const retained = true;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "subject"], { cwd: root, stdio: "ignore" });
    expect(runEvidenceCollect(root, task.id, { baseRef: "base", force: true })).toBe(0);

    const evidence = readEvidence(root, task.id).evidence!;
    const payloadPath = path.join(root, `contracts/evidence-payloads/${task.id}.patch`);
    const payload = readFileSync(payloadPath);
    expect(verifyPatchArtifact(root, task.id, evidence, { shallow: false }).status).toBe("verified");

    rmSync(payloadPath);
    expect(verifyPatchArtifact(root, task.id, evidence, { shallow: false })).toMatchObject({
      status: "unverifiable",
      code: "payload.missing"
    });
    expect(collectEvidenceTrustIssues(root, sampleWbs("planned"), task, evidence).some(
      (issue) => issue.code === "health.evidence.provenance.payload.missing"
    )).toBe(true);
    writeFileSync(payloadPath, payload);

    const traversal = {
      ...evidence,
      provenance: {
        ...evidence.provenance!,
        retention: { ...evidence.provenance!.retention, locator: "repo:../outside.patch" }
      }
    };
    expect(verifyPatchArtifact(root, task.id, traversal, { shallow: false })).toMatchObject({
      status: "unverifiable",
      code: "locator"
    });

    writeFileSync(payloadPath, Buffer.from("tampered"));
    expect(verifyPatchArtifact(root, task.id, evidence, { shallow: false })).toMatchObject({
      status: "unverifiable",
      code: "payload.hash"
    });

    const invalidPatch = Buffer.from("not a git patch\n");
    writeFileSync(payloadPath, invalidPatch);
    const applyFailure = {
      ...evidence,
      provenance: {
        ...evidence.provenance!,
        retention: {
          ...evidence.provenance!.retention,
          manifestHash: `sha256:${createHash("sha256").update(invalidPatch).digest("hex")}`
        }
      }
    };
    expect(verifyPatchArtifact(root, task.id, applyFailure, { shallow: false })).toMatchObject({
      status: "unverifiable",
      code: "apply"
    });
    writeFileSync(payloadPath, payload);

    const treeMismatch = {
      ...evidence,
      provenance: {
        ...evidence.provenance!,
        subject: { ...evidence.provenance!.subject, treeHash: "0".repeat(40) }
      }
    };
    expect(verifyPatchArtifact(root, task.id, treeMismatch, { shallow: false })).toMatchObject({
      status: "unverifiable",
      code: "tree"
    });

    const baseMissing = {
      ...evidence,
      git: { ...evidence.git!, baseCommit: "0".repeat(40) }
    };
    expect(verifyPatchArtifact(root, task.id, baseMissing, { shallow: false })).toMatchObject({
      status: "unverifiable",
      code: "base.unavailable"
    });
    expect(verifyPatchArtifact(root, task.id, baseMissing, { shallow: true })).toMatchObject({
      status: "not-evaluated",
      code: "base.unavailable"
    });
  });

  test("distinguishes legacy, unavailable git-object, and unevaluated external provenance", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "subject"], { cwd: root, stdio: "ignore" });

    const task = sampleTask({ requiredChecks: [] });
    const legacyIssues = collectEvidenceTrustIssues(root, sampleWbs("planned"), task, sampleEvidence(), {
      checkCommitReachability: false
    });
    expect(legacyIssues.some((issue) => issue.code === "health.evidence.provenance.missing")).toBe(true);

    const evidence = buildCollectedEvidence(root, task.id, { baseRef: "base" });
    const gitObjectEvidence = {
      ...evidence,
      provenance: {
        ...evidence.provenance!,
        retention: {
          mode: "git-object" as const,
          locator: `git:${evidence.subjectHeadCommit}`
        }
      }
    };
    const unavailable = collectEvidenceTrustIssues(root, sampleWbs("planned"), task, gitObjectEvidence, {
      repositoryState: {
        currentHead: headCommit(root),
        currentBranchName: task.branchName,
        commitExists: () => false
      }
    });
    expect(unavailable.some((issue) =>
      issue.code === "health.evidence.provenance.unverifiable"
      && issue.message.includes("diffHash alone")
    )).toBe(true);

    const external = {
      ...evidence,
      provenance: {
        ...evidence.provenance!,
        retention: { mode: "bundle" as const, locator: "artifact:example" }
      }
    };
    const notEvaluated = collectEvidenceTrustIssues(root, sampleWbs("planned"), task, external);
    expect(notEvaluated.some((issue) => issue.code === "health.evidence.provenance.notEvaluated")).toBe(true);
  });

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

  test("health warns when source history is newer than the Task Contract", () => {
    const root = makeTempRepo();
    writeScwbsProject(root, "planned");
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "contract-and-source"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "src/features/api/index.ts"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "implementation-change"], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: "2030-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2030-01-02T00:00:00Z" }
    });

    const timestamps = latestCommitTimestampsForFiles(root, ["src/features/api/index.ts", "contracts/tasks/WBS-001-004.yaml"]);
    expect(timestamps.has("src/features/api/index.ts")).toBe(true);
    expect(timestamps.has("contracts/tasks/WBS-001-004.yaml")).toBe(true);
    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.task.timestampDrift")).toBe(true);
  });

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

  test("health reports codeContext file too large warning", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const longLines = Array.from({ length: 502 }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n";
    writeText(root, "src/large.ts", longLines);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/large.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "large file"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.codeContext.fileTooLarge" && issue.message.includes("src/large.ts"))).toBe(true);
    expect(runHealth(root)).toBe(0);
  });

  test("health aggregates fileTooLarge across active tasks by unique file path", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const longLines = Array.from({ length: 502 }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n";
    writeText(root, "src/shared.ts", longLines);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      id: "WBS-001-004",
      allowedPaths: ["src/shared.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      wbsNodeId: "node-root",
      branchName: "task/WBS-001-005",
      allowedPaths: ["src/shared.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeJson(root, "contracts/wbs/project.wbs.json", {
      schemaVersion: "0.1.0",
      id: "test-wbs",
      name: "Test WBS",
      rootId: "node-root",
      nodes: [
        { id: "node-root", parentId: null, code: "1", name: "Root", type: "deliverable", status: "planned" },
        { id: "node-api", parentId: "node-root", code: "1.1", name: "API", type: "workPackage", status: "planned" }
      ]
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "shared large file"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root).filter((issue) => issue.code === "health.codeContext.fileTooLarge");
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("src/shared.ts");
    expect(issues[0].message).toContain("2 active task plans");
    expect(issues[0].message).toContain("WBS-001-004");
    expect(issues[0].message).toContain("WBS-001-005");
  });

  test("health reports codeContext widening warning", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import(\"./dynamic.js\");\nexport const value = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/feature.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "widening fixture"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.codeContext.widening" && issue.message.includes("dynamic-import"))).toBe(true);
  });

  test("health reports importFanOut when a seed is referenced by 9+ distinct importers", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/seed.ts", "export const value = 1;\n");
    for (let index = 0; index < 10; index += 1) {
      writeText(root, `src/caller${index}.ts`, `import { value } from "./seed.js";\nvoid value;\n`);
    }
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/seed.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "fan-out fixture"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    const fanOutIssue = issues.find((issue) => issue.code === "health.codeContext.importFanOut");
    expect(fanOutIssue).toBeDefined();
    expect(fanOutIssue?.message).toContain("src/seed.ts");
    expect(fanOutIssue?.message).toContain("10 reverse importers");
    expect(fanOutIssue?.message).toContain("WBS-001-004");
  });

  test("health does not report importFanOut for repeated imports from the same importer file", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/seed.ts", "export const a = 1;\nexport const b = 2;\n");
    writeText(root, "src/caller.ts", "import { a } from \"./seed.js\";\nimport { b } from \"./seed.js\";\nvoid a;\nvoid b;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/seed.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "same importer repeated imports"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    expect(issues.some((issue) => issue.code === "health.codeContext.importFanOut")).toBe(false);
  });

  test("health aggregates widening by reason code across active tasks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeText(root, "src/feature.ts", "import(\"./dynamic.js\");\nexport const value = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      id: "WBS-001-004",
      allowedPaths: ["src/feature.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/tasks/WBS-001-005.yaml", sampleTask({
      id: "WBS-001-005",
      wbsNodeId: "node-root",
      branchName: "task/WBS-001-005",
      allowedPaths: ["src/feature.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    writeJson(root, "contracts/wbs/project.wbs.json", {
      schemaVersion: "0.1.0",
      id: "test-wbs",
      name: "Test WBS",
      rootId: "node-root",
      nodes: [
        { id: "node-root", parentId: null, code: "1", name: "Root", type: "deliverable", status: "planned" },
        { id: "node-api", parentId: "node-root", code: "1.1", name: "API", type: "workPackage", status: "planned" }
      ]
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "shared widening"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root).filter((issue) => issue.code === "health.codeContext.widening");
    const dynamicIssue = issues.find((issue) => issue.message.includes("dynamic-import"));
    expect(dynamicIssue).toBeDefined();
    expect(dynamicIssue?.message).toContain("2 active task plans");
    expect(dynamicIssue?.message).toContain("WBS-001-004");
    expect(dynamicIssue?.message).toContain("WBS-001-005");
  });

  test("health reports planBudget when omitted candidates reach the threshold", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const featureCount = 60;
    for (let index = 0; index < featureCount; index += 1) {
      writeText(root, `src/feature${index}.ts`, `export const value${index} = ${index};\n`);
    }
    writeText(root, "src/seed.ts", Array.from({ length: featureCount }, (_, index) => `import { value${index} } from "./feature${index}.js";`).join("\n") + "\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/seed.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "budget fixture"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    const planBudgetIssue = issues.find((issue) => issue.code === "health.codeContext.planBudget");
    expect(planBudgetIssue).toBeDefined();
    expect(planBudgetIssue?.message).toMatch(/omits \d+ candidates \(budget saturated at \d+\/\d+ bytes\)/);
    expect(planBudgetIssue?.message).toContain("WBS-001-004");
  });

  test("health planBudget boundary: omitted < 20 does not warn, omitted >= 20 does warn", () => {
    // collectHealthIssues uses default maxFiles=40. Create enough candidates
    // so the tight case overflows.
    const FEATURE_COUNT_GENEROUS = 30;  // mustRead(1)+seed(1)+30 = 32 ≤ 40 → omitted=0
    const FEATURE_COUNT_TIGHT = 80;     // mustRead(1)+seed(1)+80-fits = omitted >= 20

    function setupRepo(featureCount: number): string {
      const root = makeTempRepo();
      writeScwbsProject(root);
      for (let index = 0; index < featureCount; index += 1) {
        writeText(root, `src/feature${index}.ts`, `export const value${index} = ${index};\n`);
      }
      writeText(root, "src/seed.ts", Array.from({ length: featureCount }, (_, index) => `import { value${index} } from "./feature${index}.js";`).join("\n") + "\n");
      writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
        allowedPaths: ["src/seed.ts"],
        humanGateRequiredPaths: []
      }) as unknown as Record<string, unknown>);
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `budget fixture ${featureCount}`], { cwd: root, stdio: "ignore" });
      return root;
    }

    // Case 1: few features → omitted < 20 → no planBudget warning
    const generousRoot = setupRepo(FEATURE_COUNT_GENEROUS);
    const generousIssues = collectHealthIssues(generousRoot);
    expect(generousIssues.some((issue) => issue.code === "health.codeContext.planBudget")).toBe(false);

    // Case 2: many features → omitted >= 20 → planBudget warning
    const tightRoot = setupRepo(FEATURE_COUNT_TIGHT);
    const tightIssues = collectHealthIssues(tightRoot);
    expect(tightIssues.some((issue) => issue.code === "health.codeContext.planBudget")).toBe(true);
  });

  test("health verbose text output lists every codeContext issue individually without omission markers", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const longLines = Array.from({ length: 502 }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n";
    writeText(root, "src/large.ts", longLines);
    writeText(root, "src/feature.ts", "import(\"./dynamic.js\");\nexport const value = 1;\n");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/large.ts", "src/feature.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "verbose fixture"], { cwd: root, stdio: "ignore" });

    const verboseText = buildHealthText(root, undefined, { verbose: true });

    // Verbose output must not contain "more omitted" markers
    expect(verboseText).not.toMatch(/more omitted/);
    // Verbose must include all codeContext issue types individually
    expect(verboseText).toContain("health.codeContext.fileTooLarge");
    expect(verboseText).toContain("health.codeContext.widening");
    // Verbose must include the issue messages directly (not aggregated by code)
    expect(verboseText).toContain("src/large.ts");
    expect(verboseText).toContain("dynamic-import");
  });

  test("health skips codeContext check in a shallow clone with an explicit note", () => {
    const source = makeTempRepo();
    writeScwbsProject(source);
    execFileSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: source, stdio: "ignore" });
    writeText(source, "README.md", "latest\n");
    execFileSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "latest"], { cwd: source, stdio: "ignore" });
    const clone = mkdtempSync(path.join(os.tmpdir(), "scwbs-shallow-"));
    execFileSync("git", ["clone", "--depth", "1", `file://${source}`, clone], { stdio: "ignore" });

    const issues = collectHealthIssues(clone);
    expect(issues.some((issue) => issue.code === "health.codeContext.skipped" && issue.message.includes("shallow repository"))).toBe(true);
  });

  test("health --json keeps version/status/summary structure when codeContext issues exist", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    const longLines = Array.from({ length: 502 }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n";
    writeText(root, "src/large.ts", longLines);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      allowedPaths: ["src/large.ts"],
      humanGateRequiredPaths: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "large file"], { cwd: root, stdio: "ignore" });

    const issues = collectHealthIssues(root);
    const report = buildHealthJsonOutput(root, issues);
    expect(report.version).toBe("scwbs.health.v1");
    expect(report.status).toBe("warn");
    expect(report.summary).toMatchObject({
      total: expect.any(Number),
      errors: 0,
      warnings: expect.any(Number),
      byCode: expect.arrayContaining([{ code: "health.codeContext.fileTooLarge", severity: "warn", count: 1 }])
    });
    expect(report.issues.some((issue) => issue.code === "health.codeContext.fileTooLarge")).toBe(true);
  });
});
