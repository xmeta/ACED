import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildHumanApprovalCommand,
  normalizePullRequestNumber,
  resolvePullRequestState,
  runFinish,
  writeFilesAtomically
} from "../../src/commands/finish.js";
import { makeTempRepo, sampleTask, sampleEvidence, writeScwbsProject, writeYaml, writeText, writeJson } from "../helpers.js";
import { buildRegistryYaml } from "../../src/commands/registry-rebuild.js";
import { runTaskLock } from "../../src/commands/task-lock.js";
import { readEvidence } from "../../src/core/contracts.js";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

function gitStatus(root: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
}

function captureFinishJson(root: string, options: Parameters<typeof runFinish>[1]): { exitCode: number; json: Record<string, unknown> } {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = runFinish(root, { ...options, json: true });
    return { exitCode, json: JSON.parse(output[output.length - 1]) };
  } finally {
    console.log = originalLog;
  }
}

function readBounded(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(0, 2_000);
  } catch {
    return "<missing>";
  }
}

async function waitForCommandStart(marker: string, lockPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readBounded(marker).split("\n").some((line) => line.startsWith("start "))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error([
    `first wrapper did not start the fake CLI within ${timeoutMs}ms`,
    `marker=${JSON.stringify(readBounded(marker))}`,
    `lock=${JSON.stringify(readBounded(lockPath))}`
  ].join("\n"));
}

function prepareFinishRepoWithHumanGate(): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: "master",
    allowedPaths: ["src/**", "contracts/**"],
    humanGateRequiredPaths: ["src/security/**"],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
  expect(runTaskLock(root, "WBS-001-004")).toBe(0);
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
  writeYaml(root, "contracts/registry.yaml", {
    projectId: "test-wbs",
    contracts: [
      {
        id: "EVD-WBS-001-004",
        type: "evidence",
        path: "contracts/evidence/WBS-001-004.yaml",
        relatedTask: "WBS-001-004"
      },
      {
        id: "SPEC-F001-API",
        type: "spec",
        path: "contracts/specs/SPEC-F001-API.yaml",
        status: "approved",
        version: "1.0.0",
        featureId: "F001"
      },
      {
        id: "TASK-WBS-001-004",
        type: "task",
        path: "contracts/tasks/WBS-001-004.yaml",
        featureId: "F001"
      }
    ]
  });
  return root;
}

function prepareFinishRepo(requestedApproval = false): string {
  const root = makeTempRepo();
  writeScwbsProject(root);
  writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
    branchName: "master",
    allowedPaths: ["src/**", "contracts/**"],
    humanGateRequiredPaths: [],
    requiredChecks: ["test"]
  }) as unknown as Record<string, unknown>);
  expect(runTaskLock(root, "WBS-001-004")).toBe(0);
  writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(0)\"" } });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["branch", "base"], { cwd: root });
  writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
    git: { branch: "master", base: "base", changedFilesBasis: "branch-diff", pullRequest: "#42" }
  }) as unknown as Record<string, unknown>);
  if (requestedApproval) {
    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004",
      type: "approval",
      taskId: "WBS-001-004",
      status: "requested"
    });
  }
  writeYaml(root, "contracts/registry.yaml", {
    projectId: "test-wbs",
    contracts: [
      ...(requestedApproval ? [{
        id: "APR-WBS-001-004",
        type: "approval",
        path: "contracts/approvals/WBS-001-004.yaml",
        status: "requested",
        relatedTask: "WBS-001-004"
      }] : []),
      {
        id: "EVD-WBS-001-004",
        type: "evidence",
        path: "contracts/evidence/WBS-001-004.yaml",
        relatedTask: "WBS-001-004"
      },
      {
        id: "SPEC-F001-API",
        type: "spec",
        path: "contracts/specs/SPEC-F001-API.yaml",
        status: "approved",
        version: "1.0.0",
        featureId: "F001"
      },
      {
        id: "TASK-WBS-001-004",
        type: "task",
        path: "contracts/tasks/WBS-001-004.yaml",
        featureId: "F001"
      }
    ]
  });
  writeText(root, "src/feature.ts", "export const value = 1;\n");
  execFileSync("git", ["add", "src/feature.ts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: root, stdio: "ignore" });
  return root;
}

describe("finish", () => {
  test("pull request state resolver classifies gh statusCheckRollup and degrades safely", () => {
    expect(normalizePullRequestNumber("#42")).toBe(42);
    expect(normalizePullRequestNumber("https://github.com/xmeta/ACED/pull/42")).toBe(42);
    expect(normalizePullRequestNumber("not-a-pr")).toBeUndefined();

    const root = makeTempRepo();
    const bin = path.join(root, "bin");
    const gh = path.join(bin, "gh");
    writeText(root, "bin/gh", [
      "#!/usr/bin/env node",
      "const scenario = process.env.SCWBS_TEST_PR_STATE;",
      "if (scenario === 'unavailable') process.exit(1);",
      "const views = {",
      "  draft: { isDraft: true, state: 'OPEN', statusCheckRollup: [] },",
      "  pending: { isDraft: false, state: 'OPEN', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] },",
      "  failure: { isDraft: false, state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] },",
      "  success: { isDraft: false, state: 'OPEN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] },",
      "  'closed-success': { isDraft: false, state: 'CLOSED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },",
      "  'closed-empty': { isDraft: false, state: 'CLOSED', statusCheckRollup: [] },",
      "  merged: { isDraft: false, state: 'MERGED', statusCheckRollup: [] }",
      "};",
      "process.stdout.write(JSON.stringify(views[scenario]));"
    ].join("\n"));
    chmodSync(gh, 0o755);
    const previousPath = process.env.PATH;
    const previousScenario = process.env.SCWBS_TEST_PR_STATE;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      for (const [scenario, expected] of [
        ["draft", "draft"],
        ["pending", "checks-pending"],
        ["failure", "checks-failure"],
        ["success", "checks-success"],
        ["closed-success", "closed"],
        ["closed-empty", "closed"],
        ["merged", "merged"],
        ["unavailable", "unavailable"]
      ] as const) {
        process.env.SCWBS_TEST_PR_STATE = scenario;
        expect(resolvePullRequestState(root, 42)).toBe(expected);
      }
    } finally {
      process.env.PATH = previousPath;
      if (previousScenario === undefined) delete process.env.SCWBS_TEST_PR_STATE;
      else process.env.SCWBS_TEST_PR_STATE = previousScenario;
    }
  });

  test("scwbs wrapper serializes the shared build and CLI lifecycle", async () => {
    const root = makeTempRepo();
    const marker = path.join(root, "command-order.log");
    const wrapper = path.join(root, "scripts", "scwbs-run.mjs");
    const fakeCli = path.join(root, "fake-cli.mjs");
    writeText(root, "scripts/scwbs-run.mjs", readFileSync(path.join(process.cwd(), "scripts/scwbs-run.mjs"), "utf8"));
    writeText(root, "fake-cli.mjs", [
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "const marker = process.env.SCWBS_TEST_MARKER;",
      "const lockPath = process.env.SCWBS_COMMAND_LOCK_PATH;",
      "const state = JSON.parse(readFileSync(lockPath, 'utf8'));",
      "writeFileSync(lockPath, JSON.stringify({ ...state, taskId: 'WBS-001-004', check: 'test:integration', checkIndex: 1, checkTotal: 1, checkStartedAt: new Date().toISOString() }));",
      "appendFileSync(marker, 'start ' + process.pid + '\\n');",
      "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);",
      "appendFileSync(marker, 'end ' + process.pid + '\\n');"
    ].join("\n"));

    const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [wrapper, "status"], {
        cwd: root,
        env: {
          ...process.env,
          SCWBS_SKIP_BUILD_FOR_TESTS: "1",
          SCWBS_CLI_ENTRY_FOR_TESTS: fakeCli,
          SCWBS_TEST_MARKER: marker
        }
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (code) => resolve({ code, stderr }));
    });

    const first = run();
    await waitForCommandStart(marker, path.join(root, ".git", "scwbs-command.lock"));
    const second = run();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.some((result) => result.stderr.includes("scwbs waiting for active command pid="))).toBe(true);
    expect(results.some((result) => result.stderr.includes("check=1/1:test:integration"))).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split("\n").map((line) => line.split(" ")[0]))
      .toEqual(["start", "end", "start", "end"]);
  }, 15000);

  test("scwbs wrapper recovers a stale command lock", () => {
    const root = makeTempRepo();
    const wrapper = path.join(root, "scripts", "scwbs-run.mjs");
    const fakeCli = path.join(root, "fake-cli.mjs");
    const marker = path.join(root, "stale-recovered.txt");
    const lockPath = path.join(root, ".git", "scwbs-command.lock");
    writeText(root, "scripts/scwbs-run.mjs", readFileSync(path.join(process.cwd(), "scripts/scwbs-run.mjs"), "utf8"));
    writeText(root, "fake-cli.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.SCWBS_TEST_MARKER, 'recovered');\n");
    writeText(root, ".git/scwbs-command.lock", JSON.stringify({
      runId: "stale",
      pid: 999_999_999,
      command: "scwbs finish",
      startedAt: "2026-01-01T00:00:00.000Z",
      phase: "cli"
    }));

    execFileSync(process.execPath, [wrapper, "status"], {
      cwd: root,
      env: {
        ...process.env,
        SCWBS_SKIP_BUILD_FOR_TESTS: "1",
        SCWBS_CLI_ENTRY_FOR_TESTS: fakeCli,
        SCWBS_TEST_MARKER: marker
      }
    });
    expect(readFileSync(marker, "utf8")).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  }, 15000);

  test("finish --json outputs summary JSON with all required fields", () => {
    const root = prepareFinishRepo(true);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, {
        taskId: "WBS-001-004",
        baseRef: "base",
        json: true,
        pullRequestStateResolver: () => "checks-pending"
      })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const json = JSON.parse(output[output.length - 1]);
    expect(json).toMatchObject({
      schemaVersion: "1.0.0",
      status: "pass",
      phase: "complete",
      outcome: "completed",
      taskId: "WBS-001-004",
      requiresHumanApproval: expect.any(Boolean),
      changedFiles: expect.any(Array),
      violations: expect.any(Array),
      requiredChecks: expect.any(Array),
      evidencePath: expect.any(String),
      approvalStatus: expect.any(String),
      nextAction: "gh pr checks 42 --watch",
      resumeCommand: "gh pr checks 42 --watch",
      mutatedFiles: expect.any(Array),
      readinessWarnings: [],
      fixCommands: []
    });
    const schema = JSON.parse(readFileSync(path.join(process.cwd(), "docs/scwbs/schemas/finish-summary.schema.json"), "utf8"));
    expect(new Ajv2020({ strict: false }).compile(schema)(json)).toBe(true);
  }, 30000);

  test("finish creates a pull request only when pull request metadata is missing", () => {
    const root = prepareFinishRepo();
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "master", base: "base", changedFilesBasis: "branch-diff" }
    }) as unknown as Record<string, unknown>);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", json: true })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const json = JSON.parse(output[output.length - 1]);
    expect(json).toMatchObject({
      schemaVersion: "1.0.0",
      status: "pass",
      nextAction: `gh pr create --base main --title "feat: WBS-001-004" --body ""`,
      resumeCommand: `gh pr create --base main --title "feat: WBS-001-004" --body ""`,
      readinessWarnings: []
    });
    expect(json.fixCommands).toEqual([]);
  }, 30000);

  test.each([
    ["draft", "gh pr ready 42"],
    ["checks-pending", "gh pr checks 42 --watch"],
    ["checks-failure", "gh pr checks 42"],
    ["checks-success", "npm run scwbs -- merge --pr 42"],
    ["closed", "gh pr reopen 42"],
    ["merged", "git switch main && git pull --ff-only origin main"],
    ["unavailable", "gh pr checks 42 --watch"]
  ] as const)("finish maps PR state %s to the existing PR next action", (state, expected) => {
    const root = prepareFinishRepo(true);
    const result = captureFinishJson(root, {
      taskId: "WBS-001-004",
      baseRef: "base",
      pullRequestStateResolver: () => state
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ nextAction: expected, resumeCommand: expected });
  }, 30000);

  test("finish uses Review PR metadata when Evidence PR metadata is absent", () => {
    const root = prepareFinishRepo(true);
    writeYaml(root, "contracts/evidence/WBS-001-004.yaml", sampleEvidence({
      git: { branch: "master", base: "base", changedFilesBasis: "branch-diff" }
    }) as unknown as Record<string, unknown>);
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "human-review",
      pullRequest: "#73",
      groundTruth: ["Task Contract", "Evidence"]
    });

    const result = captureFinishJson(root, {
      taskId: "WBS-001-004",
      baseRef: "base",
      pullRequestStateResolver: () => "checks-pending"
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ nextAction: "gh pr checks 73 --watch" });
  }, 30000);

  test("finish stops before required checks when Evidence and Review PR metadata mismatch", () => {
    const root = prepareFinishRepo(true);
    const marker = path.join(root, "mismatch-check-ran");
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure mismatch marker"], { cwd: root, stdio: "ignore" });
    writeYaml(root, "contracts/reviews/WBS-001-004.yaml", {
      id: "RVW-WBS-001-004",
      type: "review",
      taskId: "WBS-001-004",
      status: "requested",
      reviewProfile: "human-review",
      pullRequest: "#73",
      groundTruth: ["Task Contract", "Evidence"]
    });

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(result.json).toMatchObject({
      phase: "validation",
      outcome: "validation-failed",
      readinessWarnings: [{ code: "finish.pullRequest.metadata.mismatch" }]
    });
    expect(result.json.nextAction).toContain("review request --task WBS-001-004 --pull-request 42 --force");
  });

  test("plain and JSON finish output return the same PR next action", () => {
    const jsonRoot = prepareFinishRepo(true);
    const jsonResult = captureFinishJson(jsonRoot, {
      taskId: "WBS-001-004",
      baseRef: "base",
      pullRequestStateResolver: () => "closed"
    });
    const plainRoot = prepareFinishRepo(true);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runFinish(plainRoot, {
        taskId: "WBS-001-004",
        baseRef: "base",
        pullRequestStateResolver: () => "closed"
      })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(output).toContain(`  ${jsonResult.json.nextAction}`);
  }, 30000);

  test("finish rejects a missing contract lock before required checks", () => {
    const root = makeTempRepo();
    writeScwbsProject(root);
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(9)\"" } });
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", json: true })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(stderr.join("\n")).toContain("health.task.contractLock.missing");
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toContain("process.exit(9)");
  });

  test("finish rejects a dirty working tree before required checks and returns structured JSON", () => {
    const root = prepareFinishRepo();
    const marker = path.join(root, "dirty-check-ran");
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure marker check"], { cwd: root, stdio: "ignore" });
    writeText(root, "src/dirty.ts", "export const dirty = true;\n");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", json: true })).toBe(1);
    } finally {
      console.log = originalLog;
    }
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(output[output.length - 1])).toMatchObject({
      schemaVersion: "1.0.0",
      status: "blocked",
      taskId: "WBS-001-004",
      requiredChecks: [],
      workingTree: { untracked: ["src/dirty.ts"] },
      violations: [expect.objectContaining({ code: "diff.workingTree.untracked" })]
    });
  });

  test("finish does not request Human Approval when no Human Gate files changed", () => {
    const root = prepareFinishRepo(true);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, {
        taskId: "WBS-001-004",
        baseRef: "base",
        pullRequestStateResolver: () => "draft"
      })).toBe(0);
    } finally {
      console.log = originalLog;
    }

    const command = buildHumanApprovalCommand("WBS-001-004");
    expect(output).toContain("PASS registry synchronized");
    expect(output.join("\n")).not.toContain("id: EVD-WBS-001-004");
    expect(output).not.toContain(`  ${command}`);
    expect(output).toContain("  gh pr ready 42");
    expect(command).not.toContain("--approved-by");
    expect(command).not.toContain("--human-confirm");
  }, 30000);

  test("finish keeps failed check diagnostics while Evidence collection stays quiet", () => {
    const root = prepareFinishRepo();
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.log('bounded stdout detail'); console.error('failed test=tests/integration/finish.test.ts :: actionable failure'); console.error('cause=expected fixed point'); console.error('rerun=npx vitest run tests/integration/finish.test.ts -t actionable'); console.error('scwbs progress task=T check=1/1:test status=executed elapsed=1s pid=1 startedAt=now\\\\n'.repeat(100)); process.exit(7)\""
      }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure failing check"], { cwd: root, stdio: "ignore" });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWrite = process.stdout.write;
    console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.stdout.write = originalWrite;
    }

    expect(stdout.join("\n")).not.toContain("id: EVD-WBS-001-004");
    expect(stderr.join("\n")).toContain("Check failed: test (npm test)");
    expect(stderr.join("\n")).toContain("bounded stdout detail");
    expect(stderr.join("\n")).toContain("failed test=tests/integration/finish.test.ts :: actionable failure");
    expect(stderr.join("\n")).toContain("cause=expected fixed point");
    expect(stderr.join("\n")).toContain("rerun=npx vitest run tests/integration/finish.test.ts -t actionable");
  }, 30000);

  test("failed required checks preserve the previous Evidence and Registry checkpoint", () => {
    const root = prepareFinishRepo();
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const previousEvidence = readFileSync(evidenceFile, "utf8");
    const previousRegistry = readFileSync(registryFile, "utf8");
    writeJson(root, "package.json", {
      scripts: {
        test: "node -e \"console.error('failed test=tests/integration/json.test.ts :: json failure'); console.error('cause=timeout'); console.error('rerun=npx vitest run tests/integration/json.test.ts'); console.error('progress '.repeat(1000)); process.exit(9)\""
      }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure failed check"], { cwd: root, stdio: "ignore" });
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      phase: "required-checks",
      outcome: "required-check-failed",
      mutatedFiles: [],
      resumeCommand: "npm run scwbs -- finish --task WBS-001-004"
    });
    expect(JSON.stringify(result.json)).toContain("failed test=tests/integration/json.test.ts :: json failure");
    expect(JSON.stringify(result.json)).toContain("cause=timeout");
    expect(JSON.stringify(result.json)).toContain("rerun=npx vitest run tests/integration/json.test.ts");
    expect(readFileSync(evidenceFile, "utf8")).toBe(previousEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(previousRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  }, 30000);

  test("check-diff violations do not persist a candidate Evidence or partial Registry", () => {
    const root = prepareFinishRepo();
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const previousEvidence = readFileSync(evidenceFile, "utf8");
    writeYaml(root, "contracts/tasks/WBS-001-004.yaml", sampleTask({
      branchName: "master",
      allowedPaths: ["docs/**", "contracts/**"],
      humanGateRequiredPaths: [],
      requiredChecks: ["test"]
    }) as unknown as Record<string, unknown>);
    expect(runTaskLock(root, "WBS-001-004")).toBe(0);
    execFileSync("git", ["add", "contracts/tasks/WBS-001-004.yaml"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "restrict task scope"], { cwd: root, stdio: "ignore" });
    const previousRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ phase: "validation", outcome: "validation-failed", mutatedFiles: [] });
    expect(readFileSync(evidenceFile, "utf8")).toBe(previousEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(previousRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  }, 30000);

  test("finish --preflight is read-only and does not execute required checks", () => {
    const root = prepareFinishRepo();
    const marker = path.join(root, "preflight-check-ran");
    writeJson(root, "package.json", {
      scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` }
    });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure preflight marker"], { cwd: root, stdio: "ignore" });
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const beforeEvidence = readFileSync(evidenceFile, "utf8");
    const beforeRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base", preflight: true });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ phase: "preflight", outcome: "ready", mutatedFiles: [] });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(evidenceFile, "utf8")).toBe(beforeEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(beforeRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  });

  test("an interrupted Evidence and Registry checkpoint rolls both files back", () => {
    const root = prepareFinishRepo();
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    writeText(root, "contracts/registry.yaml", `${readFileSync(registryFile, "utf8")}# stale registry marker\n`);
    const beforeEvidence = readFileSync(evidenceFile, "utf8");
    const beforeRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, {
      taskId: "WBS-001-004",
      baseRef: "base",
      checkpointWriter: (files) => writeFilesAtomically(files, {
        beforeCommit: (index) => {
          if (index === 1) throw new Error("simulated interruption before registry replace");
        }
      })
    });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ phase: "checkpoint", outcome: "checkpoint-failed", mutatedFiles: [] });
    expect(readFileSync(evidenceFile, "utf8")).toBe(beforeEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(beforeRegistry);
    expect(gitStatus(root)).toBe(beforeStatus);
  }, 30000);

  test("the next finish recovers a checkpoint journal left by a simulated process crash", () => {
    const root = prepareFinishRepo();
    writeJson(root, "package.json", { scripts: { test: "node -e \"process.exit(8)\"" } });
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "configure post-crash failed check"], { cwd: root, stdio: "ignore" });
    const evidenceFile = path.join(root, "contracts/evidence/WBS-001-004.yaml");
    const registryFile = path.join(root, "contracts/registry.yaml");
    const previousEvidence = readFileSync(evidenceFile, "utf8");
    const previousRegistry = readFileSync(registryFile, "utf8");
    const commonDirValue = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    const commonDir = path.isAbsolute(commonDirValue) ? commonDirValue : path.resolve(root, commonDirValue);
    const journalFile = path.join(commonDir, "scwbs-finish-WBS-001-004.journal.json");
    writeText(root, path.relative(root, journalFile), `${JSON.stringify({
      schemaVersion: "1.0.0",
      files: [
        { path: evidenceFile, existed: true, previous: previousEvidence },
        { path: registryFile, existed: true, previous: previousRegistry }
      ]
    })}\n`);
    writeText(root, "contracts/evidence/WBS-001-004.yaml", "interrupted evidence\n");
    writeText(root, "contracts/registry.yaml", "interrupted registry\n");

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ phase: "required-checks", outcome: "required-check-failed", mutatedFiles: [] });
    expect(readFileSync(evidenceFile, "utf8")).toBe(previousEvidence);
    expect(readFileSync(registryFile, "utf8")).toBe(previousRegistry);
    expect(existsSync(journalFile)).toBe(false);
  }, 30000);

  test("a first finish creates Evidence and synchronizes registry before proposing PR creation", () => {
    const root = prepareFinishRepo();
    unlinkSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"));

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toBe(buildRegistryYaml(root));
    expect(readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8")).toContain("cacheKey: sha256:");
  }, 30000);

  test("finish displays diff hash and AI stop message when Human Gate files changed", () => {
    const root = prepareFinishRepoWithHumanGate();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message));
    };
    try {
      expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(1);
    } finally {
      console.log = originalLog;
    }

    const text = output.join("\n");
    expect(text).toContain("Human approval required.");
    expect(text).toContain("Changed human-gated paths:");
    expect(text).toContain("  - src/security/secret.ts");
    expect(text).toContain("Current diff hash:");
    expect(text).toContain("Next action for human reviewer:");
    expect(text).toContain(buildHumanApprovalCommand("WBS-001-004"));
    expect(text).toContain("AI agents must stop here.");
    expect(text).toContain("Do not approve this task yourself.");
  }, 30000);

  test.each([
    { name: "approved diffHash mismatch", status: "approved" as const, mismatch: "diffHash" as const, force: true },
    { name: "approved head mismatch", status: "approved" as const, mismatch: "headCommit" as const, force: true },
    { name: "rejected", status: "rejected" as const, mismatch: undefined, force: true },
    { name: "requested", status: "requested" as const, mismatch: undefined, force: false },
    { name: "missing", status: undefined, mismatch: undefined, force: false }
  ])("Human Gate recovery command handles $name Approval", ({ status, mismatch, force }) => {
    const root = prepareFinishRepoWithHumanGate();
    const taskId = "WBS-001-004";

    if (status === "approved") {
      expect(captureFinishJson(root, { taskId, baseRef: "base" }).exitCode).toBe(1);
      const evidence = readEvidence(root, taskId).evidence;
      expect(evidence).toBeDefined();
      const headCommit = evidence?.subjectHeadCommit ?? evidence?.git?.subjectHeadCommit ?? evidence?.commit;
      const diffHash = evidence?.diffHash ?? evidence?.git?.diffHash;
      expect(headCommit).toBeTruthy();
      expect(diffHash).toBeTruthy();
      writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
        id: `APR-${taskId}`,
        type: "approval",
        taskId,
        status,
        approvedBy: "human",
        approvedAt: "2026-07-17T00:00:00.000Z",
        headCommit: mismatch === "headCommit" ? "stale-head" : headCommit,
        diffHash: mismatch === "diffHash" ? "sha256:stale-diff" : diffHash
      });
    } else if (status) {
      writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
        id: `APR-${taskId}`,
        type: "approval",
        taskId,
        status
      });
    }

    const result = captureFinishJson(root, { taskId, baseRef: "base" });
    const command = buildHumanApprovalCommand(taskId, status);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      outcome: "awaiting-human-approval",
      approvalStatus: status ?? "",
      nextAction: command,
      resumeCommand: command,
      fixCommands: [command]
    });
    expect(command.includes("--force")).toBe(force);
  }, 30000);

  test("plain Human Gate output uses the same forced recovery command as JSON", () => {
    const root = prepareFinishRepoWithHumanGate();
    const taskId = "WBS-001-004";
    writeYaml(root, `contracts/approvals/${taskId}.yaml`, {
      id: `APR-${taskId}`,
      type: "approval",
      taskId,
      status: "rejected"
    });
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      expect(runFinish(root, { taskId, baseRef: "base" })).toBe(1);
    } finally {
      console.log = originalLog;
    }

    expect(output).toContain(`  ${buildHumanApprovalCommand(taskId, "rejected")}`);
  }, 30000);

  test("Human Gate waiting persists one synchronized checkpoint and reports how to resume", () => {
    const root = prepareFinishRepoWithHumanGate();
    const registryFile = path.join(root, "contracts/registry.yaml");
    writeText(root, "contracts/registry.yaml", `${readFileSync(registryFile, "utf8")}# stale registry marker\n`);
    const beforeEvidence = readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8");
    const beforeRegistry = readFileSync(registryFile, "utf8");
    const beforeStatus = gitStatus(root);

    const result = captureFinishJson(root, { taskId: "WBS-001-004", baseRef: "base" });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      phase: "checkpoint",
      outcome: "awaiting-human-approval",
      requiresHumanApproval: true,
      mutatedFiles: [
        "contracts/evidence-payloads/WBS-001-004.patch",
        "contracts/evidence/WBS-001-004.yaml",
        "contracts/registry.yaml"
      ],
      resumeCommand: buildHumanApprovalCommand("WBS-001-004")
    });
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toBe(buildRegistryYaml(root));
    expect(readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8")).not.toBe(beforeEvidence);
    expect(readFileSync(registryFile, "utf8")).not.toBe(beforeRegistry);
    const afterStatus = gitStatus(root);
    expect(afterStatus).toContain("?? contracts/evidence-payloads/");
    expect(afterStatus.replace("?? contracts/evidence-payloads/\n", "")).toBe(beforeStatus);
  }, 30000);

  test("finish synchronizes Approval status and can force valid checks to rerun", () => {
    const root = prepareFinishRepo(true);
    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    const firstExecutedAt = readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8").match(/executedAt: (.+)/)?.[1];

    writeYaml(root, "contracts/approvals/WBS-001-004.yaml", {
      id: "APR-WBS-001-004", type: "approval", taskId: "WBS-001-004", status: "approved"
    });
    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base" })).toBe(0);
    expect(readFileSync(path.join(root, "contracts/registry.yaml"), "utf8")).toContain("status: approved");
    expect(readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8")).toContain(`executedAt: ${firstExecutedAt}`);

    expect(runFinish(root, { taskId: "WBS-001-004", baseRef: "base", rerunChecks: true })).toBe(0);
    const rerunExecutedAt = readFileSync(path.join(root, "contracts/evidence/WBS-001-004.yaml"), "utf8").match(/executedAt: (.+)/)?.[1];
    expect(rerunExecutedAt).not.toBe(firstExecutedAt);
  }, 30000);
});
