import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { evaluateEvidenceSubjectMigration, runEvidenceMigrateSubject } from "../../src/cli/register-governance.js";
import { diffBinary, hashDiffBinary, headCommit, resolveCommit } from "../../src/core/git.js";
import { taskLifecycleMetadataPaths } from "../../src/core/managed-contract-paths.js";
import { makeTempRepo, sampleTask, writeText, writeYaml } from "../helpers.js";

function commit(root: string, message: string): string {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
  return headCommit(root)!;
}

function prepareRepo(taskId = "MIG-001"): { root: string; taskId: string; base: string; subject: string } {
  const root = makeTempRepo();
  writeYaml(root, `contracts/tasks/${taskId}.yaml`, sampleTask({ id: taskId, branchName: `task/${taskId}` }) as unknown as Record<string, unknown>);
  writeText(root, "src/feature.ts", "export const before = true;\n");
  const base = commit(root, "base");
  writeText(root, "src/feature.ts", "export const after = true;\n");
  writeText(root, "docs/implementation.md", "implementation\n");
  const subject = commit(root, "implementation subject");
  return { root, taskId, base, subject };
}

function writeLegacyEvidence(root: string, taskId: string, base: string, subject: string, changedFiles: string[], pullRequest?: string): void {
  writeYaml(root, `contracts/evidence/${taskId}.yaml`, {
    id: `EVD-${taskId}`,
    type: "evidence",
    taskId,
    commit: subject,
    changedFiles,
    git: {
      baseCommit: base,
      ...(pullRequest ? { pullRequest } : {})
    },
    checks: []
  });
}

describe("evidence migrate-subject", () => {
  test("reconstructs a ready subject and classifies lifecycle-only changedFiles drift", () => {
    const { root, taskId, base, subject } = prepareRepo();
    writeLegacyEvidence(root, taskId, base, subject, [
      "docs/implementation.md",
      "src/feature.ts",
      `contracts/evidence/${taskId}.yaml`,
      "contracts/registry.yaml"
    ]);

    const report = evaluateEvidenceSubjectMigration(root, taskId);
    expect(report).toMatchObject({
      status: "ready",
      taskId,
      baseCommit: base,
      subjectHeadCommit: subject,
      changedFiles: ["docs/implementation.md", "src/feature.ts"],
      diffHash: hashDiffBinary(diffBinary(root, base, subject, taskLifecycleMetadataPaths(taskId))),
      classifiedLifecycleMetadata: [`contracts/evidence/${taskId}.yaml`, "contracts/registry.yaml"],
      blockerCodes: []
    });
  });

  test("rejects spoofed local PR refs and uses only an explicit authoritative fetch", () => {
    const { root, taskId, base, subject } = prepareRepo("MIG-PR");
    writeLegacyEvidence(root, taskId, base, subject, ["docs/implementation.md", "src/feature.ts"], "#42");
    execFileSync("git", ["update-ref", "refs/pull/42/head", base], { cwd: root });
    expect(evaluateEvidenceSubjectMigration(root, taskId).blockerCodes).toContain("pull-request.ancestry-unavailable");
    expect(evaluateEvidenceSubjectMigration(root, taskId).blockerCodes).not.toContain("pull-request.ancestry-mismatch");

    const remote = mkdtempSync(path.join(tmpdir(), "scwbs-bare-"));
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
    execFileSync("git", ["push", "origin", `${subject}:refs/pull/42/head`], { cwd: root, stdio: "ignore" });
    expect(evaluateEvidenceSubjectMigration(root, taskId, { fetchPrHead: true }).status).toBe("ready");
    expect(resolveCommit(root, "refs/pull/42/head")).toBe(base);
  });

  test("reports deterministic fetch failure when PR ancestry is explicitly requested", () => {
    const { root, taskId, base, subject } = prepareRepo("MIG-PR-FAIL");
    writeLegacyEvidence(root, taskId, base, subject, ["docs/implementation.md", "src/feature.ts"], "#42");
    const report = evaluateEvidenceSubjectMigration(root, taskId, { fetchPrHead: true });
    expect(report.blockerCodes).toEqual(expect.arrayContaining(["pull-request.fetch-failed", "pull-request.ancestry-unavailable"]));
  });

  test("fails closed for missing objects, non-ancestor history, and unexpected drift", () => {
    const { root, taskId, base, subject } = prepareRepo("MIG-BLOCK");
    writeLegacyEvidence(root, taskId, base, subject, ["src/feature.ts", "docs/unexpected.md"]);
    const unexpected = evaluateEvidenceSubjectMigration(root, taskId);
    expect(unexpected.status).toBe("blocked");
    expect(unexpected.blockerCodes).toContain("changed-files.unexpected-drift");

    writeLegacyEvidence(root, taskId, "0".repeat(40), subject, ["src/feature.ts"]);
    expect(evaluateEvidenceSubjectMigration(root, taskId).blockerCodes).toContain("base.unavailable");

    writeLegacyEvidence(root, taskId, subject, base, ["src/feature.ts"]);
    expect(evaluateEvidenceSubjectMigration(root, taskId).blockerCodes).toContain("base.not-ancestor");
  });

  test("is read-only and emits a versioned JSON report", () => {
    const { root, taskId, base, subject } = prepareRepo("MIG-READONLY");
    writeLegacyEvidence(root, taskId, base, subject, ["docs/implementation.md", "src/feature.ts"]);
    const before = readFileSync(`${root}/contracts/evidence/${taskId}.yaml`, "utf8");
    const statusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });

    const output: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runEvidenceMigrateSubject(root, taskId, { json: true })).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(JSON.parse(output.join(""))).toMatchObject({ schemaVersion: "1.0.0", type: "scwbs.evidence-subject-migration.v1", status: "ready" });
    expect(readFileSync(`${root}/contracts/evidence/${taskId}.yaml`, "utf8")).toBe(before);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(statusBefore);
  });
});
