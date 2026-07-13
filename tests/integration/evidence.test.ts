import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildCollectedEvidence, runEvidenceCollect } from "../../src/commands/evidence-collect.js";
import { branchDiffHash, headCommit } from "../../src/core/git.js";
import { readEvidence } from "../../src/core/contracts.js";
import { buildCheckCacheKey, buildCheckCacheSubject } from "../../src/core/check-cache.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeJson, writeText, writeYaml } from "../helpers.js";

describe("evidence collect", () => {
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
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("2");

    writeJson(root, "package-lock.json", { lockfileVersion: 3, packages: { changed: true } });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("3");

    writeText(submoduleRoot, "version.txt", "two\n");
    execFileSync("git", ["add", "."], { cwd: submoduleRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "submodule update"], { cwd: submoduleRoot, stdio: "ignore" });
    execFileSync("git", ["fetch", submoduleRoot], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    execFileSync("git", ["checkout", "FETCH_HEAD"], { cwd: path.join(root, "vendor/dependency"), stdio: "ignore" });
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("4");

    writeText(root, "vendor/dependency/version.txt", "dirty content changed again\n");
    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("5");

    expect(runEvidenceCollect(root, "WBS-001-004", { baseRef: "base", force: true, rerunChecks: true })).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("6");
    expect(existsSync(marker)).toBe(true);
  }, 60000);

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
