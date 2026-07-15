import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { buildCollectedEvidence, runEvidenceCollect } from "../../src/commands/evidence-collect.js";
import { runEvidenceAnnotate } from "../../src/commands/evidence-annotate.js";
import { branchDiffHash, headCommit } from "../../src/core/git.js";
import { readEvidence } from "../../src/core/contracts.js";
import { buildCheckCacheKey, buildCheckCacheSubject } from "../../src/core/check-cache.js";
import {
  acquireRequiredCheckRun,
  heartbeatScript,
  releaseRequiredCheckRun,
  requiredCheckChildEnv,
  requiredCheckLockPath,
  updateRequiredCheckRun
} from "../../src/core/required-check-run.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

function captureOutput(action: () => number): { result: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: action(), stdout: stdout.join(""), stderr: stderr.join("\n") };
  } finally {
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
}

function prepareEvidenceOutputRepo(): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "base"], { cwd: root });
  return root;
}

describe("evidence collect", () => {
  test("required checks are single-flight and expose active run details", () => {
    const root = prepareEvidenceOutputRepo();
    const marker = path.join(root, "duplicate-check-ran");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["test"] }) as unknown as Record<string, unknown>);
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure required check"], { cwd: root, stdio: "ignore" });
    const lease = acquireRequiredCheckRun(root, "WBS-001-004", 2);
    try {
      updateRequiredCheckRun(lease, "test:integration", 1);
      expect(() => acquireRequiredCheckRun(root, "WBS-001-005", 1)).toThrow(
        /required checks already active task=WBS-001-004 check=1\/2:test:integration pid=/
      );
      const duplicate = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true }));
      expect(duplicate.result).toBe(1);
      expect(duplicate.stderr).toContain("required checks already active task=WBS-001-004 check=1/2:test:integration");
      expect(existsSync(marker)).toBe(false);
    } finally {
      releaseRequiredCheckRun(lease);
    }
  });

  test("required-check single-flight safely recovers a stale PID lock", () => {
    const root = prepareEvidenceOutputRepo();
    const first = acquireRequiredCheckRun(root, "WBS-001-004", 1);
    writeText(root, path.relative(root, requiredCheckLockPath(root)), JSON.stringify({
      ...first.state,
      runId: "stale-run",
      pid: 999_999_999,
      startedAt: "2026-01-01T00:00:00.000Z"
    }));
    const recovered = acquireRequiredCheckRun(root, "WBS-001-005", 1);
    expect(recovered.state.taskId).toBe("WBS-001-005");
    releaseRequiredCheckRun(recovered);
  });

  test("required-check integration child inherits the existing repository lease", () => {
    const root = prepareEvidenceOutputRepo();
    const lease = acquireRequiredCheckRun(root, "WBS-001-004", 1);
    try {
      updateRequiredCheckRun(lease, "test:integration", 1);
      const helperUrl = pathToFileURL(path.resolve("scripts/integration-single-flight.mjs")).href;
      const script = [
        `import { acquireIntegrationRun, releaseIntegrationRun } from ${JSON.stringify(helperUrl)};`,
        `const lease = await acquireIntegrationRun(process.cwd(), { mode: "default", workers: 4, env: process.env });`,
        "process.stdout.write(JSON.stringify({ owned: lease.owned, runId: lease.runId, mode: lease.state.mode, workers: lease.state.workers }));",
        "releaseIntegrationRun(lease);"
      ].join("\n");
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        env: requiredCheckChildEnv(lease)
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ owned: false, runId: lease.state.runId, mode: "default", workers: 4 });
      expect(existsSync(lease.lockPath)).toBe(true);
    } finally {
      releaseRequiredCheckRun(lease);
    }
  });

  test("heartbeat emits bounded progress on stderr with active check metadata", () => {
    const result = spawnSync(process.execPath, ["-e", heartbeatScript()], {
      encoding: "utf8",
      timeout: 600,
      env: {
        ...process.env,
        SCWBS_HEARTBEAT_INTERVAL_MS: "40",
        SCWBS_CHECK_STARTED_MS: String(Date.now()),
        SCWBS_PARENT_PID: String(process.pid),
        SCWBS_TASK_ID: "WBS-001-004",
        SCWBS_CHECK_INDEX: "2",
        SCWBS_CHECK_TOTAL: "4",
        SCWBS_CHECK_NAME: "test:integration",
        SCWBS_RUN_STARTED_AT: "2026-07-14T00:00:00.000Z"
      }
    });
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.every((line) => line.length < 300)).toBe(true);
    expect(lines[0]).toContain("task=WBS-001-004 check=2/4:test:integration status=running");
    expect(lines[0]).toContain(`pid=${process.pid}`);
  });

  test("evidence collect defaults to a bounded success summary", () => {
    const root = prepareEvidenceOutputRepo();
    const output = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", { force: true, baseRef: "base" }));

    expect(output).toMatchObject({ result: 0, stderr: "" });
    expect(output.stdout.trim().split("\n")).toEqual([
      "PASS evidence collected",
      "path: contracts/evidence/WBS-001-004.yaml",
      "checks: 0 passed, 0 failed",
      "changedFiles: 0",
      "pullRequest: (not recorded)"
    ]);
    expect(output.stdout).not.toContain("id: EVD-");
  });

  test("evidence collect rejects dirty implementation files before required checks and reports JSON state", () => {
    const root = prepareEvidenceOutputRepo();
    const marker = path.join(root, "required-check-ran");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      requiredChecks: ["test"],
      allowedPaths: ["src/**"]
    }) as unknown as Record<string, unknown>);
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure check"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/uncommitted.ts", "export const unsafe = true;\n");

    const output = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", {
      force: true,
      baseRef: "base",
      json: true
    }));
    expect(output.result).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(output.stdout)).toMatchObject({
      schemaVersion: "1.0.0",
      status: "blocked",
      taskId: "WBS-001-004",
      workingTree: { untracked: ["src/uncommitted.ts"] },
      issues: [expect.objectContaining({ code: "diff.workingTree.untracked" })]
    });
  });

  test("evidence collect supports versioned JSON verbose and YAML-only output", () => {
    const root = prepareEvidenceOutputRepo();

    const jsonOutput = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", {
      force: true, baseRef: "base", pullRequest: "#42", json: true
    }));
    const json = JSON.parse(jsonOutput.stdout);
    expect(json).toEqual({
      schemaVersion: "1.0.0",
      status: "pass",
      taskId: "WBS-001-004",
      path: "contracts/evidence/WBS-001-004.yaml",
      checks: { total: 0, passed: 0, failed: 0 },
      changedFiles: 0,
      pullRequest: "#42"
    });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/evidence-collect-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(json)).toBe(true);

    const verbose = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", {
      force: true, baseRef: "base", verbose: true
    }));
    expect(verbose.stdout).toContain("PASS evidence collected");
    expect(verbose.stdout).toContain("id: EVD-WBS-001-004");
    expect(verbose.stdout.length).toBeGreaterThan(jsonOutput.stdout.length);

    const yaml = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", {
      force: true, baseRef: "base", output: "-"
    }));
    expect(yaml.stdout).toMatch(/^id: EVD-WBS-001-004/m);
    expect(yaml.stdout).not.toContain("PASS evidence collected");
  }, 30000);

  test("evidence collect records branch diff provenance from the requested base", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(evidence.git?.base).toBe("base");
    expect(evidence.git?.baseCommit).toBeTruthy();
    expect(evidence.git?.headCommit).toBe(headCommit(root));
    expect(evidence.subjectHeadCommit).toBe(headCommit(root));
    expect(evidence.git?.subjectHeadCommit).toBe(headCommit(root));
    expect(evidence.git?.changedFilesBasis).toBe("branch-diff");
    expect(evidence.diffHash).toBe(branchDiffHash(root, "base"));
    expect(evidence.git?.diffHash).toBe(branchDiffHash(root, "base"));
    expect(evidence.changedFiles).toContain("src/features/api/index.ts");
  });

  test("evidence diffHash is stable for the same subject diff", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });

    const first = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    const second = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(first.diffHash).toMatch(/^sha256:/);
    expect(first.diffHash).toBe(second.diffHash);
  });

  test("evidence subject stays stable across post-evidence metadata commits", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
    const subjectHead = headCommit(root);
    const first = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", first as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", { id: "APR-WBS-001-004", type: "approval", taskId: "WBS-001-004", status: "requested" });
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", { id: "RVW-WBS-001-004", type: "review", taskId: "WBS-001-004", status: "approved" });
    writeText(root, "contracts/registry.yaml", `${readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")}# metadata checkpoint\n`);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "record evidence metadata"], { cwd: root, stdio: "ignore" });

    const second = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(second).toMatchObject({
      commit: subjectHead,
      subjectHeadCommit: subjectHead,
      git: { subjectHeadCommit: subjectHead, headCommit: subjectHead }
    });
    expect(second.diffHash).toBe(first.diffHash);
    expect(second.changedFiles).toEqual(expect.arrayContaining([
      "contracts/evidence/WBS-001-004.yaml",
      "contracts/approvals/WBS-001-004.yaml",
      "contracts/reviews/WBS-001-004.yaml",
      "contracts/registry.yaml"
    ]));

    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", second as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "refresh evidence checkpoint"], { cwd: root, stdio: "ignore" });
    const fixedPoint = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(fixedPoint).toEqual(second);

    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "change implementation"], { cwd: root, stdio: "ignore" });
    const third = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(third.subjectHeadCommit).toBe(headCommit(root));
    expect(third.subjectHeadCommit).not.toBe(subjectHead);
    expect(third.diffHash).not.toBe(first.diffHash);
  }, 15000);

  test("evidence collect records explicit pull request metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base", pullRequest: "#42" });
    expect(evidence.git?.pullRequest).toBe("#42");
  });

  test("evidence collect preserves existing pull request metadata when refreshed", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        changedFiles: [],
        git: {
          branch: "feature",
          base: "base",
          baseCommit: "abc123",
          changedFilesBasis: "branch-diff",
          pullRequest: "#42",
          headCommit: "def456"
        }
      }) as unknown as Record<string, unknown>
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    const { evidence } = readEvidence(root, "WBS-001-004");
    expect(evidence?.git?.pullRequest).toBe("#42");
  });

  test("evidence collect records explicit test quality metadata", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    const evidence = buildCollectedEvidence(root, "WBS-001-004", {
      baseRef: "base",
      testQuality: {
        assertionsAdded: true,
        testsDisabled: false,
        coverageDecreased: false,
        notes: ["Added regression coverage."]
      }
    });
    expect(evidence.testQuality).toEqual({
      assertionsAdded: true,
      testsDisabled: false,
      coverageDecreased: false,
      notes: ["Added regression coverage."]
    });
  });

  test("evidence collect preserves existing test quality metadata when refreshed", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: [] }) as unknown as Record<string, unknown>);
    writeYaml(
      root,
      "contracts/evidence/WBS-001-004.yaml",
      sampleEvidence({
        testQuality: {
          assertionsAdded: true,
          testsDisabled: false,
          coverageDecreased: false,
          notes: ["Existing test quality rationale."]
        }
      }) as unknown as Record<string, unknown>
    );
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    const { evidence } = readEvidence(root, "WBS-001-004");
    expect(evidence?.testQuality).toEqual({
      assertionsAdded: true,
      testsDisabled: false,
      coverageDecreased: false,
      notes: ["Existing test quality rationale."]
    });
  });

  test("evidence annotate preserves subject provenance and checks", () => {
    const root = prepareEvidenceOutputRepo();
    const original = sampleEvidence({
      commit: "subject-commit",
      subjectHeadCommit: "subject-head",
      diffHash: "sha256:subject",
      git: {
        branch: "feature",
        base: "base",
        baseCommit: "base-commit",
        changedFilesBasis: "branch-diff",
        subjectHeadCommit: "subject-head",
        headCommit: "subject-head",
        diffHash: "sha256:subject"
      },
      checks: [{ name: "test", status: "passed", source: "local", command: "npm test", executedAt: "2026-07-14T00:00:00Z" }]
    });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", original as unknown as Record<string, unknown>);

    expect(runEvidenceAnnotate(root, "WBS-001-004", {
      pullRequest: "#42",
      testQuality: { assertionsAdded: true, testsDisabled: false, coverageDecreased: false, notes: ["Regression coverage"] }
    })).toBe(0);
    const { evidence } = readEvidence(root, "WBS-001-004");
    expect(evidence).toMatchObject({
      commit: original.commit,
      subjectHeadCommit: original.subjectHeadCommit,
      diffHash: original.diffHash,
      changedFiles: original.changedFiles,
      checks: original.checks,
      git: { ...original.git, pullRequest: "#42" },
      testQuality: { assertionsAdded: true, testsDisabled: false, coverageDecreased: false, notes: ["Regression coverage"] }
    });
  });

  test("evidence collect refuses to replace implementation provenance with an empty post-merge diff", () => {
    const root = prepareEvidenceOutputRepo();
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "feature",
      requiredChecks: []
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "contracts/tasks/WBS-001-004.yaml"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "set post-merge task branch"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "-f", "base", "HEAD"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      subjectHeadCommit: "previous-subject",
      diffHash: "sha256:previous",
      changedFiles: ["src/features/api/index.ts"],
      git: {
        branch: "feature",
        base: "base",
        baseCommit: "previous-base",
        changedFilesBasis: "branch-diff",
        subjectHeadCommit: "previous-subject",
        headCommit: "previous-subject",
        diffHash: "sha256:previous",
        pullRequest: "#42"
      }
    }) as unknown as Record<string, unknown>);

    const output = captureOutput(() => runEvidenceCollect(root, "WBS-001-004", { force: true, baseRef: "base" }));
    expect(output.result).toBe(1);
    expect(output.stderr).toContain("Refusing to replace WBS-001-004 implementation provenance with an empty diff");
    expect(readEvidence(root, "WBS-001-004").evidence?.diffHash).toBe("sha256:previous");
  });

  test("evidence collect records bounded diagnostics for failed checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.log('stdout ' + 'x'.repeat(1200)); console.error('stderr failure'); process.exit(7)\""
      }
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["test"] }) as unknown as Record<string, unknown>);

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    const check = evidence.checks[0];
    expect(check).toMatchObject({
      name: "test",
      status: "failed",
      command: "npm test",
      exitStatus: 7
    });
    expect(check?.stdoutSummary).toContain("[truncated]");
    expect(check?.stdoutSummary?.length).toBeLessThanOrEqual(1000);
    expect(check?.stderrSummary).toContain("stderr failure");
  }, 30000);

  test("evidence collect preserves passed-check evidence shape", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.log('ok')\""
      }
    });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["test"] }) as unknown as Record<string, unknown>);

    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    const check = evidence.checks[0];
    expect(check).toMatchObject({
      name: "test",
      status: "passed",
      command: "npm test"
    });
    expect(check).not.toHaveProperty("exitStatus");
    expect(check).not.toHaveProperty("stdoutSummary");
    expect(check).not.toHaveProperty("stderrSummary");
  }, 30000);

  test("resolved check command is part of the cache key", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    const subject = buildCheckCacheSubject(root, { baseRef: "base", excludedMetadataFiles: [] });

    expect(buildCheckCacheKey(subject, "test", ["npm", "test"]))
      .not.toBe(buildCheckCacheKey(subject, "test", ["npm", "run", "test"]));
  });

  test("reuses a passed check only while its complete cache subject is unchanged", () => {
    const root = makeTempRepo();
    const submoduleRoot = makeTempRepo();
    const marker = path.join(path.dirname(root), `${path.basename(root)}-check-count`);
    writeText(submoduleRoot, "version.txt", "one\n");
    execFileSync("git", ["add", "."], { cwd: submoduleRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "submodule base"], { cwd: submoduleRoot, stdio: "ignore" });
    writeScwbsProject(root);
    writeJson(root, "package.json", {
      scripts: {
        test: `node -e 'const fs=require("fs");const p=${JSON.stringify(marker)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1))'`
      }
    });
    writeJson(root, "package-lock.json", { lockfileVersion: 3 });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["test"] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", submoduleRoot, "vendor/dependency"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });
    writeText(root, "src/features/api/index.ts", "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    const first = readEvidence(root, "WBS-001-004").evidence?.checks[0];
    expect(first?.cacheKey).toMatch(/^sha256:/);
    expect(readFileSync(marker, "utf8")).toBe("1");

    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004", type: "approval", taskId: "WBS-001-004", status: "requested"
    });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readEvidence(root, "WBS-001-004").evidence?.checks[0]?.executedAt).toBe(first?.executedAt);
    expect(readFileSync(marker, "utf8")).toBe("1");

    writeText(root, "src/features/api/index.ts", "export const value = 2;\n");
    execFileSync("git", ["add", "src/features/api/index.ts"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "change implementation"], { cwd: root, stdio: "ignore" });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("2");

    writeJson(root, "package-lock.json", { lockfileVersion: 3, packages: { changed: true } });
    execFileSync("git", ["add", "package-lock.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "change dependency lock"], { cwd: root, stdio: "ignore" });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("3");

    writeText(submoduleRoot, "version.txt", "two\n");
    execFileSync("git", ["add", "."], { cwd: submoduleRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "submodule update"], { cwd: submoduleRoot, stdio: "ignore" });
    execFileSync("git", ["fetch", submoduleRoot], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["checkout", "FETCH_HEAD"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["add", "vendor/dependency"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "update submodule"], { cwd: root, stdio: "ignore" });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("4");

    writeText(root, "vendor/dependency/version.txt", "dirty content changed again\n");
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe("4");

    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["add", "version.txt"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "commit nested change"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["add", "vendor/dependency"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "record nested change"], { cwd: root, stdio: "ignore" });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("5");

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true, rerunChecks: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("6");
    expect(existsSync(marker)).toBe(true);
  }, 120000);

  test("evidence collect records nested submodule provenance and dependent PR metadata", () => {
    const root = makeTempRepo();
    const upstream = makeTempRepo();
    writeText(upstream, "version.txt", "one\n");
    execFileSync("git", ["add", "."], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "submodule base"], { cwd: upstream, stdio: "ignore" });
    writeScwbsProject(root);
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      requiredChecks: [],
      allowedPaths: ["vendor/dependency", "vendor/dependency/version.txt"],
      submoduleDependencies: [{
        path: "vendor/dependency",
        repository: upstream,
        pullRequest: "#4",
        upstreamRef: "refs/remotes/origin/master",
        checks: [{ name: "upstream-ci", status: "passed", url: "https://example.test/check/4" }]
      }]
    }) as unknown as Record<string, unknown>);
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", upstream, "vendor/dependency"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: upstream, stdio: "ignore" });
    writeText(upstream, "version.txt", "two\n");
    execFileSync("git", ["add", "."], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "submodule update"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["fetch", "origin"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["checkout", "origin/feature"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["add", "vendor/dependency"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "update gitlink"], { cwd: root, stdio: "ignore" });

    const featureEvidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(featureEvidence.submodules?.[0]?.upstreamReachable).toBe(false);

    execFileSync("git", ["checkout", "master"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["merge", "--ff-only", "feature"], { cwd: upstream, stdio: "ignore" });
    execFileSync("git", ["fetch", "origin", "master"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    const evidence = buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" });
    expect(evidence.changedFiles).toContain("vendor/dependency");
    expect(evidence.submodules).toHaveLength(1);
    expect(evidence.submodules?.[0]).toMatchObject({
      path: "vendor/dependency",
      repository: upstream,
      changedFiles: ["version.txt"],
      pullRequest: "#4",
      upstreamRef: "refs/remotes/origin/master",
      upstreamReachable: true,
      checks: [{ name: "upstream-ci", status: "passed", url: "https://example.test/check/4" }]
    });
    expect(evidence.submodules?.[0]?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.submodules?.[0]?.headCommit).toMatch(/^[0-9a-f]{40}$/);

    execFileSync("git", ["submodule", "deinit", "-f", "vendor/dependency"], { cwd: root, stdio: "ignore" });
    rmSync(path.join(root, ".git/modules/vendor/dependency"), { recursive: true, force: true });
    expect(() => buildCollectedEvidence(root, "WBS-001-004", { baseRef: "base" })).toThrow("Unable to collect nested changed files");
  }, 60000);

  test("a failed collection reuses passed checks and reruns failed checks", () => {
    const root = makeTempRepo();
    const passedMarker = path.join(path.dirname(root), `${path.basename(root)}-passed-count`);
    const failedMarker = path.join(path.dirname(root), `${path.basename(root)}-failed-count`);
    const counter = (marker: string, exitCode: number) =>
      `node -e 'const fs=require("fs");const p=${JSON.stringify(marker)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1));process.exit(${exitCode})'`;
    writeScwbsProject(root);
    writeJson(root, "package.json", { scripts: { pass: counter(passedMarker, 0), fail: counter(failedMarker, 1) } });
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({ requiredChecks: ["pass", "fail"] }) as unknown as Record<string, unknown>);
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["branch", "base"], { cwd: root });

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(passedMarker, "utf8")).toBe("1");
    expect(readFileSync(failedMarker, "utf8")).toBe("2");
  }, 30000);
});
