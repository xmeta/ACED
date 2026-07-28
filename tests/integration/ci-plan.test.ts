import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildCiPlan, runCiPlan, taskAuthorityFingerprint } from "../../src/commands/ci-plan.js";
import { branchDiffHash, headCommit, mergeBase } from "../../src/core/git.js";
import { taskLifecycleMetadataPaths } from "../../src/core/managed-contract-paths.js";
import { makeTempRepo, sampleEvidence, sampleTask, writeScwbsProject, writeText, writeYaml } from "../helpers.js";

const taskId = "WBS-001-004";

function commit(root: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: root, stdio: "ignore" });
}

function prepareSubject(): { root: string; subject: string } {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, `contracts/tasks/${taskId}.yaml`, sampleTask({
    branchName: "task/WBS-001-004-ci-plan",
    allowedPaths: ["src/**"],
    forbiddenPaths: ["wjs/**"],
    humanGateRequiredPaths: [".github/**"],
    requiredChecks: ["test", "test:integration", "typecheck", "build"],
    managedContractPaths: [
      `contracts/tasks/${taskId}.yaml`,
      `contracts/evidence/${taskId}.yaml`,
      `contracts/evidence-payloads/${taskId}.patch`,
      `contracts/approvals/${taskId}.yaml`,
      `contracts/reviews/${taskId}.yaml`,
      "contracts/registry.yaml"
    ]
  }) as unknown as Record<string, unknown>);
  writeYaml(root, "contracts/check-coverage.yaml", {
    implementationRoots: ["src"],
    rules: [{
      id: "source-integration",
      classification: "behavior-critical",
      rationale: "Runtime source changes require integration coverage.",
      paths: ["src/**"],
      requires: ["test:integration"]
    }]
  });
  writeText(root, "src/existing.ts", "export const existing = true;\n");
  commit(root, "base");
  execFileSync("git", ["branch", "base"], { cwd: root });

  writeText(root, "src/feature.ts", "export const feature = 1;\n");
  commit(root, "implementation subject");
  return { root, subject: headCommit(root)! };
}

function commitEvidence(root: string, subject: string): void {
  const diffHash = branchDiffHash(root, "base", taskLifecycleMetadataPaths(taskId));
  writeYaml(root, `contracts/evidence/${taskId}.yaml`, sampleEvidence({
    id: `EVD-${taskId}`,
    taskId,
    commit: subject,
    subjectHeadCommit: subject,
    diffHash,
    changedFiles: ["src/feature.ts"],
    git: {
      branch: "task/WBS-001-004-ci-plan",
      base: "base",
      baseCommit: mergeBase(root, "base")!,
      changedFilesBasis: "branch-diff",
      subjectHeadCommit: subject,
      diffHash,
      headCommit: subject
    },
    checks: [
      { name: "test", status: "passed" },
      { name: "test:integration", status: "passed" },
      { name: "typecheck", status: "passed" },
      { name: "build", status: "passed" }
    ]
  }) as unknown as Record<string, unknown>);
  writeText(root, `contracts/evidence-payloads/${taskId}.patch`, "tracked patch metadata\n");
  commit(root, "evidence metadata");
}

describe("CI plan", () => {
  test("selects a metadata candidate only for a verified implementation descendant", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);

    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan).toMatchObject({
      schemaVersion: "1.0.0",
      decision: "metadata-candidate",
      taskId,
      subjectHeadCommit: subject,
      metadataAncestry: [{
        sha: expect.any(String),
        changedFiles: [`contracts/evidence-payloads/${taskId}.patch`, `contracts/evidence/${taskId}.yaml`]
      }],
      changedFilesSinceSubject: [`contracts/evidence-payloads/${taskId}.patch`, `contracts/evidence/${taskId}.yaml`],
      reasons: [{ code: "provenance.metadataOnly" }]
    });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/ci-plan.schema.json"), "utf8"));
    const classificationSchema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/task-classification.schema.json"), "utf8"));
    const ajv = new Ajv2020({ strict: false });
    ajv.addSchema(classificationSchema);
    expect(ajv.compile(schema)(plan)).toBe(true);
    expect(plan.classification).toMatchObject({ status: "classified", executionClass: "standard", enforcement: "read-only" });
    expect(plan.authorityFingerprint).toBe(taskAuthorityFingerprint(sampleTask({
      branchName: "task/WBS-001-004-ci-plan",
      allowedPaths: ["src/**"],
      forbiddenPaths: ["wjs/**"],
      humanGateRequiredPaths: [".github/**"],
      requiredChecks: ["test", "test:integration", "typecheck", "build"],
      managedContractPaths: [
        `contracts/tasks/${taskId}.yaml`,
        `contracts/evidence/${taskId}.yaml`,
        `contracts/evidence-payloads/${taskId}.patch`,
        `contracts/approvals/${taskId}.yaml`,
        `contracts/reviews/${taskId}.yaml`,
        "contracts/registry.yaml"
      ]
    })));
  });

  test("lists newest metadata-only descendants when the subject was not separately pushed", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);

    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.metadataAncestry).toHaveLength(1);
    expect(plan.metadataAncestry[0]).toMatchObject({
      sha: headCommit(root),
      changedFiles: [`contracts/evidence-payloads/${taskId}.patch`, `contracts/evidence/${taskId}.yaml`]
    });
    expect(plan.metadataAncestry.every((candidate) => candidate.sha !== subject)).toBe(true);
  });

  test("falls back to full CI when Evidence is absent at the implementation subject", () => {
    const { root } = prepareSubject();
    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.decision).toBe("full");
    expect(plan.reasons.map((item) => item.code)).toContain("schema.evidence.missing");
  });

  test("rejects implementation changes disguised as later metadata", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);
    writeText(root, "src/feature.ts", "export const feature = 2;\n");
    commit(root, "fake metadata with implementation change");

    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.decision).toBe("full");
    expect(plan.reasons.map((item) => item.code)).toEqual(expect.arrayContaining([
      "provenance.nonMetadataDescendant",
      "provenance.diffHash.mismatch"
    ]));
  });

  test("rejects Task authority changes even when Evidence provenance is rewritten", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);
    const taskPath = `contracts/tasks/${taskId}.yaml`;
    const current = readFileSync(path.join(root, taskPath), "utf8");
    writeText(root, taskPath, current.replace("  - src/**\n", "  - src/**\n  - secrets/**\n"));
    commit(root, "self widen task authority");

    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.decision).toBe("full");
    expect(plan.reasons.some((item) => item.code === "authority.diff.taskAuthority.change")).toBe(true);
  });

  test("rejects an unclassified implementation path", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);
    writeYaml(root, "contracts/check-coverage.yaml", {
      implementationRoots: ["src"],
      rules: [{
        id: "other-only",
        classification: "unit-only",
        rationale: "Only the named declaration is unit-only.",
        paths: ["src/other.ts"],
        requires: ["test"]
      }]
    });
    commit(root, "remove source classification");

    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.decision).toBe("full");
    expect(plan.reasons.some((item) => item.code.includes("checkCoverage.unclassified"))).toBe(true);
  });

  test("rejects malformed Approval metadata instead of trusting its path", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);
    writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
      id: `APR-${taskId}`,
      type: "approval",
      taskId,
      status: "approved"
    });
    commit(root, "malformed approval metadata");

    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.decision).toBe("full");
    expect(plan.reasons.some((item) => item.code.includes("approval.status"))).toBe(true);
  });

  test("fails closed when repository history is shallow", () => {
    const { root, subject } = prepareSubject();
    commitEvidence(root, subject);
    const parent = mkdtempSync(path.join(tmpdir(), "scwbs-shallow-"));
    const shallow = path.join(parent, "repo");
    execFileSync("git", ["clone", "--depth", "1", `file://${root}`, shallow], { stdio: "ignore" });

    const plan = buildCiPlan(shallow, { taskId, baseRef: "HEAD" });
    expect(plan.decision).toBe("full");
    expect(plan.reasons.some((item) => item.code === "git.shallow")).toBe(true);
    expect(plan.classification).toMatchObject({ executionClass: "high-risk" });
  });

  test("fails closed when an existing task has no branch-local bootstrap introduction", () => {
    const { root } = prepareSubject();
    const taskPath = `contracts/tasks/${taskId}.yaml`;
    const current = readFileSync(path.join(root, taskPath), "utf8");
    writeText(root, taskPath, current.replace("  - API tests pass\n", "  - API tests pass\n  - Classification is reported\n"));
    commit(root, "change existing task without branch-local introduction");
    const plan = buildCiPlan(root, { taskId, baseRef: "base" });
    expect(plan.classification.executionClass).toBe("high-risk");
    expect(plan.classification.reasons.map((item) => item.code)).toContain("classification.bootstrap.introduction.missing");
  });

  test("discovers the task by exact branch and emits fallback JSON with exit zero", () => {
    const { root } = prepareSubject();
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runCiPlan(root, { branch: "task/WBS-001-004-ci-plan", baseRef: "base", json: true })).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(chunks.join(""))).toMatchObject({ decision: "full", taskId });
  });

  test("workflow preserves aggregate validate and gates heavy jobs on the final plan", () => {
    const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/scwbs.yml"), "utf8");
    expect(workflow).toContain("Verify successful full CI for implementation subject");
    expect(workflow).toContain("npm run --silent scwbs -- ci plan");
    expect(workflow).toContain('$RUNNER_TEMP/ci-plan-candidate.json');
    expect(workflow).toContain('workflowRun?.path === ".github/workflows/scwbs.yml"');
    expect(workflow).toContain("workflowRun?.head_sha === process.env.SUBJECT");
    expect(workflow).toContain("metadataAncestry");
    expect(workflow).toContain("trustedCommit");
    expect(workflow).toContain("trustedWorkflowRunId");
    expect(workflow).toContain("trustedChecks");
    expect(workflow).toContain("trustedRanges");
    expect(workflow).toContain('"--name-only"');
    expect(workflow).toContain("ci.trustedCommit.diffHash.mismatch");
    expect(workflow).toContain('if: always() && needs.plan.outputs.mode == \'full\'');
    expect(workflow).toContain('if test "$MODE" = "metadata-fast-path"; then');
    expect(workflow).toContain('test "$CORE_RESULT" = "skipped"');
    expect(workflow).toContain('test "$CORE_RESULT" = "success"');
  });
});
